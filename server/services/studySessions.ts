import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { getCompletedLessonWords, LESSON_ACTIVITY_TYPES } from "./attempts.js";
import {
  REVIEW_SESSION_MAX,
  activeErrorLayerSchema,
  pretestMarkFamiliarSchema,
  reviewAnswerSchema,
  reviewWidgetItemSchema,
  lessonExercisePlanSchema,
  type PretestMarkFamiliarInput,
  type ExerciseScope,
  type LessonExercisePlan,
  type SkillEvidence,
  type ReviewAnswerInput,
} from "../../shared/toolContracts.js";
import type { StudyFlow, StudyPhase, StudySessionEvent, StudySessionRow, StudyState, StudyWidget, VocabularyItem } from "../types.js";
import { assertDatabaseResult, dateInTimeZone, localDateRange } from "./shared.js";
import { getTodayWords, getUserTimeZone, markPretestWordKnown } from "./words.js";
import { normalizeWord } from "./wordNormalization.js";
import {
  buildLessonWords,
  filterPreviouslyCompletedLessonWords,
  lessonWordIndex,
  recoverLegacyLessonWords,
} from "./lessonQueue.js";
import { decideLessonConsolidation } from "./lessonConsolidation.js";

const sessionColumns = "id,user_id,started_at,ended_at,new_words_count,review_words_count,state,updated_at";
const pretestItemsSchema = z.array(z.object({ word: z.string().trim().min(1).max(100) })).max(7);
const lessonExerciseSchema = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
  accepted_answers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});
const studyFlowSchema = z.object({
  relearn_words: z.array(z.string().trim().min(1).max(100)).max(REVIEW_SESSION_MAX),
  pretest_familiar_words: z.array(z.string().trim().min(1).max(100)).max(REVIEW_SESSION_MAX).default([]),
  lesson_words: z.array(z.string().trim().min(1).max(100)).max(REVIEW_SESSION_MAX).optional(),
  lesson_profile_history: z.array(z.object({
    word: z.string().trim().min(1).max(100),
    lesson_profile: z.enum(["quick_recall", "reinforce", "targeted_relearn"]),
    error_focus: activeErrorLayerSchema.nullable(),
  }).strict()).max(REVIEW_SESSION_MAX).optional(),
  exercise_plans: z.array(lessonExercisePlanSchema).max(REVIEW_SESSION_MAX).optional(),
}).strict().default({ relearn_words: [], pretest_familiar_words: [] });
const reviewSessionPayloadSchema = z.object({
  widget: z.literal("review"),
  items: z.array(reviewWidgetItemSchema).min(1).max(REVIEW_SESSION_MAX),
  title: z.string().trim().min(1).max(100).optional(),
}).strict();

export const studyStateSchema = z.object({
  version: z.literal(1),
  date: z.string().trim().min(1),
  widget: z.enum(["pretest", "lesson", "dictation", "review"]),
  phase: z.enum([
    "pretest", "pretest_result", "listen_repeat", "listen_recall",
    "pretest_complete",
    "lesson_explain", "lesson_exercise", "lesson_feedback", "lesson_complete", "dictation",
    "review", "review_complete",
  ]),
  current_word: z.string().trim().max(100).nullable(),
  current_index: z.number().int().min(0),
  retry_count: z.number().int().min(0),
  flow: studyFlowSchema,
  payload: z.record(z.string(), z.unknown()),
}).strict();

const OLD_SESSION_SCHEMA_MESSAGE = "WordLoop 数据库版本过旧，请先部署 migration 202609150004。";

export class StaleStudyStateError extends Error {
  constructor() {
    super("STALE_STUDY_STATE");
    this.name = "StaleStudyStateError";
  }
}

type DatabaseError = { code?: string; message: string };

export function isStudySessionSchemaMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<DatabaseError>;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const missingStateColumn = /(?:column\s+(?:(?:public\.)?study_sessions\.)?[\"']?state[\"']?|[\"']state[\"']\s+column)/i.test(message);
  const missingUpdatedAtColumn = /(?:column\s+(?:(?:public\.)?study_sessions\.)?[\"']?updated_at[\"']?|[\"']updated_at[\"']\s+column)/i.test(message);
  return (missingStateColumn || missingUpdatedAtColumn)
    && /study_sessions|schema cache|does not exist/i.test(message);
}

function assertStudySessionDatabaseResult(error: DatabaseError | null): void {
  if (!error) return;
  if (isStudySessionSchemaMismatch(error)) throw new Error(OLD_SESSION_SCHEMA_MESSAGE);
  assertDatabaseResult(error);
}

function isUniqueViolation(error: DatabaseError | null): boolean {
  return error?.code === "23505";
}

export type StudySessionDb = SupabaseClient;

function parseSession(data: unknown): StudySessionRow {
  const row = data as {
    id: string;
    user_id: string;
    started_at: string;
    ended_at: string | null;
    new_words_count: number;
    review_words_count: number;
    state: unknown;
    updated_at: string;
  };
  const parsedState = studyStateSchema.safeParse(row.state);
  return {
    id: row.id,
    user_id: row.user_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    new_words_count: row.new_words_count,
    review_words_count: row.review_words_count,
    state: parsedState.success ? normalizeStudyStateForRead(parsedState.data) : null,
    updated_at: row.updated_at,
  };
}

function assertState(state: StudyState): StudyState {
  const parsed = studyStateSchema.safeParse(state);
  if (!parsed.success) throw new Error("Invalid study session state.");
  return parsed.data;
}

function isFormalReviewItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reviewKind = (value as { review_kind?: unknown }).review_kind;
  return reviewKind === "fsrs_due" || reviewKind === "both";
}

function reviewSnapshotCount(state: StudyState | null | undefined): number {
  if (state?.widget !== "review" || !Array.isArray(state.payload.items)) return 0;
  return state.payload.items.filter(isFormalReviewItem).length;
}

function reviewSnapshotWords(state: StudyState | null | undefined): string[] {
  if (state?.widget !== "review" || !Array.isArray(state.payload.items)) return [];
  return state.payload.items.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const word = (item as { word?: unknown }).word;
    const normalized = typeof word === "string" ? normalizeWord(word) : "";
    return normalized ? [normalized] : [];
  });
}

function completedReviewCount(state: StudyState | null | undefined): number {
  if (state?.widget !== "review" || !Array.isArray(state.payload.items)) return 0;
  const completedPrefix = state.phase === "review_complete"
    ? state.payload.items.length
    : Math.min(state.payload.items.length, Math.max(0, state.current_index));
  return state.payload.items.slice(0, completedPrefix).filter(isFormalReviewItem).length;
}

function completedNewWordCount(state: StudyState | null | undefined): number {
  if (state?.widget !== "pretest") return 0;
  const parsedItems = pretestItemsSchema.safeParse(state.payload.items);
  if (!parsedItems.success) return 0;

  const completedCount = state.phase === "pretest_complete"
    ? parsedItems.data.length
    : Math.min(parsedItems.data.length, Math.max(0,
      state.current_index + (state.phase === "pretest" ? 0 : 1),
    ));
  const relearnWords = new Set(state.flow.relearn_words.map(normalizeWord));
  return new Set(parsedItems.data
    .slice(0, completedCount)
    .map((item) => normalizeWord(item.word))
    .filter((word) => word && !relearnWords.has(word))).size;
}

function sameSnapshotWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((word, index) => word === right[index]);
}

function samePretestSnapshot(left: StudyState | null | undefined, right: StudyState): boolean {
  if (left?.widget !== "pretest" || right.widget !== "pretest") return false;
  const leftItems = pretestItemsSchema.safeParse(left.payload.items);
  const rightItems = pretestItemsSchema.safeParse(right.payload.items);
  if (!leftItems.success || !rightItems.success) return false;
  return sameSnapshotWords(
    leftItems.data.map((item) => normalizeWord(item.word)),
    rightItems.data.map((item) => normalizeWord(item.word)),
  );
}

function sameReviewSnapshot(left: StudyState | null | undefined, right: StudyState): boolean {
  if (left?.widget !== "review" || right.widget !== "review") return false;
  return sameSnapshotWords(reviewSnapshotWords(left), reviewSnapshotWords(right));
}

function storedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function newWordsCountForUpdate(session: StudySessionRow, nextState: StudyState): number {
  const savedCount = storedCount(session.new_words_count);
  const previousSnapshotCount = completedNewWordCount(session.state);
  const nextSnapshotCount = completedNewWordCount(nextState);

  if (samePretestSnapshot(session.state, nextState)) {
    const completedBeforeSnapshot = Math.max(0, savedCount - previousSnapshotCount);
    return Math.max(savedCount, completedBeforeSnapshot + nextSnapshotCount);
  }

  const completedBeforeNextState = Math.max(savedCount, previousSnapshotCount);
  return nextState.widget === "pretest"
    ? completedBeforeNextState + nextSnapshotCount
    : completedBeforeNextState;
}

function reviewWordsCountForUpdate(session: StudySessionRow, nextState: StudyState): number {
  const savedCount = storedCount(session.review_words_count);
  const previousSnapshotCount = completedReviewCount(session.state);
  const nextSnapshotCount = completedReviewCount(nextState);

  if (nextState.widget !== "review") {
    return Math.max(savedCount, previousSnapshotCount);
  }

  const startsNextSnapshot = session.state?.widget === "review"
    && session.state.phase === "review_complete"
    && nextState.phase === "review";
  if (!startsNextSnapshot && sameReviewSnapshot(session.state, nextState)) {
    const completedBeforeSnapshot = Math.max(0, savedCount - previousSnapshotCount);
    return Math.max(savedCount, completedBeforeSnapshot + nextSnapshotCount);
  }

  return Math.max(savedCount, previousSnapshotCount) + nextSnapshotCount;
}

async function updateSessionState(
  session: StudySessionRow,
  state: StudyState,
  db: StudySessionDb,
  userId: string,
): Promise<StudySessionRow> {
  const nextState = assertState(state);
  const updatedAt = nextRevision(session.updated_at);
  const newWordsCount = newWordsCountForUpdate(session, nextState);
  const reviewWordsCount = reviewWordsCountForUpdate(session, nextState);
  const { data, error } = await db
    .from("study_sessions")
    .update({
      state: nextState,
      updated_at: updatedAt,
      new_words_count: newWordsCount,
      review_words_count: reviewWordsCount,
    })
    .eq("id", session.id)
    .eq("user_id", userId)
    .is("ended_at", null)
    .select(sessionColumns)
    .single();
  assertStudySessionDatabaseResult(error);
  return parseSession(data);
}

export async function getStudyDate(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<string> {
  return dateInTimeZone(await getUserTimeZone(db, userId));
}

function completedRelearnInState(value: unknown, normalizedWord: string): boolean {
  const parsed = studyStateSchema.safeParse(value);
  if (!parsed.success) return false;
  const state = parsed.data;
  const queue = state.flow.lesson_words;
  if (state.widget !== "lesson" || !queue?.length || state.current_index >= queue.length) return false;
  if (!["lesson_explain", "lesson_exercise", "lesson_feedback", "lesson_complete"].includes(state.phase)) return false;
  if (!state.flow.relearn_words.some((word) => normalizeWord(word) === normalizedWord)) return false;
  if (state.phase === "lesson_complete"
    && normalizeWord(queue[queue.length - 1] ?? "") !== normalizeWord(state.current_word ?? "")) return false;
  const completeCount = state.phase === "lesson_complete" ? queue.length : state.current_index;
  return queue.slice(0, completeCount).some((word) => normalizeWord(word) === normalizedWord);
}

type RelearnSessionRow = { id: string; ended_at: string | null; state: unknown };
type RelearnAttemptRow = {
  session_id: string | null;
  activity_type: string;
  is_correct: boolean;
  created_at: string;
};

/**
 * Detect a completed same-day Lesson relearn from active session state or the
 * durable Review and Lesson attempts in a finished session. Invalid historical
 * snapshots are not resumable and do not interrupt Review/FSRS processing.
 */
export async function hasCompletedLessonRelearnToday(
  word: string,
  now = new Date(),
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<boolean> {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord) return false;
  try {
    const timeZone = await getUserTimeZone(db, userId);
    const today = dateInTimeZone(timeZone, now);
    const { start, end } = localDateRange(today, timeZone);
    const sessionResult = await db.from("study_sessions")
      .select("id,ended_at,state")
      .eq("user_id", userId)
      .gte("updated_at", start)
      .lt("updated_at", end);
    assertDatabaseResult(sessionResult.error);
    const sessions = (sessionResult.data ?? []) as RelearnSessionRow[];
    if (sessions.some((session) => completedRelearnInState(session.state, normalizedWord))) return true;

    const sessionIds = sessions.map((session) => session.id);
    if (sessionIds.length === 0) return false;
    const attemptResult = await db.from("attempts")
      .select("session_id,activity_type,is_correct,created_at,word:words!inner(normalized_word)")
      .eq("user_id", userId)
      .eq("word.normalized_word", normalizedWord)
      .in("scope", ["review", "lesson"])
      .gte("created_at", start)
      .lt("created_at", end)
      .in("session_id", sessionIds)
      .in("activity_type", ["review", ...LESSON_ACTIVITY_TYPES]);
    assertDatabaseResult(attemptResult.error);
    const attempts = (attemptResult.data ?? []) as RelearnAttemptRow[];
    const lessonActivityTypeSet = new Set<string>(LESSON_ACTIVITY_TYPES);
    return sessionIds.some((sessionId) => {
      const sessionAttempts = attempts.filter((attempt) => attempt.session_id === sessionId);
      return sessionAttempts.some((reviewAttempt) => {
        if (reviewAttempt.activity_type !== "review" || reviewAttempt.is_correct !== false) return false;
        const reviewTime = Date.parse(reviewAttempt.created_at);
        return Number.isFinite(reviewTime) && sessionAttempts.some((lessonAttempt) => {
          if (!lessonActivityTypeSet.has(lessonAttempt.activity_type)) return false;
          const lessonTime = Date.parse(lessonAttempt.created_at);
          return Number.isFinite(lessonTime) && lessonTime >= reviewTime;
        });
      });
    });
  } catch {
    console.error("WordLoop same-day relearn check failed");
    return false;
  }
}

export async function getActiveStudySession(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudySessionRow | null> {
  const { data, error } = await db
    .from("study_sessions")
    .select(sessionColumns)
    .eq("user_id", userId)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertStudySessionDatabaseResult(error);
  return data ? parseSession(data) : null;
}

export async function getOrCreateActiveStudySession(
  initialState?: StudyState,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudySessionRow> {
  const active = await getActiveStudySession(db, userId);
  if (active) return active;
  const insertValues: Record<string, unknown> = { user_id: userId };
  if (initialState) {
    const state = assertState(initialState);
    insertValues.state = state;
    insertValues.new_words_count = completedNewWordCount(state);
    insertValues.review_words_count = completedReviewCount(state);
  }
  const { data, error } = await db
    .from("study_sessions")
    .insert(insertValues)
    .select(sessionColumns)
    .single();
  if (isUniqueViolation(error)) {
    const winner = await getActiveStudySession(db, userId);
    if (winner) return winner;
  }
  assertStudySessionDatabaseResult(error);
  return parseSession(data);
}

export async function persistStudyState(
  state: StudyState,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  knownActive?: StudySessionRow | null,
): Promise<StudySessionRow> {
  const nextState = assertState(state);
  const active = knownActive === undefined ? await getActiveStudySession(db, userId) : knownActive;
  if (active) return updateSessionState(active, nextState, db, userId);
  const { data, error } = await db
    .from("study_sessions")
    .insert({
      user_id: userId,
      state: nextState,
      new_words_count: completedNewWordCount(nextState),
      review_words_count: completedReviewCount(nextState),
    })
    .select(sessionColumns)
    .single();
  if (isUniqueViolation(error)) {
    const winner = await getActiveStudySession(db, userId);
    if (winner) return updateSessionState(winner, nextState, db, userId);
  }
  assertStudySessionDatabaseResult(error);
  return parseSession(data);
}

function nextRevision(previous: string): string {
  const previousMs = Date.parse(previous);
  const now = Date.now();
  return new Date(Math.max(now, Number.isFinite(previousMs) ? previousMs + 1 : now)).toISOString();
}

export async function assertActiveStudySessionRevision(
  expectedRevision: string | null,
  expectedSessionId?: string,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudySessionRow | null> {
  const active = await getActiveStudySession(db, userId);
  if ((active?.updated_at ?? null) !== expectedRevision
    || (expectedSessionId !== undefined && active?.id !== expectedSessionId)) {
    throw new StaleStudyStateError();
  }
  return active;
}

/** Persist a Web-owned state transition only while its rendered revision is current. */
export async function persistStudyStateIfRevision(
  state: StudyState,
  expectedRevision: string | null,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  expectedSessionId?: string,
): Promise<StudySessionRow> {
  const nextState = assertState(state);
  const active = await assertActiveStudySessionRevision(expectedRevision, expectedSessionId, db, userId);
  if (!active) {
    const { data, error } = await db
      .from("study_sessions")
      .insert({
        user_id: userId,
        state: nextState,
        new_words_count: completedNewWordCount(nextState),
        review_words_count: completedReviewCount(nextState),
      })
      .select(sessionColumns)
      .maybeSingle();
    if (isUniqueViolation(error)) throw new StaleStudyStateError();
    assertStudySessionDatabaseResult(error);
    if (!data) throw new StaleStudyStateError();
    return parseSession(data);
  }

  if (expectedRevision === null) throw new StaleStudyStateError();
  const newWordsCount = newWordsCountForUpdate(active, nextState);
  const reviewWordsCount = reviewWordsCountForUpdate(active, nextState);
  const { data, error } = await db
    .from("study_sessions")
    .update({
      state: nextState,
      updated_at: nextRevision(expectedRevision),
      new_words_count: newWordsCount,
      review_words_count: reviewWordsCount,
    })
    .eq("id", active.id)
    .eq("user_id", userId)
    .is("ended_at", null)
    .eq("updated_at", expectedRevision)
    .select(sessionColumns)
    .maybeSingle();
  assertStudySessionDatabaseResult(error);
  if (!data) throw new StaleStudyStateError();
  return parseSession(data);
}

/** Commit one plan-bound answer, evidence event, cadence settlement, and session CAS together. */
export async function recordPlannedSubmission(input: {
  active: StudySessionRow;
  expected_revision: string | null;
  submission_id: string;
  plan: LessonExercisePlan;
  scope: ExerciseScope;
  word: string;
  activity_type: string;
  user_answer: string;
  is_correct: boolean;
  error_layer: string;
  skill_evidence: SkillEvidence[];
  first_attempt: boolean;
  hint_used: boolean;
  answer_revealed: boolean;
  active_ms: number | null;
  grading_ms: number | null;
  next_state: StudyState;
  completion_date: string;
  cadence_candidates?: Record<string, unknown>;
}, db: StudySessionDb = getDatabase(), userId = getAuthenticatedUserId()): Promise<StudySessionRow> {
  if (!input.expected_revision) throw new StaleStudyStateError();
  const { data, error } = await db.rpc("record_planned_submission_v1", {
    p_user_id: userId,
    p_session_id: input.active.id,
    p_expected_revision: input.expected_revision,
    p_submission_id: input.submission_id,
    p_plan_id: input.plan.plan_id,
    p_exercise_id: input.plan.exercise_id,
    p_scope: input.scope,
    p_normalized_word: normalizeWord(input.word),
    p_activity_type: input.activity_type,
    p_user_answer: input.user_answer,
    p_is_correct: input.is_correct,
    p_error_layer: input.error_layer,
    p_skill_ids: input.plan.skill_ids,
    p_skill_evidence: input.skill_evidence,
    p_first_attempt: input.first_attempt,
    p_hint_used: input.hint_used,
    p_answer_revealed: input.answer_revealed,
    p_active_ms: input.active_ms,
    p_grading_ms: input.grading_ms,
    p_next_state: input.next_state,
    p_new_words_count: input.active.new_words_count,
    p_review_words_count: input.active.review_words_count,
    p_completion_date: input.completion_date,
    p_cadence_candidates: input.cadence_candidates ?? {},
  });
  if (error) {
    const message = typeof error.message === "string" ? error.message : "";
    if (/STALE_STUDY_STATE|PLANNED_EXERCISE_MISMATCH|PLANNED_WORD_MISMATCH/.test(message)) throw new StaleStudyStateError();
    assertDatabaseResult(error);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("PLANNED_SUBMISSION_RESULT_MISSING");
  return parseSession(data);
}

/** Freeze the first Lesson queue for an existing study flow. */
export async function freezeLessonQueueForSession(
  session: StudySessionRow,
  todayWords: VocabularyItem[],
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  expectedRevision?: string | null,
): Promise<StudySessionRow> {
  const state = session.state;
  if (!state || (state.widget === "lesson" && state.flow.lesson_words !== undefined)) return session;
  const completedLessonWords = await getCompletedLessonWords(db, userId);
  const existingLessonWords = state.flow.lesson_words === undefined
    ? []
    : filterPreviouslyCompletedLessonWords(
      state.flow.lesson_words,
      completedLessonWords,
      state.flow.relearn_words,
    );
  const lessonWords = existingLessonWords.length > 0
    ? existingLessonWords
    : buildLessonWords(
      state.flow.relearn_words,
      todayWords,
      completedLessonWords,
      state.flow.pretest_familiar_words,
    );
  if (lessonWords.length === 0 || (state.flow.lesson_words !== undefined
    && lessonWords.length === state.flow.lesson_words.length
    && lessonWords.every((word, index) => word === state.flow.lesson_words?.[index]))) return session;
  const nextState = {
    ...state,
    flow: { ...state.flow, lesson_words: lessonWords },
  };
  return expectedRevision === undefined
    ? persistStudyState(nextState, db, userId, session)
    : persistStudyStateIfRevision(nextState, expectedRevision, db, userId, session.id);
}

interface SessionAttemptRow {
  activity_type: string;
  scope: string;
  created_at: string;
  word: { normalized_word: string } | Array<{ normalized_word: string }>;
}

async function getLegacyLessonAttemptWords(
  session: StudySessionRow,
  db: StudySessionDb,
  userId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from("attempts")
    .select("activity_type,scope,created_at,word:words!inner(normalized_word)")
    .eq("user_id", userId)
    .gte("created_at", session.started_at)
    .order("created_at", { ascending: true });
  assertStudySessionDatabaseResult(error);
  return ((data ?? []) as unknown as SessionAttemptRow[])
    // Pretest and Review attempts prove those stages, not that the word was
    // visited by the formal Lesson widget. Keep relearn words from the old
    // flow pending unless a Lesson-side attempt actually visited them.
    .filter((row) => row.scope === "lesson"
      && !row.activity_type.startsWith("pretest_") && row.activity_type !== "review")
    .map((row) => Array.isArray(row.word) ? row.word[0]?.normalized_word : row.word.normalized_word)
    .filter((word): word is string => Boolean(word));
}

/**
 * Normalize one pre-queue active Lesson session exactly once. The recovered
 * queue uses durable attempts plus the old flow and session-date daily words;
 * it never relies on the current live status alone.
 */
export async function normalizeLegacyLessonSession(
  session: StudySessionRow,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  expectedRevision?: string | null,
): Promise<StudySessionRow> {
  const state = session.state;
  if (!state || state.widget !== "lesson" || state.flow.lesson_words !== undefined) return session;

  const [todayWords, attemptWords, completedLessonWords] = await Promise.all([
    getTodayWords(state.date, db, userId),
    getLegacyLessonAttemptWords(session, db, userId),
    getCompletedLessonWords(db, userId),
  ]);
  const lessonWords = recoverLegacyLessonWords({
    relearnWords: state.flow.relearn_words,
    todayWords,
    attemptWords,
    currentWord: state.current_word,
    completedLessonWords,
    excludedWords: state.flow.pretest_familiar_words,
  });
  if (lessonWords.length === 0) throw new Error("LESSON_QUEUE_EMPTY");

  const currentIndex = state.current_word
    ? lessonWordIndex(lessonWords, state.current_word)
    : Math.min(state.current_index, lessonWords.length - 1);
  if (state.current_word && currentIndex < 0) throw new Error("LESSON_CURSOR_MISMATCH");

  const nextState = {
    ...state,
    current_index: Math.max(0, currentIndex),
    flow: { ...state.flow, lesson_words: lessonWords },
  };
  return expectedRevision === undefined
    ? persistStudyState(nextState, db, userId, session)
    : persistStudyStateIfRevision(nextState, expectedRevision, db, userId, session.id);
}

function stateError(event: StudySessionEvent, phase: StudyPhase): Error {
  return new Error(`Cannot apply ${event} while study session is in ${phase}.`);
}

function payloadWord(payload: Record<string, unknown>): string {
  const parsed = z.string().trim().min(1).max(100).safeParse(payload.word);
  if (!parsed.success) throw new Error("Study session payload has no current word.");
  return parsed.data;
}

function pretestWordAt(payload: Record<string, unknown>, index: number): string {
  const parsedItems = pretestItemsSchema.safeParse(payload.items);
  if (!parsedItems.success) throw new Error("Study session pretest payload is invalid.");
  const item = parsedItems.data[index];
  if (!item) throw new Error("Study session index is outside the pretest payload.");
  return item.word;
}

function pretestItemCount(payload: Record<string, unknown>): number {
  const parsedItems = pretestItemsSchema.safeParse(payload.items);
  if (!parsedItems.success) throw new Error("Study session pretest payload is invalid.");
  return parsedItems.data.length;
}

/**
 * b8a766a1 used listen_recall + the item-count cursor as the pretest
 * terminal state. Treat only that exact shape as the completed-pretest
 * compatibility state; an in-progress recall cursor must remain resumable.
 */
export function isLegacyCompletedPretestState(state: StudyState): boolean {
  if (state.widget !== "pretest" || state.phase !== "listen_recall") return false;
  const items = pretestItemsSchema.safeParse(state.payload.items);
  return items.success && state.current_index === items.data.length;
}

export function normalizeStudyStateForRead(state: StudyState): StudyState {
  if (state.widget === "pretest" && state.payload.source === undefined) {
    state = { ...state, payload: { ...state.payload, source: "new_word" } };
  }
  if (isLegacyCompletedPretestState(state)) {
    return {
      ...state,
      phase: "pretest_complete",
      current_word: null,
    };
  }
  if (state.widget !== "lesson" || state.phase !== "lesson_exercise" || state.payload.mode === "exercise") {
    return state;
  }
  try {
    return { ...state, payload: exercisePayload(state) };
  } catch {
    // Keep an unreadable historical payload intact so normal read paths can
    // report their existing Lesson payload error instead of failing session lookup.
    return state;
  }
}

function exercisePayload(state: StudyState): Record<string, unknown> {
  const source = state.payload;
  const parsedWord = z.string().trim().min(1).max(100).safeParse(source.word);
  if (!parsedWord.success) throw new Error("Study session payload has no current word.");
  const directExercise = lessonExerciseSchema.safeParse(source);
  const nestedExercise = lessonExerciseSchema.safeParse(source.exercise);
  const exerciseSource = source.mode === "exercise" && directExercise.success
    ? source
    : nestedExercise.success
      ? source.exercise as Record<string, unknown>
      : directExercise.success
        ? source
        : null;
  if (!exerciseSource) throw new Error("Study session lesson payload has no complete exercise.");
  const { exercise: _nestedExercise, feedback: _feedback, mode: _mode, ...preserved } = source;
  const progress = z.string().trim().min(1).max(40).safeParse(source.progress);
  const title = z.string().trim().max(120).safeParse(source.title);
  return {
    ...preserved,
    widget: "lesson",
    mode: "exercise",
    word: source.word,
    ...(title.success ? { title: source.title } : {}),
    progress: progress.success ? source.progress : "当前练习",
    activity_type: exerciseSource.activity_type,
    instruction: exerciseSource.instruction,
    prompt: exerciseSource.prompt,
    multiline: exerciseSource.multiline,
    ...(exerciseSource.accepted_answers ? { accepted_answers: exerciseSource.accepted_answers } : {}),
  };
}

function isCanonicalLessonExerciseState(state: StudyState): boolean {
  if (state.widget !== "lesson" || state.phase !== "lesson_exercise" || state.payload.mode !== "exercise") {
    return false;
  }
  const word = z.string().trim().min(1).max(100).safeParse(state.payload.word);
  if (!word.success || word.data !== state.current_word || !lessonExerciseSchema.safeParse(state.payload).success) {
    return false;
  }
  return state.flow.lesson_words === undefined
    || state.flow.lesson_words[state.current_index] === state.current_word;
}

function reviewItems(state: StudyState): z.infer<typeof reviewSessionPayloadSchema>["items"] {
  const parsed = reviewSessionPayloadSchema.safeParse(state.payload);
  if (!parsed.success) throw new Error("Study session review payload is invalid.");
  return parsed.data.items;
}

function reviewWordAt(items: ReturnType<typeof reviewItems>, index: number): string {
  const item = items[index];
  if (!item) throw new Error("Study session index is outside the review payload.");
  return item.word;
}

function reviewAnswerMatches(
  answer: ReviewAnswerInput,
  items: ReturnType<typeof reviewItems>,
): boolean {
  if (answer.current_index < 0 || answer.current_index >= items.length) return false;
  return normalizeWord(reviewWordAt(items, answer.current_index)) === normalizeWord(answer.word);
}

export type ReviewCursorPosition = "current" | "passed" | "mismatch";

/**
 * Classify a server-owned Review cursor without advancing it. The position
 * lookup is shared by the normal submission and the lost-response recovery;
 * the actual transition remains in advanceReviewState.
 */
export function reviewCursorPosition(state: StudyState | null, word: string): ReviewCursorPosition {
  if (!state || state.widget !== "review") return "mismatch";
  const items = reviewItems(state);
  const targetIndex = items.findIndex((item) => normalizeWord(item.word) === normalizeWord(word));
  if (targetIndex < 0) return "mismatch";
  if (targetIndex < state.current_index) return "passed";
  if (state.phase !== "review" || targetIndex !== state.current_index) return "mismatch";
  if (!state.current_word || normalizeWord(state.current_word) !== normalizeWord(word)) return "mismatch";
  return "current";
}

function appendRelearnWord(flow: StudyFlow, word: string, isCorrect: boolean, suppressRelearn: boolean): StudyFlow {
  if (isCorrect || suppressRelearn) return flow;
  const normalized = normalizeWord(word);
  if (flow.relearn_words.some((entry) => normalizeWord(entry) === normalized)) return flow;
  return {
    ...flow,
    relearn_words: [...flow.relearn_words, word].slice(0, REVIEW_SESSION_MAX),
  };
}

function advanceReviewState(state: StudyState, answer: ReviewAnswerInput, suppressRelearn = false): StudyState {
  const items = reviewItems(state);
  const currentIndex = answer.current_index;
  const expectedWord = reviewWordAt(items, currentIndex);

  if (state.phase === "review_complete") {
    if (currentIndex === state.current_index - 1 && reviewAnswerMatches(answer, items)) return state;
    throw stateError(answer.event, state.phase);
  }
  if (state.phase !== "review") throw stateError(answer.event, state.phase);
  if (currentIndex !== state.current_index) {
    // A lost response can cause the Widget to retry the same cursor. Accept
    // that exact transition idempotently, but reject stale or future cards.
    if (currentIndex === state.current_index - 1 && reviewAnswerMatches(answer, items)) return state;
    throw new Error("REVIEW_CURSOR_MISMATCH");
  }
  if (!reviewAnswerMatches(answer, items)) throw new Error("REVIEW_WORD_MISMATCH");
  if (!state.current_word || normalizeWord(state.current_word) !== normalizeWord(answer.word)) {
    throw new Error("REVIEW_WORD_MISMATCH");
  }

  const nextIndex = currentIndex + 1;
  return {
    ...state,
    phase: nextIndex >= items.length ? "review_complete" : "review",
    current_word: nextIndex >= items.length ? null : reviewWordAt(items, nextIndex),
    current_index: nextIndex,
    flow: appendRelearnWord(state.flow, expectedWord, answer.is_correct, suppressRelearn),
  };
}

export function makeStudyState(input: {
  date: string;
  widget: StudyWidget;
  phase: StudyPhase;
  current_word: string | null;
  current_index: number;
  retry_count: number;
  flow?: StudyFlow;
  payload: Record<string, unknown>;
}): StudyState {
  return assertState({ version: 1, flow: { relearn_words: [] }, ...input });
}

function hasPretestFamiliarWord(state: StudyState, word: string): boolean {
  const normalized = normalizeWord(word);
  return (state.flow.pretest_familiar_words ?? []).some((entry) => normalizeWord(entry) === normalized);
}

async function getPretestWordStatus(
  word: string,
  db: StudySessionDb,
  userId: string,
): Promise<string> {
  const { data, error } = await db
    .from("user_words")
    .select("status,word:words!inner(normalized_word)")
    .eq("user_id", userId)
    .eq("word.normalized_word", word)
    .maybeSingle();
  assertStudySessionDatabaseResult(error);
  if (!data || typeof data.status !== "string") throw new Error("PRETEST_WORD_NOT_FOUND");
  return data.status;
}

function pretestFamiliarResult(session: StudySessionRow, markedWord: string): {
  action: "pretest_mark_familiar";
  word: string;
  phase: StudyPhase;
  current_word: string | null;
  current_index: number;
  revision: string;
} {
  const state = session.state;
  if (!state) throw new Error("No resumable active study session.");
  return {
    action: "pretest_mark_familiar",
    word: markedWord,
    phase: state.phase,
    current_word: state.current_word,
    current_index: state.current_index,
    revision: session.updated_at,
  };
}

/**
 * Correct the current new-word classification after its answer is revealed.
 * The session revision and the session-scoped marker make cursor movement and
 * the new-word counter a single idempotent compare-and-swap operation.
 */
export async function markPretestFamiliar(
  input: PretestMarkFamiliarInput,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<ReturnType<typeof pretestFamiliarResult>> {
  const parsed = pretestMarkFamiliarSchema.parse(input);
  const word = normalizeWord(parsed.word);
  const active = await getActiveStudySession(db, userId);
  if (!active?.state || active.state.widget !== "pretest") {
    throw new Error("PRETEST_SESSION_NOT_ACTIVE");
  }
  const state = normalizeStudyStateForRead(active.state);
  if (state.payload.source !== "new_word") throw new Error("PRETEST_FAMILIAR_SOURCE_NOT_ALLOWED");

  if (hasPretestFamiliarWord(state, word)) {
    await markPretestWordKnown(word, db, userId);
    return pretestFamiliarResult({ ...active, state }, word);
  }

  if (active.updated_at !== parsed.expected_revision) throw new Error("STUDY_SESSION_REVISION_MISMATCH");
  if (state.phase !== "pretest_result"
    || state.current_index !== parsed.current_index
    || state.flow.lesson_words !== undefined
    || !state.current_word
    || normalizeWord(state.current_word) !== word) {
    throw new Error("PRETEST_FAMILIAR_CURSOR_MISMATCH");
  }
  const pretestStatus = await getPretestWordStatus(word, db, userId);
  if (pretestStatus === "known") throw new Error("PRETEST_FAMILIAR_ALREADY_KNOWN");
  if (pretestStatus !== "uncertain" && pretestStatus !== "unknown") {
    throw new Error("PRETEST_FAMILIAR_RESULT_NOT_ELIGIBLE");
  }

  const itemCount = pretestItemCount(state.payload);
  const markedWords = [...(state.flow.pretest_familiar_words ?? []), word];
  const advanced = parsed.current_index + 1 < itemCount
    ? advanceStudyState(state, "pretest_question", parsed.current_index + 1)
    : state;
  const nextState = assertState({
    ...advanced,
    flow: {
      ...advanced.flow,
      relearn_words: advanced.flow.relearn_words.filter((entry) => normalizeWord(entry) !== word),
      pretest_familiar_words: markedWords,
    },
  });
  let updated: StudySessionRow;
  try {
    updated = await persistStudyStateIfRevision(nextState, parsed.expected_revision, db, userId, active.id);
  } catch (caught) {
    if (!(caught instanceof StaleStudyStateError)) throw caught;
    const winner = await getActiveStudySession(db, userId);
    if (!winner?.state || winner.state.widget !== "pretest"
      || !hasPretestFamiliarWord(normalizeStudyStateForRead(winner.state), word)) {
      throw new Error("STUDY_SESSION_REVISION_MISMATCH");
    }
    updated = winner;
  }
  await markPretestWordKnown(word, db, userId);
  return pretestFamiliarResult(updated, word);
}

export function advanceStudyState(
  state: StudyState,
  event: StudySessionEvent,
  requestedIndex?: number,
  reviewAnswer?: ReviewAnswerInput,
  suppressRelearn = false,
): StudyState {
  if (state.widget === "review") {
    if (event !== "review_answer" || !reviewAnswer) throw stateError(event, state.phase);
    if (requestedIndex !== undefined && requestedIndex !== reviewAnswer.current_index) {
      throw new Error("REVIEW_CURSOR_MISMATCH");
    }
    return advanceReviewState(state, reviewAnswer, suppressRelearn);
  }
  const currentIndex = requestedIndex ?? state.current_index;
  if (!Number.isInteger(currentIndex) || currentIndex < 0) throw new Error("Study session index must be a non-negative integer.");

  if (state.widget === "pretest") {
    const itemCount = pretestItemCount(state.payload);
    const isEndOfPretest = currentIndex === itemCount;
    const currentWord = isEndOfPretest ? null : pretestWordAt(state.payload, currentIndex);
    if (event === "pretest_question") {
      if (state.phase !== "pretest" && state.phase !== "pretest_result") throw stateError(event, state.phase);
      if (isEndOfPretest) throw new Error("Study session index is outside the pretest payload.");
      return { ...state, phase: "pretest", current_word: currentWord, current_index: currentIndex };
    }
    if (event === "pretest_result") {
      if (state.phase !== "pretest") throw stateError(event, state.phase);
      if (isEndOfPretest) throw new Error("Study session index is outside the pretest payload.");
      return { ...state, phase: "pretest_result", current_word: currentWord, current_index: currentIndex };
    }
    if (event === "listen_repeat") {
      if (state.phase !== "pretest_result" && state.phase !== "listen_recall") throw stateError(event, state.phase);
      if (isEndOfPretest) throw new Error("Study session index is outside the pretest payload.");
      return { ...state, phase: "listen_repeat", current_word: currentWord, current_index: currentIndex };
    }
    if (event === "listen_recall") {
      if (state.phase !== "listen_repeat" && state.phase !== "listen_recall") throw stateError(event, state.phase);
      return { ...state, phase: "listen_recall", current_word: currentWord, current_index: currentIndex };
    }
    if (event === "pretest_complete") {
      if (state.phase !== "pretest_result" && state.phase !== "listen_repeat" && state.phase !== "listen_recall") {
        throw stateError(event, state.phase);
      }
      if (!isEndOfPretest) throw new Error("Study session pretest completion requires the terminal cursor.");
      return { ...state, phase: "pretest_complete", current_word: null, current_index: currentIndex };
    }
    throw new Error(`Event ${event} is not valid for a pretest session.`);
  }

  if (state.widget === "lesson") {
    state = normalizeStudyStateForRead(state);
    if (event === "lesson_start_exercise") {
      if (state.phase === "lesson_exercise") {
        if (requestedIndex !== undefined && requestedIndex !== state.current_index) throw stateError(event, state.phase);
        if (isCanonicalLessonExerciseState(state)) return state;
      }
      if (state.phase !== "lesson_explain") throw stateError(event, state.phase);
      const nextPayload = exercisePayload(state);
      return { ...state, phase: "lesson_exercise", payload: nextPayload };
    }
    if (event === "lesson_retry") {
      if (state.phase === "lesson_complete" && state.payload.consolidation === true) {
        const status = z.enum(["exercise", "feedback"]).safeParse(state.payload.consolidation_status);
        const feedback = typeof state.payload.feedback === "object" && state.payload.feedback !== null
          ? state.payload.feedback as Record<string, unknown>
          : null;
        if (requestedIndex !== undefined && requestedIndex !== state.current_index) throw new Error("LESSON_CURSOR_MISMATCH");
        if (status.success && status.data === "exercise" && state.retry_count === 1) return state;
        if (!status.success || status.data !== "feedback" || state.retry_count !== 1
          || feedback?.is_correct !== false || feedback.reveal_answer !== false) {
          throw stateError(event, state.phase);
        }
        return {
          ...state,
          payload: { ...exercisePayload(state), consolidation_status: "exercise" },
        };
      }
      if (state.phase === "lesson_exercise") {
        if (requestedIndex !== undefined && requestedIndex !== state.current_index) throw stateError(event, state.phase);
        if (isCanonicalLessonExerciseState(state)) return state;
      }
      if (state.phase !== "lesson_feedback") throw stateError(event, state.phase);
      const nextPayload = exercisePayload(state);
      return { ...state, phase: "lesson_exercise", payload: nextPayload };
    }
    if (event === "lesson_complete") {
      if (state.phase === "lesson_complete") return state;
      if (state.phase !== "lesson_feedback") throw stateError(event, state.phase);
      if (requestedIndex !== undefined && requestedIndex !== state.current_index) {
        throw new Error("LESSON_CURSOR_MISMATCH");
      }
      const lessonWords = state.flow.lesson_words;
      const lastIndex = (lessonWords?.length ?? 0) - 1;
      if (!lessonWords || lessonWords.length === 0
        || state.current_index !== lastIndex
        || !state.current_word
        || normalizeWord(state.current_word) !== normalizeWord(lessonWords[lastIndex] ?? "")) {
        throw new Error("LESSON_NOT_COMPLETE");
      }
      return { ...state, phase: "lesson_complete" };
    }
    if (event === "lesson_consolidation_defer") {
      if (state.phase !== "lesson_complete" || state.payload.mode !== "feedback"
        || state.payload.consolidation !== true || state.payload.consolidation_status !== "pending") {
        throw stateError(event, state.phase);
      }
      if (state.payload.consolidation_deferred === true) return state;
      return { ...state, payload: { ...state.payload, consolidation_deferred: true } };
    }
    throw new Error(`Event ${event} is not valid for a lesson session.`);
  }

  throw new Error(`Event ${event} is not valid for a dictation session.`);
}

export async function advanceStudySession(
  event: StudySessionEvent,
  requestedIndex?: number,
  reviewAnswer?: ReviewAnswerInput,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudySessionRow> {
  const active = await getActiveStudySession(db, userId);
  if (!active?.state) throw new Error("No resumable active study session.");
  let nextState = advanceStudyState(active.state, event, requestedIndex, reviewAnswer);
  if (event === "lesson_complete" && nextState.widget === "lesson" && nextState.phase === "lesson_complete") {
    nextState = await decideLessonConsolidation(nextState, db, userId);
  }
  if (nextState === active.state && active.state.widget === "lesson"
    && (event === "lesson_start_exercise" || event === "lesson_retry" || event === "lesson_complete")) {
    return active;
  }
  if (nextState !== active.state && event === "review_answer" && reviewAnswer && active.state.widget === "review") {
    const item = reviewItems(active.state)[reviewAnswer.current_index];
    if (isFormalReviewItem(item)) throw new Error("FSRS_REVIEW_SUBMISSION_REQUIRED");
  }
  return updateSessionState(active, nextState, db, userId);
}

export async function advanceStudySessionIfRevision(
  event: StudySessionEvent,
  requestedIndex: number,
  expectedRevision: string,
  expectedSessionId: string,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudySessionRow> {
  const active = await assertActiveStudySessionRevision(expectedRevision, expectedSessionId, db, userId);
  if (!active?.state) throw new Error("NO_ACTIVE_SESSION");
  let nextState = advanceStudyState(active.state, event, requestedIndex);
  if (event === "lesson_complete" && nextState.widget === "lesson" && nextState.phase === "lesson_complete") {
    nextState = await decideLessonConsolidation(nextState, db, userId);
  }
  if (nextState === active.state) return active;
  return persistStudyStateIfRevision(nextState, expectedRevision, db, userId, expectedSessionId);
}

/**
 * Advance the current Review answer using the cursor stored in the active
 * session. A retry after a lost response is idempotent: an already-passed
 * word is accepted without writing the cursor a second time.
 */
export async function advanceReviewAnswerFromServer(
  word: string,
  isCorrect: boolean,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  options: { suppressRelearn?: boolean } = {},
): Promise<{ session: StudySessionRow; position: Exclude<ReviewCursorPosition, "mismatch"> }> {
  const active = await getActiveStudySession(db, userId);
  if (!active?.state) throw new Error("No resumable active study session.");
  const position = reviewCursorPosition(active.state, word);
  if (position === "passed") return { session: active, position };
  if (position !== "current") {
    if (active.state.widget !== "review") throw new Error("REVIEW_SESSION_NOT_ACTIVE");
    if (active.state.phase !== "review") throw stateError("review_answer", active.state.phase);
    throw new Error("REVIEW_WORD_MISMATCH");
  }
  const answer = reviewAnswerSchema.parse({
    event: "review_answer",
    word,
    is_correct: isCorrect,
    current_index: active.state.current_index,
  });
  const nextState = advanceStudyState(active.state, "review_answer", active.state.current_index, answer, options.suppressRelearn);
  const session = await updateSessionState(active, nextState, db, userId);
  return { session, position: "current" };
}

export async function getPretestResults(
  session: StudySessionRow | null,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<Array<{ word: string; status: string; user_answer?: string; is_correct?: boolean; error_layer?: string }>> {
  if (!session?.state || session.state.widget !== "pretest") return [];
  const parsedItems = pretestItemsSchema.safeParse(session.state.payload.items);
  if (!parsedItems.success) return [];
  const words = parsedItems.data.map((item) => item.word);
  if (words.length === 0) return [];
  const { data, error } = await db
    .from("user_words")
    .select("id,status,word:words!inner(normalized_word)")
    .eq("user_id", userId)
    .in("word.normalized_word", words);
  assertStudySessionDatabaseResult(error);
  type ResultRow = { id: string; status: string; word: { normalized_word: string } | Array<{ normalized_word: string }> };
  const userWords = (data ?? []) as unknown as ResultRow[];
  const normalizedById = new Map(userWords.map((row) => {
    const word = Array.isArray(row.word) ? row.word[0]?.normalized_word : row.word.normalized_word;
    return [row.id, word] as const;
  }));
  let attempts: unknown[] = [];
  if (userWords.length > 0) {
    const result = await db
      .from("attempts")
      .select("word_id,user_answer,is_correct,error_layer,activity_type,created_at")
      .eq("user_id", userId)
      .in("word_id", userWords.map((row) => row.id))
      .in("activity_type", ["pretest_cn_to_en", "pretest_en_definition"])
      .gte("created_at", session.started_at)
      .order("created_at", { ascending: false });
    assertStudySessionDatabaseResult(result.error);
    attempts = result.data ?? [];
  }
  type AttemptRow = { word_id: string; user_answer: string; is_correct: boolean; error_layer: string; activity_type: string };
  const attemptByWord = new Map<string, AttemptRow>();
  for (const attempt of (attempts ?? []) as AttemptRow[]) {
    const word = normalizedById.get(attempt.word_id);
    if (word && !attemptByWord.has(word)) attemptByWord.set(word, attempt);
  }
  return words.flatMap((word) => {
    const row = userWords.find((entry) => normalizedById.get(entry.id) === word);
    if (!row) return [];
    const attempt = attemptByWord.get(word);
    return [{
      word,
      status: row.status,
      ...(attempt ? {
        user_answer: attempt.user_answer,
        is_correct: attempt.is_correct,
        error_layer: attempt.error_layer,
      } : {}),
    }];
  });
}

export function studySessionSummary(session: StudySessionRow | null, pretestResults?: Array<{
  word: string;
  status: string;
  user_answer?: string;
  is_correct?: boolean;
  error_layer?: string;
}>): {
  active: boolean;
  widget?: StudyWidget;
  phase?: StudyPhase;
  current_word?: string | null;
  current_index?: number;
  revision?: string;
  consolidation?: { kind: "translation" | "translation_cn_to_en" | "sentence"; trigger_round: number; target_words: string[]; activity_type?: string; plan_id?: string; exercise_id?: string; skill_goal?: string; target_sense?: string; estimated_seconds?: number };
  pretest_results?: Array<{ word: string; status: string; user_answer?: string; is_correct?: boolean; error_layer?: string }>;
} {
  if (!session || session.ended_at || !session.state) return { active: false };
  const rawConsolidation = session.state.payload.consolidation === true
    && (session.state.payload.consolidation_kind === "translation" || session.state.payload.consolidation_kind === "translation_cn_to_en" || session.state.payload.consolidation_kind === "sentence")
    && typeof session.state.payload.consolidation_trigger_round === "number"
    && Array.isArray(session.state.payload.consolidation_target_words)
    ? {
      kind: session.state.payload.consolidation_kind as "translation" | "translation_cn_to_en" | "sentence",
      trigger_round: session.state.payload.consolidation_trigger_round,
      target_words: session.state.payload.consolidation_target_words.filter((word): word is string => typeof word === "string"),
    }
    : null;
  const summary = {
    active: true,
    widget: session.state.widget,
    phase: session.state.phase,
    current_word: session.state.current_word,
    current_index: session.state.current_index,
    ...(rawConsolidation ? { consolidation: rawConsolidation } : {}),
  };
  const plan = lessonExercisePlanSchema.safeParse(session.state.payload.consolidation_plan ?? session.state.payload.plan);
  if (rawConsolidation && plan.success) {
    return {
      ...summary,
      consolidation: {
        ...rawConsolidation,
        activity_type: plan.data.planned_activity_type,
        plan_id: plan.data.plan_id,
        exercise_id: plan.data.exercise_id,
        skill_goal: plan.data.skill_goal,
        target_sense: plan.data.target_sense,
        estimated_seconds: plan.data.estimated_seconds,
      },
    };
  }
  if (session.state.widget === "pretest" && pretestResults) {
    return { ...summary, revision: session.updated_at, pretest_results: pretestResults };
  }
  return summary;
}

/** A persisted legacy translation wrap-up or a completed consolidation may finish the round. */
export function isCompletedLessonWrapup(state: StudyState | null): boolean {
  if (!state || state.widget !== "lesson" || state.phase !== "lesson_complete") return false;
  const lessonWords = state.flow.lesson_words;
  const lastIndex = (lessonWords?.length ?? 0) - 1;
  if (!lessonWords || lessonWords.length === 0 || state.current_index !== lastIndex
    || !state.current_word || normalizeWord(state.current_word) !== normalizeWord(lessonWords[lastIndex] ?? "")) return false;
  if (state.payload.mode !== "feedback" || state.payload.wrapup !== true) return false;
  if (typeof state.payload.feedback !== "object" || state.payload.feedback === null || Array.isArray(state.payload.feedback)) return false;
  const feedback = state.payload.feedback as Record<string, unknown>;
  return feedback.is_correct === true || feedback.reveal_answer === true;
}

/** A standalone Lesson round can finish after its one final primary exercise. */
export function isCompletedLessonRound(state: StudyState | null): boolean {
  if (!state || state.widget !== "lesson" || state.phase !== "lesson_complete") return false;
  const lessonWords = state.flow.lesson_words;
  const lastIndex = (lessonWords?.length ?? 0) - 1;
  if (!lessonWords || lessonWords.length === 0 || state.current_index !== lastIndex
    || !state.current_word || normalizeWord(state.current_word) !== normalizeWord(lessonWords[lastIndex] ?? "")) return false;
  if (state.payload.mode !== "feedback") return false;
  const deferredPending = state.payload.consolidation === true
    && state.payload.consolidation_status === "pending"
    && state.payload.consolidation_deferred === true;
  if (state.payload.consolidation === true && state.payload.consolidation_status !== "feedback" && !deferredPending) return false;
  if (state.payload.consolidation !== true && state.payload.wrapup === true) return false;
  if (typeof state.payload.feedback !== "object" || state.payload.feedback === null || Array.isArray(state.payload.feedback)) return false;
  const feedback = state.payload.feedback as Record<string, unknown>;
  return feedback.is_correct === true || feedback.reveal_answer === true || deferredPending;
}

export async function finishStudySession(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  expected?: { revision: string; sessionId: string; allowLessonRoundCompletion?: boolean },
): Promise<StudySessionRow> {
  const active = await getActiveStudySession(db, userId);
  if (!active) throw new Error("No active study session to finish.");
  if (expected && (active.id !== expected.sessionId || active.updated_at !== expected.revision)) {
    throw new StaleStudyStateError();
  }
  const completed = isCompletedLessonWrapup(active.state) || isCompletedLessonRound(active.state);
  if (!completed) throw new Error("LESSON_WRAPUP_NOT_COMPLETE");
  const completedLessonRound = isCompletedLessonWrapup(active.state) || isCompletedLessonRound(active.state);
  const lessonProfileHistory = completedLessonRound ? active.state?.flow.lesson_profile_history ?? [] : [];
  const completedState: StudyState | Record<string, never> = completedLessonRound && active.state
    ? {
      version: 1,
      date: active.state.date,
      widget: "lesson",
      phase: "lesson_complete",
      current_word: null,
      current_index: 0,
      retry_count: 0,
      flow: {
        relearn_words: [...active.state.flow.relearn_words],
        ...(active.state.flow.lesson_words ? { lesson_words: [...active.state.flow.lesson_words] } : {}),
        ...(lessonProfileHistory.length > 0 ? { lesson_profile_history: lessonProfileHistory } : {}),
      },
      payload: {
        widget: "lesson",
        mode: "completed",
        lesson_profiles: lessonProfileHistory,
        ...(active.state.payload.consolidation === true ? {
          consolidation: true,
          consolidation_kind: active.state.payload.consolidation_kind,
          consolidation_trigger_round: active.state.payload.consolidation_trigger_round,
          consolidation_target_words: active.state.payload.consolidation_target_words,
          consolidation_status: active.state.payload.consolidation_deferred === true ? "pending" : "completed",
          ...(active.state.payload.consolidation_deferred === true ? { consolidation_deferred: true } : {}),
        } : {}),
      },
    }
    : {};
  const now = new Date().toISOString();
  let update = db
    .from("study_sessions")
    .update({ ended_at: now, state: completedState, updated_at: now })
    .eq("id", active.id)
    .eq("user_id", userId)
    .is("ended_at", null);
  if (expected) update = update.eq("updated_at", expected.revision);
  const { data, error } = await update.select(sessionColumns).maybeSingle();
  assertStudySessionDatabaseResult(error);
  if (!data) {
    if (expected) throw new StaleStudyStateError();
    throw new Error("No active study session to finish.");
  }
  return parseSession(data);
}
