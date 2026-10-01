import { createEmptyCard, State, type Card, type ReviewLog } from "ts-fsrs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  noteReviewEnabledRequestSchema,
  noteReviewRatingRequestSchema,
  type NoteReviewCardJson,
  type NoteReviewItem,
  type NoteReviewListResponse,
  type NoteReviewRating,
  type NoteReviewStateResponse,
} from "../../shared/noteReviewContracts.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { createFsrsScheduler, ratingMap } from "./fsrsScheduler.js";

const noteIdSchema = z.string().uuid();

export class NoteReviewServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "NoteReviewServiceError";
  }
}

interface NoteRow {
  id: string;
  selected_text: string;
  note: string;
  status: string;
  converted_user_word_id: string | null;
  updated_at: string;
}

interface NoteStateRow {
  captured_note_id: string;
  enabled: boolean;
  card: unknown;
  due: string;
  revision: number | string;
}

interface CandidateRow {
  note_id: string;
  selected_text: string;
  note: string;
  note_updated_at: string;
  due: string;
  revision: number | string;
  latest_context_text: string | null;
  latest_source_type: string | null;
  latest_source_title: string | null;
  latest_source_url: string | null;
  latest_captured_at: string | null;
  total_count: number | string;
}

function invalidInput(message = "笔记复习请求无效。"): NoteReviewServiceError {
  return new NoteReviewServiceError(400, "INVALID_NOTE_REVIEW_REQUEST", message);
}

function databaseFailure(error: { message?: string } | null): never {
  const message = error?.message ?? "";
  if (message.includes("NOTE_REVIEW_NOT_FOUND")) {
    throw new NoteReviewServiceError(404, "NOTE_REVIEW_NOT_FOUND", "这条划词笔记不存在或已被移除。");
  }
  if (message.includes("NOTE_REVIEW_NOT_ELIGIBLE")) {
    throw new NoteReviewServiceError(409, "NOTE_REVIEW_NOT_ELIGIBLE", "这条笔记当前不满足笔记复习条件。");
  }
  if (message.includes("NOTE_REVIEW_NOTE_EMPTY")) {
    throw new NoteReviewServiceError(409, "NOTE_REVIEW_NOTE_EMPTY", "请先填写“我的理解”，再加入笔记复习。");
  }
  if (message.includes("NOTE_REVIEW_REVISION_CONFLICT")) {
    throw new NoteReviewServiceError(409, "NOTE_REVIEW_REVISION_CONFLICT", "这张笔记已在其他页面更新，请刷新后重试。");
  }
  if (message.includes("NOTE_REVIEW_CONTENT_CHANGED")) {
    throw new NoteReviewServiceError(409, "NOTE_REVIEW_CONTENT_CHANGED", "笔记内容已变化，请刷新后再评分。");
  }
  if (message.includes("NOTE_REVIEW_NOT_DUE")) {
    throw new NoteReviewServiceError(409, "NOTE_REVIEW_NOT_DUE", "这张笔记尚未到复习时间，请刷新后继续。");
  }
  if (message.includes("NOTE_REVIEW_IDEMPOTENCY_CONFLICT")) {
    throw new NoteReviewServiceError(409, "NOTE_REVIEW_IDEMPOTENCY_CONFLICT", "本次提交编号已用于另一种提交，请重新评分。");
  }
  if (message.includes("NOTE_REVIEW_INVALID_CARD")) {
    throw new NoteReviewServiceError(500, "NOTE_REVIEW_INVALID_CARD", "笔记复习状态暂时不可用，请稍后重试。");
  }
  throw new NoteReviewServiceError(500, "NOTE_REVIEW_DATABASE_ERROR", "笔记复习暂时不可用，请稍后重试。");
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}

function parseNoteId(value: string): string {
  const parsed = noteIdSchema.safeParse(value);
  if (!parsed.success) throw invalidInput("划词笔记标识无效。");
  return parsed.data;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NoteReviewServiceError(500, "NOTE_REVIEW_INVALID_RESPONSE", "笔记复习状态无法读取。");
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new NoteReviewServiceError(500, "NOTE_REVIEW_INVALID_RESPONSE", `笔记复习状态缺少 ${field}。`);
  }
  return parsed;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new NoteReviewServiceError(500, "NOTE_REVIEW_INVALID_RESPONSE", `笔记复习状态缺少 ${field}。`);
  }
  return new Date(value).toISOString();
}

export function cardToNoteReviewJson(card: Card): NoteReviewCardJson {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review?.toISOString() ?? null,
  };
}

export function cardFromNoteReviewJson(value: unknown): Card {
  const card = objectValue(value);
  const state = finiteNumber(card.state, "state");
  const due = isoDate(card.due, "due");
  const lastReview = card.last_review == null ? undefined : new Date(isoDate(card.last_review, "last_review"));
  return {
    due: new Date(due),
    stability: finiteNumber(card.stability, "stability"),
    difficulty: finiteNumber(card.difficulty, "difficulty"),
    elapsed_days: finiteNumber(card.elapsed_days, "elapsed_days"),
    scheduled_days: finiteNumber(card.scheduled_days, "scheduled_days"),
    learning_steps: finiteNumber(card.learning_steps, "learning_steps"),
    reps: finiteNumber(card.reps, "reps"),
    lapses: finiteNumber(card.lapses, "lapses"),
    state: state as State,
    ...(lastReview ? { last_review: lastReview } : {}),
  };
}

export function scheduleNoteReviewCard(
  card: Card,
  rating: NoteReviewRating,
  now = new Date(),
  enableFuzz = true,
): { card: Card; log: ReviewLog } {
  const scheduler = createFsrsScheduler(enableFuzz);
  const result = scheduler.next(card, now, ratingMap[rating]);
  return { card: result.card, log: result.log };
}

function noteIsEligible(note: NoteRow): boolean {
  return (note.status === "inbox" || note.status === "saved")
    && note.converted_user_word_id === null
    && note.note.trim().length > 0;
}

function parseStateResponse(value: unknown): NoteReviewStateResponse {
  const row = objectValue(value);
  const noteId = typeof row.note_id === "string" ? parseNoteId(row.note_id) : "";
  if (!noteId) throw new NoteReviewServiceError(500, "NOTE_REVIEW_INVALID_RESPONSE", "笔记复习状态无法读取。");
  const enabled = row.enabled === true;
  const revision = row.revision == null ? null : Math.max(0, Math.trunc(finiteNumber(row.revision, "revision")));
  const due = row.due == null ? null : isoDate(row.due, "due");
  const card = row.card == null ? null : cardToNoteReviewJson(cardFromNoteReviewJson(row.card));
  return {
    note_id: noteId,
    enabled,
    due,
    revision,
    card,
    ...(row.rating === "again" || row.rating === "good" ? { rating: row.rating } : {}),
    ...(typeof row.server_time === "string" ? { server_time: isoDate(row.server_time, "server_time") } : {}),
    ...(typeof row.replayed === "boolean" ? { replayed: row.replayed } : {}),
  };
}

async function loadNote(
  noteId: string,
  db: SupabaseClient,
  userId: string,
): Promise<NoteRow> {
  const result = await db.from("captured_notes")
    .select("id,selected_text,note,status,converted_user_word_id,updated_at")
    .eq("user_id", userId)
    .eq("id", noteId)
    .maybeSingle();
  if (result.error) databaseFailure(result.error);
  if (!result.data) throw new NoteReviewServiceError(404, "NOTE_REVIEW_NOT_FOUND", "这条划词笔记不存在或已被移除。");
  return result.data as NoteRow;
}

async function loadState(
  noteId: string,
  db: SupabaseClient,
  userId: string,
): Promise<NoteStateRow | null> {
  const result = await db.from("note_review_states")
    .select("captured_note_id,enabled,card,due,revision")
    .eq("user_id", userId)
    .eq("captured_note_id", noteId)
    .maybeSingle();
  if (result.error) databaseFailure(result.error);
  return result.data as NoteStateRow | null;
}

function stateCard(row: NoteStateRow): Card {
  return cardFromNoteReviewJson(row.card);
}

function mutationRequestState(value: unknown): NoteReviewStateResponse {
  const row = objectValue(value);
  const nested = row.result;
  return parseStateResponse(nested === undefined ? value : nested);
}

export async function listNoteReviews(
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
  now = new Date(),
): Promise<NoteReviewListResponse> {
  const result = await db.rpc("list_note_review_candidates_v1", {
    p_user_id: userId,
    p_now: now.toISOString(),
    p_limit: 10,
  });
  if (result.error) databaseFailure(result.error);
  const rows = (result.data ?? []) as CandidateRow[];
  const items: NoteReviewItem[] = rows.map((row) => ({
    note_id: parseNoteId(row.note_id),
    selected_text: row.selected_text,
    note: row.note,
    note_updated_at: isoDate(row.note_updated_at, "note_updated_at"),
    due: isoDate(row.due, "due"),
    revision: Math.max(0, Math.trunc(finiteNumber(row.revision, "revision"))),
    latest_occurrence: row.latest_context_text || row.latest_source_type || row.latest_source_title || row.latest_source_url
      ? {
        context_text: row.latest_context_text ?? "",
        source_type: row.latest_source_type ?? "manual",
        source_title: row.latest_source_title ?? null,
        source_url: row.latest_source_url ?? null,
        captured_at: isoDate(row.latest_captured_at, "captured_at"),
      }
      : null,
  }));
  const total = rows.length > 0 ? Math.max(0, Math.trunc(finiteNumber(rows[0]?.total_count, "total_count"))) : 0;
  return { items, total, as_of: now.toISOString() };
}

export async function setNoteReviewEnabled(
  id: string,
  input: unknown,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
  now = new Date(),
): Promise<NoteReviewStateResponse> {
  const noteId = parseNoteId(id);
  const value = parseInput(noteReviewEnabledRequestSchema, input);
  const initialCard = value.enabled ? createEmptyCard(now) : null;
  const result = await db.rpc("set_note_review_enabled_v1", {
    p_user_id: userId,
    p_captured_note_id: noteId,
    p_enabled: value.enabled,
    p_initial_card: initialCard ? cardToNoteReviewJson(initialCard) : null,
    p_now: now.toISOString(),
  });
  if (result.error) databaseFailure(result.error);
  return mutationRequestState(result.data);
}

export async function rateNoteReview(
  id: string,
  input: unknown,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
  now = new Date(),
): Promise<NoteReviewStateResponse> {
  const noteId = parseNoteId(id);
  const value = parseInput(noteReviewRatingRequestSchema, input);
  const expectedNoteUpdatedAt = new Date(value.expected_note_updated_at).toISOString();
  const [note, state] = await Promise.all([
    loadNote(noteId, db, userId),
    loadState(noteId, db, userId),
  ]);
  const currentCard = state ? stateCard(state) : null;
  let nextCard: Card | null = currentCard;
  if (currentCard && state?.enabled && noteIsEligible(note) && Date.parse(state.due) <= now.getTime()) {
    nextCard = scheduleNoteReviewCard(currentCard, value.rating, now).card;
  }
  const requestPayload = {
    note_id: noteId,
    rating: value.rating,
    expected_revision: value.expected_revision,
    expected_note_updated_at: expectedNoteUpdatedAt,
    idempotency_key: value.idempotency_key,
  };
  const result = await db.rpc("record_note_review_rating_v1", {
    p_user_id: userId,
    p_captured_note_id: noteId,
    p_rating: value.rating,
    p_expected_revision: value.expected_revision,
    p_expected_note_updated_at: expectedNoteUpdatedAt,
    p_idempotency_key: value.idempotency_key,
    p_request_payload: requestPayload,
    p_next_card: nextCard ? cardToNoteReviewJson(nextCard) : null,
    p_server_time: now.toISOString(),
  });
  if (result.error) databaseFailure(result.error);
  return mutationRequestState(result.data);
}
