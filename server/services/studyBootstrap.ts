import { getLearningBudget, newWordAdmissionLimit, type BudgetSnapshot } from "./learningBudget.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { getCompletedLessonWords } from "./attempts.js";
import type { StudyPhase, StudySessionRow, VocabularyItem } from "../types.js";
import { ensureTodayQueue } from "./dailyQueue.js";
import {
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
import {
  buildLessonWords,
  filterNewWordsWithoutLessonHistory,
  filterPreviouslyCompletedLessonWords,
  lessonWordsFromFlow,
} from "./lessonQueue.js";
import { perf } from "./perf.js";
import { REVIEW_SESSION_MAX } from "../../shared/toolContracts.js";

export type StudyBootstrapResult =
  | { action: "resume"; widget: "pretest" | "lesson" | "dictation" | "review"; phase: StudyPhase }
  | { action: "review"; count: number }
  | { action: "pretest"; words: VocabularyItem[]; date?: string }
  | { action: "lesson"; word: VocabularyItem; lesson_words?: string[]; date?: string }
  | { action: "done" }
  | { action: "budget_complete" };

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
  budget: BudgetSnapshot,
): Promise<StudyBootstrapResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = active.state?.flow.lesson_words !== undefined
    ? active.state.date : (await ensureTodayQueue(db, userId)).date;
  if (!date) return { action: "done" };

  const [todayWords, completedLessonWords] = await Promise.all([
    getTodayWords(date, db, userId),
    getCompletedLessonWords(db, userId),
  ]);
  const newWords = filterNewWordsWithoutLessonHistory(todayWords, completedLessonWords);
  const admitted = newWords.slice(0, newWordAdmissionLimit(budget));
  if (admitted.length > 0) return { action: "pretest", words: admitted, date };

  const existingLessonWords = lessonWordsFromFlow(active.state?.flow ?? { relearn_words: [] });
  if (existingLessonWords !== undefined) {
    const pendingLessonWords = filterPreviouslyCompletedLessonWords(
      existingLessonWords,
      completedLessonWords,
      active.state?.flow?.relearn_words ?? [],
    );
    if (pendingLessonWords.length > 0) {
      if (deferLessonQueueFreeze) return lessonAction(pendingLessonWords, db, userId, true);
      const frozen = await freezeAndReadFirstLessonWord(active, todayWords);
      return frozen.word ? { action: "lesson", word: frozen.word } : { action: "done" };
    }
  }

  if (deferLessonQueueFreeze) {
    const lessonWords = buildLessonWords(
      active.state?.flow?.relearn_words ?? [],
      todayWords,
      completedLessonWords,
      active.state?.flow?.pretest_familiar_words ?? [],
    );
    const planned = await lessonAction(lessonWords, db, userId, true);
    return planned.action === "lesson" ? { ...planned, date } : planned;
  }

  const handoff = active.state ? { ...active, state: { ...active.state, date } } : active;
  const frozen = await freezeAndReadFirstLessonWord(handoff, todayWords);
  return frozen.word ? { action: "lesson", word: frozen.word } : { action: "done" };
}

export async function continueCompletedPretest(
  active: NonNullable<Awaited<ReturnType<typeof getActiveStudySession>>>,
  deferLessonQueueFreeze = false,
  budget?: BudgetSnapshot,
): Promise<StudyBootstrapResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = active.state?.date;
  if (!date) return { action: "done" };

  const [todayWords, completedLessonWords] = await Promise.all([
    getTodayWords(date, db, userId),
    getCompletedLessonWords(db, userId),
  ]);
  const existingLessonWords = lessonWordsFromFlow(active.state?.flow ?? { relearn_words: [] });
  if (existingLessonWords !== undefined) {
    const pendingLessonWords = filterPreviouslyCompletedLessonWords(
      existingLessonWords,
      completedLessonWords,
      active.state?.flow?.relearn_words ?? [],
    );
    if (pendingLessonWords.length > 0) {
      if (deferLessonQueueFreeze) return lessonAction(pendingLessonWords, db, userId, true);
      const frozen = await freezeAndReadFirstLessonWord(active, todayWords);
      return frozen.word ? { action: "lesson", word: frozen.word } : { action: "done" };
    }
  }
  if (deferLessonQueueFreeze) {
    const lessonWords = buildLessonWords(
      active.state?.flow?.relearn_words ?? [],
      todayWords,
      completedLessonWords,
      active.state?.flow?.pretest_familiar_words ?? [],
    );
    const planned = await lessonAction(lessonWords, db, userId, true);
    if (planned.action === "lesson") return planned;
    const newWords = filterNewWordsWithoutLessonHistory(todayWords, completedLessonWords);
    const admitted = newWords.slice(0, newWordAdmissionLimit(budget ?? await getLearningBudget(db, userId)));
    return admitted.length > 0 ? { action: "pretest", words: admitted } : planned;
  }
  const frozen = await freezeAndReadFirstLessonWord(active, todayWords);
  if (frozen.word) return { action: "lesson", word: frozen.word };

  const newWords = filterNewWordsWithoutLessonHistory(todayWords, completedLessonWords);
  const admitted = newWords.slice(0, newWordAdmissionLimit(budget ?? await getLearningBudget(db, userId)));
  return admitted.length > 0
    ? { action: "pretest", words: admitted }
    : { action: "done" };
}

async function bootstrapFreshFlow(
  db: ReturnType<typeof getDatabase>,
  userId: string,
  deferLessonQueueFreeze: boolean,
  budget: BudgetSnapshot,
): Promise<StudyBootstrapResult> {
  const queue = await ensureTodayQueue(db, userId);

  const review = await getDueReviewSelection(REVIEW_SESSION_MAX, db, userId);
  if (review.rollingReview.length > 0) {
    return { action: "review", count: review.rollingReview.length };
  }

  const [todayWords, completedLessonWords] = await Promise.all([
    getTodayWords(queue.date, db, userId),
    getCompletedLessonWords(db, userId),
  ]);
  const newWords = filterNewWordsWithoutLessonHistory(todayWords, completedLessonWords);
  const admitted = newWords.slice(0, newWordAdmissionLimit(budget));
  if (admitted.length > 0) {
    return { action: "pretest", words: admitted };
  }

  const lessonWords = buildLessonWords([], todayWords, completedLessonWords);
  return lessonAction(lessonWords, db, userId, deferLessonQueueFreeze);
}

export async function getStudyBootstrap(options?: {
  activeSession: StudySessionRow | null;
  expectedRevision: string | null;
  deferLessonQueueFreeze?: boolean;
  startNewRound?: boolean;
}): Promise<StudyBootstrapResult> {
  return perf("get_study_bootstrap", async () => {
    const db = getDatabase();
    const userId = getAuthenticatedUserId();

    const active = options ? options.activeSession : await getActiveStudySession(db, userId);
    if (options && (active?.updated_at ?? null) !== options.expectedRevision) {
      throw new StaleStudyStateError();
    }
    const budget = await getLearningBudget(db, userId);
    if (options?.startNewRound === false && !active?.state) return { action: "done" };
    // Resume feedback and a question already on screen; never discard its draft.
    if (budget.enabled && budget.remaining_seconds < 8 && (!active?.state || ["review_complete", "pretest_complete"].includes(active.state.phase))) return { action: "budget_complete" };
    let normalizedActive = active?.state
      ? { ...active, state: normalizeStudyStateForRead(active.state) }
      : active;
    if (normalizedActive?.state?.widget === "lesson"
      && normalizedActive.state.flow?.lesson_words === undefined
      && ["lesson_explain", "lesson_exercise", "lesson_feedback"].includes(normalizedActive.state.phase)) {
      normalizedActive = await normalizeLegacyLessonSession(normalizedActive, db, userId);
    }
    if (normalizedActive?.state) {
      if (options?.startNewRound === false && ["review_complete", "pretest_complete"].includes(normalizedActive.state.phase)) {
        return { action: "resume", widget: normalizedActive.state.widget, phase: normalizedActive.state.phase };
      }
      if (normalizedActive.state.widget === "lesson" && normalizedActive.state.phase === "lesson_complete") {
        // The vocabulary cursor is complete, but the active study session stays
        // open until the backend cadence handoff is finished. Returning resume
        // restores either the primary feedback, its one consolidation, or the
        // final continue action without inferring cadence in bootstrap.
        return { action: "resume", widget: "lesson", phase: "lesson_complete" };
      }
      if (normalizedActive.state.widget === "review" && normalizedActive.state.phase === "review_complete") {
        return continueCompletedReview(normalizedActive, options?.deferLessonQueueFreeze ?? false, budget);
      }
      if (normalizedActive.state.widget === "pretest" && normalizedActive.state.phase === "pretest_complete") {
        return continueCompletedPretest(normalizedActive, options?.deferLessonQueueFreeze ?? false, budget);
      }
      return { action: "resume", widget: normalizedActive.state.widget, phase: normalizedActive.state.phase };
    }

    return bootstrapFreshFlow(db, userId, options?.deferLessonQueueFreeze ?? false, budget);
  });
}
