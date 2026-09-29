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

/** New-status cards with any formal Lesson history are stale queue leftovers, not fresh Pretest candidates. */
export function filterNewWordsWithoutLessonHistory(
  todayWords: readonly VocabularyItem[],
  completedLessonWords: ReadonlySet<string> = new Set(),
): VocabularyItem[] {
  return todayWords.filter((word) => word.status === "new"
    && !word.mastered
    && !completedLessonWords.has(normalizeWord(word.word)));
}

export function filterPreviouslyCompletedLessonWords(
  words: readonly string[],
  completedLessonWords: ReadonlySet<string>,
  relearnWords: readonly string[] = [],
): string[] {
  const relearn = new Set(relearnWords.map(normalizeWord));
  const completed = new Set([...completedLessonWords].map(normalizeWord));
  return dedupeLessonWords(words.filter((word) => !completed.has(normalizeWord(word))
    || relearn.has(normalizeWord(word))));
}

/** Build the one-time Lesson snapshot from the session flow and daily order. */
export function buildLessonWords(
  relearnWords: readonly string[],
  todayWords: readonly VocabularyItem[],
  completedLessonWords: ReadonlySet<string> = new Set(),
  excludedWords: readonly string[] = [],
): string[] {
  const excluded = new Set(excludedWords.map(normalizeWord).filter(Boolean));
  return dedupeLessonWords([
    ...relearnWords.filter((word) => !excluded.has(normalizeWord(word))),
    ...todayWords
      .filter((word) => lessonStatuses.has(word.status)
        && !word.mastered
        && !completedLessonWords.has(normalizeWord(word.word))
        && !excluded.has(normalizeWord(word.word)))
      .map((word) => word.word),
  ]);
}

export interface LessonQueueCursorReconciliation {
  lessonWords: string[];
  currentIndex: number;
  currentWord: string;
  skippedCurrent: boolean;
  changed: boolean;
}

/**
 * Remove old completed Lesson words from an active queue's unvisited suffix.
 * The current card is kept unless the caller knows it has not been opened yet.
 * Explicit failed-Review relearn words always remain eligible.
 */
export function reconcileLessonQueueAfterCursor(input: {
  lessonWords: readonly string[];
  currentIndex: number;
  completedLessonWords: ReadonlySet<string>;
  relearnWords: readonly string[];
  skipCompletedCurrent?: boolean;
}): LessonQueueCursorReconciliation | null {
  const { lessonWords, currentIndex } = input;
  const currentWord = lessonWords[currentIndex];
  if (!currentWord || currentIndex < 0 || currentIndex >= lessonWords.length) return null;

  const completed = new Set([...input.completedLessonWords].map(normalizeWord));
  const relearn = new Set(input.relearnWords.map(normalizeWord));
  const wasCompleted = (word: string) => completed.has(normalizeWord(word)) && !relearn.has(normalizeWord(word));
  const skipCurrent = Boolean(input.skipCompletedCurrent && wasCompleted(currentWord));
  const prefix = lessonWords.slice(0, currentIndex);
  const suffix = lessonWords.slice(currentIndex + 1).filter((word) => !wasCompleted(word));

  if (skipCurrent && suffix.length > 0) {
    const nextWords = [...prefix, ...suffix];
    return {
      lessonWords: nextWords,
      currentIndex: prefix.length,
      currentWord: suffix[0]!,
      skippedCurrent: true,
      changed: true,
    };
  }

  const nextWords = [...prefix, currentWord, ...suffix];
  return {
    lessonWords: nextWords,
    currentIndex,
    currentWord,
    skippedCurrent: false,
    changed: nextWords.length !== lessonWords.length
      || nextWords.some((word, index) => word !== lessonWords[index]),
  };
}

export function lessonProgressLabel(relearnWords: readonly string[], queue: readonly string[], index: number): string {
  const relearn = new Set(relearnWords.map(normalizeWord));
  const reviewCount = queue.filter((word) => relearn.has(normalizeWord(word))).length;
  if (index < reviewCount) return `复习补学 ${index + 1} / ${reviewCount}`;
  const newCount = queue.length - reviewCount;
  return `新词学习 ${Math.min(index - reviewCount + 1, newCount)} / ${newCount}`;
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
  completedLessonWords?: ReadonlySet<string>;
  excludedWords?: readonly string[];
}): string[] {
  const current = input.currentWord ? normalizeWord(input.currentWord) : "";
  const trajectory = dedupeLessonWords([
    ...input.attemptWords.filter((word) => normalizeWord(word) !== current),
    ...(current ? [current] : []),
  ]);
  const seen = new Set(trajectory.map(normalizeWord));
  const pending = buildLessonWords(
    input.relearnWords,
    input.todayWords,
    input.completedLessonWords,
    input.excludedWords,
  )
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
