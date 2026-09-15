import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { StudyPhase, StudySessionEvent, StudySessionRow, StudyState, StudyWidget } from "../types.js";
import { assertDatabaseResult, dateInTimeZone } from "./shared.js";
import { getUserTimeZone } from "./words.js";

const sessionColumns = "id,user_id,started_at,ended_at,new_words_count,review_words_count,state,updated_at";
const pretestItemsSchema = z.array(z.object({ word: z.string().trim().min(1).max(100) }));
const lessonExerciseSchema = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
});

export const studyStateSchema = z.object({
  version: z.literal(1),
  date: z.string().trim().min(1),
  widget: z.enum(["pretest", "lesson", "dictation"]),
  phase: z.enum([
    "pretest", "pretest_result", "listen_repeat", "listen_recall",
    "lesson_explain", "lesson_exercise", "lesson_feedback", "dictation",
  ]),
  current_word: z.string().trim().max(100).nullable(),
  current_index: z.number().int().min(0),
  retry_count: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()),
}).strict();

const OLD_SESSION_SCHEMA_MESSAGE = "WordLoop 数据库版本过旧，请先部署 migration 202609150004。";

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
    state: parsedState.success ? parsedState.data : null,
    updated_at: row.updated_at,
  };
}

function assertState(state: StudyState): StudyState {
  const parsed = studyStateSchema.safeParse(state);
  if (!parsed.success) throw new Error("Invalid study session state.");
  return parsed.data;
}

async function updateSessionState(
  session: StudySessionRow,
  state: StudyState,
  db: StudySessionDb,
  userId: string,
): Promise<StudySessionRow> {
  const nextState = assertState(state);
  const updatedAt = new Date().toISOString();
  const { data, error } = await db
    .from("study_sessions")
    .update({ state: nextState, updated_at: updatedAt })
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
  if (initialState) insertValues.state = assertState(initialState);
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
): Promise<StudySessionRow> {
  const nextState = assertState(state);
  const active = await getActiveStudySession(db, userId);
  if (active) return updateSessionState(active, nextState, db, userId);
  const { data, error } = await db
    .from("study_sessions")
    .insert({ user_id: userId, state: nextState })
    .select(sessionColumns)
    .single();
  if (isUniqueViolation(error)) {
    const winner = await getActiveStudySession(db, userId);
    if (winner) return updateSessionState(winner, nextState, db, userId);
  }
  assertStudySessionDatabaseResult(error);
  return parseSession(data);
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

function exercisePayload(state: StudyState): Record<string, unknown> {
  const word = payloadWord(state.payload);
  const progress = z.string().trim().min(1).max(40).safeParse(state.payload.progress);
  const title = z.string().trim().max(120).safeParse(state.payload.title);
  const exercise = lessonExerciseSchema.safeParse(state.payload.exercise);
  if (!exercise.success) throw new Error("Study session lesson payload has no complete exercise.");
  return {
    widget: "lesson",
    mode: "exercise",
    word,
    ...(title.success ? { title: title.data } : {}),
    progress: progress.success ? progress.data : "当前练习",
    ...exercise.data,
  };
}

export function makeStudyState(input: {
  date: string;
  widget: StudyWidget;
  phase: StudyPhase;
  current_word: string | null;
  current_index: number;
  retry_count: number;
  payload: Record<string, unknown>;
}): StudyState {
  return assertState({ version: 1, ...input });
}

export function advanceStudyState(
  state: StudyState,
  event: StudySessionEvent,
  requestedIndex?: number,
): StudyState {
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
    throw new Error(`Event ${event} is not valid for a pretest session.`);
  }

  if (state.widget === "lesson") {
    if (event === "lesson_start_exercise") {
      if (state.phase !== "lesson_explain") throw stateError(event, state.phase);
      const nextPayload = exercisePayload(state);
      return { ...state, phase: "lesson_exercise", current_word: payloadWord(nextPayload) };
    }
    if (event === "lesson_retry") {
      if (state.phase !== "lesson_feedback") throw stateError(event, state.phase);
      const nextPayload = exercisePayload(state);
      return { ...state, phase: "lesson_exercise", current_word: payloadWord(nextPayload) };
    }
    throw new Error(`Event ${event} is not valid for a lesson session.`);
  }

  throw new Error(`Event ${event} is not valid for a dictation session.`);
}

export async function advanceStudySession(
  event: StudySessionEvent,
  requestedIndex?: number,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudySessionRow> {
  const active = await getActiveStudySession(db, userId);
  if (!active?.state) throw new Error("No resumable active study session.");
  const nextState = advanceStudyState(active.state, event, requestedIndex);
  return updateSessionState(active, nextState, db, userId);
}

export function studySessionSummary(session: StudySessionRow | null): {
  active: boolean;
  widget?: StudyWidget;
  phase?: StudyPhase;
  current_word?: string | null;
  current_index?: number;
} {
  if (!session || session.ended_at || !session.state) return { active: false };
  return {
    active: true,
    widget: session.state.widget,
    phase: session.state.phase,
    current_word: session.state.current_word,
    current_index: session.state.current_index,
  };
}

export async function finishStudySession(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudySessionRow> {
  const active = await getActiveStudySession(db, userId);
  if (!active) throw new Error("No active study session to finish.");
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("study_sessions")
    .update({ ended_at: now, state: {}, updated_at: now })
    .eq("id", active.id)
    .eq("user_id", userId)
    .is("ended_at", null)
    .select(sessionColumns)
    .single();
  assertStudySessionDatabaseResult(error);
  return parseSession(data);
}
