import {
  REVIEW_SESSION_MAX,
  lessonNavigationSchema,
  type LessonNavigation,
} from "../../shared/toolContracts.js";
import type { StudyFlow, VocabularyItem } from "../types.js";
import { normalizeWord } from "./wordNormalization.js";

const lessonStatuses = new Set(["unknown", "uncertain"]);

function appendWord(queue: string[], seen: Set<string>, word: string): void {
  const normalized = normalizeWord(word);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  queue.push(normalized);
}

export function dedupeLessonWords(words: readonly string[]): string[] {
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const word of words) appendWord(queue, seen, word);
  return queue.slice(0, REVIEW_SESSION_MAX);
}

/** Build the one-time Lesson snapshot from the session flow and daily order. */
export function buildLessonWords(
  relearnWords: readonly string[],
  todayWords: readonly VocabularyItem[],
): string[] {
  return dedupeLessonWords([
    ...relearnWords,
    ...todayWords
      .filter((word) => lessonStatuses.has(word.status) && !word.mastered)
      .map((word) => word.word),
  ]);
}

/**
 * Recover a legacy Lesson state that predates `flow.lesson_words`.
 * Attempts are the durable visited trajectory; still-unvisited snapshot
 * words are appended after it so a cursor such as `interpret` cannot hide
 * earlier re-learn words.
 */
export function recoverLegacyLessonWords(input: {
  relearnWords: readonly string[];
  todayWords: readonly VocabularyItem[];
  attemptWords: readonly string[];
  currentWord?: string | null;
}): string[] {
  const current = input.currentWord ? normalizeWord(input.currentWord) : "";
  const trajectory = dedupeLessonWords([
    ...input.attemptWords.filter((word) => normalizeWord(word) !== current),
    ...(current ? [current] : []),
  ]);
  const seen = new Set(trajectory.map(normalizeWord));
  const pending = buildLessonWords(input.relearnWords, input.todayWords)
    .filter((word) => !seen.has(normalizeWord(word)));
  return dedupeLessonWords([...trajectory, ...pending]);
}

export function lessonWordsFromFlow(flow: StudyFlow): string[] | undefined {
  return Array.isArray(flow.lesson_words) ? flow.lesson_words : undefined;
}

export function lessonWordIndex(lessonWords: readonly string[], word: string): number {
  const normalized = normalizeWord(word);
  return lessonWords.findIndex((entry) => normalizeWord(entry) === normalized);
}

export function lessonWordAt(lessonWords: readonly string[], index: number): string | null {
  return lessonWords[index] ?? null;
}

export function isLessonCursorAtCurrentWord(
  lessonWords: readonly string[],
  currentWord: string | null,
  currentIndex: number,
): boolean {
  const expected = lessonWordAt(lessonWords, currentIndex);
  return Boolean(currentWord && expected && normalizeWord(currentWord) === normalizeWord(expected));
}

export function nextLessonWordIndex(
  lessonWords: readonly string[],
  currentWord: string,
  currentIndex: number,
): number {
  if (!isLessonCursorAtCurrentWord(lessonWords, currentWord, currentIndex)) {
    throw new Error("LESSON_CURSOR_MISMATCH");
  }
  return currentIndex + 1;
}

/**
 * Derive the next Lesson action from the immutable session queue. This never
 * reads live word status or rebuilds the queue.
 */
export function buildLessonNavigation(
  lessonWords: readonly string[],
  currentIndex: number,
  currentWord: string,
): LessonNavigation {
  if (!Number.isInteger(currentIndex)
    || currentIndex < 0
    || currentIndex >= lessonWords.length
    || lessonWords[currentIndex] !== currentWord) {
    throw new Error("LESSON_CURSOR_MISMATCH");
  }

  const nextIndex = currentIndex + 1;
  return lessonNavigationSchema.parse(nextIndex < lessonWords.length
    ? {
      action: "next_word",
      next_word: lessonWords[nextIndex],
      next_index: nextIndex,
      total_count: lessonWords.length,
    }
    : {
      action: "round_complete",
      next_word: null,
      next_index: null,
      total_count: lessonWords.length,
    });
}
