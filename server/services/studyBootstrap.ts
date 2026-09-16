import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { VocabularyItem } from "../types.js";
import { ensureTodayQueue } from "./dailyQueue.js";
import {
  findFirstLearningWord,
  getDueReviewSelection,
} from "./review.js";
import {
  freezeLessonQueueForSession,
  getActiveStudySession,
  normalizeLegacyLessonSession,
  normalizeStudyStateForRead,
} from "./studySessions.js";
import { getTodayWords, getVocabularyItemsByWords } from "./words.js";
import { lessonWordsFromFlow } from "./lessonQueue.js";
import { perf } from "./perf.js";
import { REVIEW_SESSION_MAX } from "../../shared/toolContracts.js";

export type StudyBootstrapResult =
  | { action: "resume"; widget: "pretest" | "lesson" | "dictation" | "review" }
  | { action: "review"; count: number }
  | { action: "pretest"; words: VocabularyItem[] }
  | { action: "lesson"; word: VocabularyItem }
  | { action: "done" };

async function firstLessonWord(
  lessonWords: string[] | undefined,
  db: ReturnType<typeof getDatabase>,
  userId: string,
): Promise<VocabularyItem | null> {
  const first = lessonWords?.[0];
  if (!first) return null;
  const [item] = await getVocabularyItemsByWords([first], db, userId);
  if (!item) throw new Error("LESSON_WORD_NOT_FOUND");
  return item;
}

async function freezeAndReadFirstLessonWord(
  active: NonNullable<Awaited<ReturnType<typeof getActiveStudySession>>>,
  todayWords: VocabularyItem[],
): Promise<{ active: NonNullable<Awaited<ReturnType<typeof getActiveStudySession>>>; word: VocabularyItem | null }> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const frozen = await freezeLessonQueueForSession(active, todayWords, db, userId);
  return {
    active: frozen,
    word: await firstLessonWord(lessonWordsFromFlow(frozen.state?.flow ?? { relearn_words: [] }), db, userId),
  };
}

async function continueCompletedReview(active: NonNullable<Awaited<ReturnType<typeof getActiveStudySession>>>): Promise<StudyBootstrapResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = active.state?.date;
  if (!date) return { action: "done" };

  const existingLessonWords = lessonWordsFromFlow(active.state?.flow ?? { relearn_words: [] });
  if (existingLessonWords !== undefined) {
    const lessonWord = await firstLessonWord(existingLessonWords, db, userId);
    return lessonWord ? { action: "lesson", word: lessonWord } : { action: "done" };
  }

  const todayWords = await getTodayWords(date, db, userId);
  const newWords = todayWords.filter((word) => word.status === "new" && !word.mastered);
  if (newWords.length > 0) return { action: "pretest", words: newWords.slice(0, 6) };

  const frozen = await freezeAndReadFirstLessonWord(active, todayWords);
  return frozen.word ? { action: "lesson", word: frozen.word } : { action: "done" };
}

export async function continueCompletedPretest(active: NonNullable<Awaited<ReturnType<typeof getActiveStudySession>>>): Promise<StudyBootstrapResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = active.state?.date;
  if (!date) return { action: "done" };

  const existingLessonWords = lessonWordsFromFlow(active.state?.flow ?? { relearn_words: [] });
  if (existingLessonWords !== undefined) {
    const lessonWord = await firstLessonWord(existingLessonWords, db, userId);
    return lessonWord ? { action: "lesson", word: lessonWord } : { action: "done" };
  }

  const todayWords = await getTodayWords(date, db, userId);
  const frozen = await freezeAndReadFirstLessonWord(active, todayWords);
  if (frozen.word) return { action: "lesson", word: frozen.word };

  const newWords = todayWords.filter((word) => word.status === "new" && !word.mastered);
  return newWords.length > 0
    ? { action: "pretest", words: newWords.slice(0, 6) }
    : { action: "done" };
}

export async function getStudyBootstrap(): Promise<StudyBootstrapResult> {
  return perf("get_study_bootstrap", async () => {
    const db = getDatabase();
    const userId = getAuthenticatedUserId();

    const active = await getActiveStudySession(db, userId);
    let normalizedActive = active?.state
      ? { ...active, state: normalizeStudyStateForRead(active.state) }
      : active;
    if (normalizedActive?.state?.widget === "lesson"
      && normalizedActive.state.flow?.lesson_words === undefined
      && ["lesson_explain", "lesson_exercise", "lesson_feedback"].includes(normalizedActive.state.phase)) {
      normalizedActive = await normalizeLegacyLessonSession(normalizedActive, db, userId);
    }
    if (normalizedActive?.state) {
      if (normalizedActive.state.widget === "review" && normalizedActive.state.phase === "review_complete") {
        return continueCompletedReview(normalizedActive);
      }
      if (normalizedActive.state.widget === "pretest" && normalizedActive.state.phase === "pretest_complete") {
        return continueCompletedPretest(normalizedActive);
      }
      return { action: "resume", widget: normalizedActive.state.widget };
    }

    const queue = await ensureTodayQueue(db, userId);

    const review = await getDueReviewSelection(REVIEW_SESSION_MAX, db, userId);
    if (review.rollingReview.length > 0) {
      return { action: "review", count: review.rollingReview.length };
    }

    const todayWords = await getTodayWords(queue.date, db, userId);
    const newWords = todayWords.filter((word) => word.status === "new" && !word.mastered);
    if (newWords.length > 0) {
      return { action: "pretest", words: newWords.slice(0, 6) };
    }

    const lessonWord = findFirstLearningWord(todayWords);
    return lessonWord ? { action: "lesson", word: lessonWord } : { action: "done" };
  });
}
