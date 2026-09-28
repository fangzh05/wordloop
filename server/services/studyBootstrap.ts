import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { getTodayCompletedLessonWords } from "./attempts.js";
import type { StudyPhase, StudySessionRow, VocabularyItem } from "../types.js";
import { ensureTodayQueue } from "./dailyQueue.js";
import {
  filterDueCandidatesAfterCompletedSnapshot,
  getDueReviewSelection,
} from "./review.js";
import {
  freezeLessonQueueForSession,
  getActiveStudySession,
  normalizeLegacyLessonSession,
  normalizeStudyStateForRead,
  StaleStudyStateError,
} from "./studySessions.js";
import { getTodayWords, getVocabularyItemsByWords } from "./words.js";
import { buildLessonWords, lessonWordsFromFlow } from "./lessonQueue.js";
import { perf } from "./perf.js";
import { REVIEW_SESSION_MAX } from "../../shared/toolContracts.js";

export type StudyBootstrapResult =
  | { action: "resume"; widget: "pretest" | "lesson" | "dictation" | "review"; phase: StudyPhase }
  | { action: "review"; count: number }
  | { action: "pretest"; words: VocabularyItem[] }
  | { action: "lesson"; word: VocabularyItem; lesson_words?: string[] }
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
  const frozen = await freezeLessonQueueForSession(active, todayWords, db, userId, active.updated_at);
  return {
    active: frozen,
    word: await firstLessonWord(lessonWordsFromFlow(frozen.state?.flow ?? { relearn_words: [] }), db, userId),
  };
}

async function lessonAction(
  lessonWords: string[],
  db: ReturnType<typeof getDatabase>,
  userId: string,
  deferLessonQueueFreeze: boolean,
): Promise<StudyBootstrapResult> {
  const word = await firstLessonWord(lessonWords, db, userId);
  if (!word) return { action: "done" };
  return deferLessonQueueFreeze
    ? { action: "lesson", word, lesson_words: lessonWords }
    : { action: "lesson", word };
}

async function continueCompletedReview(
  active: NonNullable<Awaited<ReturnType<typeof getActiveStudySession>>>,
  deferLessonQueueFreeze: boolean,
): Promise<StudyBootstrapResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = active.state?.date;
  if (!date) return { action: "done" };

  // A Review snapshot is immutable while it is active. Once it is complete,
  // query strict FSRS due cards again so cards that became due during the
  // previous snapshot can form the next small Review snapshot.
  const newlyDue = await getDueReviewSelection(REVIEW_SESSION_MAX, db, userId);
  const eligibleDue = filterDueCandidatesAfterCompletedSnapshot(
    newlyDue.rollingReview,
    active.state?.payload.items,
  );
  if (eligibleDue.length > 0) {
    return { action: "review", count: eligibleDue.length };
  }

  const todayWords = await getTodayWords(date, db, userId);
  const newWords = todayWords.filter((word) => word.status === "new" && !word.mastered);
  if (newWords.length > 0) return { action: "pretest", words: newWords.slice(0, 6) };

  const existingLessonWords = lessonWordsFromFlow(active.state?.flow ?? { relearn_words: [] });
  if (existingLessonWords !== undefined) {
    return lessonAction(existingLessonWords, db, userId, deferLessonQueueFreeze);
  }

  if (deferLessonQueueFreeze) {
    const completedTodayLessonWords = await getTodayCompletedLessonWords(db, userId);
    const lessonWords = buildLessonWords(active.state?.flow?.relearn_words ?? [], todayWords, completedTodayLessonWords);
    return lessonAction(lessonWords, db, userId, true);
  }

  const frozen = await freezeAndReadFirstLessonWord(active, todayWords);
  return frozen.word ? { action: "lesson", word: frozen.word } : { action: "done" };
}

export async function continueCompletedPretest(
  active: NonNullable<Awaited<ReturnType<typeof getActiveStudySession>>>,
  deferLessonQueueFreeze = false,
): Promise<StudyBootstrapResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = active.state?.date;
  if (!date) return { action: "done" };

  const existingLessonWords = lessonWordsFromFlow(active.state?.flow ?? { relearn_words: [] });
  if (existingLessonWords !== undefined) {
    return lessonAction(existingLessonWords, db, userId, deferLessonQueueFreeze);
  }

  const todayWords = await getTodayWords(date, db, userId);
  if (deferLessonQueueFreeze) {
    const completedTodayLessonWords = await getTodayCompletedLessonWords(db, userId);
    const lessonWords = buildLessonWords(active.state?.flow?.relearn_words ?? [], todayWords, completedTodayLessonWords);
    const planned = await lessonAction(lessonWords, db, userId, true);
    if (planned.action === "lesson") return planned;
    const newWords = todayWords.filter((word) => word.status === "new" && !word.mastered);
    return newWords.length > 0 ? { action: "pretest", words: newWords.slice(0, 6) } : planned;
  }
  const frozen = await freezeAndReadFirstLessonWord(active, todayWords);
  if (frozen.word) return { action: "lesson", word: frozen.word };

  const newWords = todayWords.filter((word) => word.status === "new" && !word.mastered);
  return newWords.length > 0
    ? { action: "pretest", words: newWords.slice(0, 6) }
    : { action: "done" };
}

async function bootstrapFreshFlow(
  db: ReturnType<typeof getDatabase>,
  userId: string,
  deferLessonQueueFreeze: boolean,
): Promise<StudyBootstrapResult> {
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

  const completedTodayLessonWords = await getTodayCompletedLessonWords(db, userId);
  const lessonWords = buildLessonWords([], todayWords, completedTodayLessonWords);
  return lessonAction(lessonWords, db, userId, deferLessonQueueFreeze);
}

export async function getStudyBootstrap(options?: {
  activeSession: StudySessionRow | null;
  expectedRevision: string | null;
  deferLessonQueueFreeze?: boolean;
}): Promise<StudyBootstrapResult> {
  return perf("get_study_bootstrap", async () => {
    const db = getDatabase();
    const userId = getAuthenticatedUserId();

    const active = options ? options.activeSession : await getActiveStudySession(db, userId);
    if (options && (active?.updated_at ?? null) !== options.expectedRevision) {
      throw new StaleStudyStateError();
    }
    let normalizedActive = active?.state
      ? { ...active, state: normalizeStudyStateForRead(active.state) }
      : active;
    if (normalizedActive?.state?.widget === "lesson"
      && normalizedActive.state.flow?.lesson_words === undefined
      && ["lesson_explain", "lesson_exercise", "lesson_feedback"].includes(normalizedActive.state.phase)) {
      normalizedActive = await normalizeLegacyLessonSession(normalizedActive, db, userId);
    }
    if (normalizedActive?.state) {
      if (normalizedActive.state.widget === "lesson" && normalizedActive.state.phase === "lesson_complete") {
        // The vocabulary cursor is complete, but the active study session is
        // intentionally still open until the persisted long-sentence
        // wrap-up has been answered and graded. Returning resume lets the
        // Lesson Widget restore either the round handoff or its wrap-up card.
        return { action: "resume", widget: "lesson", phase: "lesson_complete" };
      }
      if (normalizedActive.state.widget === "review" && normalizedActive.state.phase === "review_complete") {
        return continueCompletedReview(normalizedActive, options?.deferLessonQueueFreeze ?? false);
      }
      if (normalizedActive.state.widget === "pretest" && normalizedActive.state.phase === "pretest_complete") {
        return continueCompletedPretest(normalizedActive, options?.deferLessonQueueFreeze ?? false);
      }
      return { action: "resume", widget: normalizedActive.state.widget, phase: normalizedActive.state.phase };
    }

    return bootstrapFreshFlow(db, userId, options?.deferLessonQueueFreeze ?? false);
  });
}
