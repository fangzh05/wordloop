import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  captureCreateRequestSchema,
  captureListRequestSchema,
  captureStatusSchema,
  captureUpdateRequestSchema,
  toCanonicalCaptureSource,
  toCanonicalCaptureStatus,
  toCaptureStatus,
  type CaptureSelectionType,
  type CaptureSourceType,
  type CaptureStatus,
} from "../../shared/captureContracts.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { dateInTimeZone } from "./shared.js";
import { getUserTimeZone } from "./words.js";
import type { NoteReviewStateSummary } from "../../shared/noteReviewContracts.js";

export type { CaptureSelectionType, CaptureSourceType, CaptureStatus };

export interface CaptureOccurrence {
  context_text: string;
  source_type: string;
  source_ref: string | null;
  source_title: string | null;
  source_url: string | null;
  created_at: string;
}

export interface CaptureNote {
  id: string;
  selected_text: string;
  normalized_text: string;
  selection_type: string;
  note: string;
  status: CaptureStatus;
  occurrence_count: number;
  user_word_id: string | null;
  word_id: string | null;
  created_at: string;
  updated_at: string;
  first_seen_at: string;
  last_seen_at: string;
  latest_occurrence: CaptureOccurrence | null;
  occurrences: CaptureOccurrence[];
  note_review: NoteReviewStateSummary | null;
  new_occurrence?: boolean;
}

export interface CaptureCounts extends Record<CaptureStatus, number> {}

export interface CaptureListResponse {
  items: CaptureNote[];
  counts: CaptureCounts;
  next_cursor: string | null;
}

export interface CaptureOccurrencePage {
  items: CaptureOccurrence[];
  total: number;
  next_cursor: string | null;
}

export class CaptureServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CaptureServiceError";
  }
}

interface CanonicalCaptureRow {
  id: string;
  selected_text: string;
  normalized_text: string;
  selection_type: string;
  note: string;
  status: "inbox" | "saved" | "dismissed" | "converted";
  converted_user_word_id: string | null;
  created_at: string;
  updated_at: string;
  occurrence_count: number | string;
  occurrences: unknown;
}

interface CanonicalOccurrenceRow {
  id: string;
  context_text: string;
  source_type: string;
  source_ref: string | null;
  source_title: string | null;
  source_url: string | null;
  captured_at: string;
}

interface NoteReviewStateRow {
  captured_note_id: string;
  enabled: boolean;
  due: string;
  revision: number | string;
}

const canonicalStatuses = ["inbox", "saved", "dismissed", "converted"] as const;
const learningTermSchema = z.string().trim().min(1).max(100).refine(
  (term) => /^[\p{Script=Latin}\p{M}]+(?:[ '\u2019-][\p{Script=Latin}\p{M}]+)*$/u.test(term),
  "Only words and phrases made from letters, spaces, apostrophes, or hyphens can enter study.",
).refine((term) => term.split(/\s+/u).length <= 2, "Only a word or two-word phrase can enter study.");
const occurrencePageRequestSchema = z.object({
  cursor: z.string().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

function invalidInput(message = "划词笔记请求无效或超出长度限制。"): CaptureServiceError {
  return new CaptureServiceError(400, "INVALID_CAPTURE_REQUEST", message);
}

function databaseFailure(error: { message?: string } | null): never {
  const message = error?.message ?? "";
  if (message.includes("CAPTURE_NOT_FOUND")) {
    throw new CaptureServiceError(404, "CAPTURE_NOT_FOUND", "这条划词笔记不存在或已被移除。");
  }
  if (message.includes("CAPTURE_UNSUPPORTED_TYPE") || message.includes("CAPTURE_TERM_INVALID")) {
    throw new CaptureServiceError(422, "CAPTURE_NOT_CONVERTIBLE", "这段内容可以保存在划词笔记中，但不能加入现有单词学习队列。");
  }
  if (message.includes("CAPTURE_IDEMPOTENCY_CONFLICT")) {
    throw new CaptureServiceError(409, "CAPTURE_IDEMPOTENCY_CONFLICT", "本次记录编号已用于另一条笔记，请重新记录。");
  }
  if (message.includes("CAPTURE_LINK_INVALID")) {
    throw new CaptureServiceError(409, "CAPTURE_LINK_INVALID", "这条笔记关联的学习词条已不可用。");
  }
  throw new CaptureServiceError(500, "CAPTURE_DATABASE_ERROR", "划词笔记暂时不可用，请稍后重试。");
}

function safeParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}

function cleanDisplayText(value: string): string {
  return value.normalize("NFKC").trim();
}

export function normalizeCaptureText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

export function inferCaptureSelectionType(value: string): CaptureSelectionType {
  const cleaned = cleanDisplayText(value).replace(/\s+/gu, " ");
  const tokens = cleaned ? cleaned.split(" ") : [];
  if (tokens.length <= 1 && !/[.!?。！？;；:]$/u.test(cleaned)) return "word";
  if (tokens.length <= 7 && !/[.!?。！？]$/u.test(cleaned)) return "phrase";
  return "sentence";
}

function sanitizeSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput("来源地址格式无效。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidInput("来源地址只能使用 HTTP 或 HTTPS。");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const sanitized = `${url.origin}${url.pathname}`;
  if (sanitized.length > 500) throw invalidInput("来源地址过长。");
  return sanitized;
}

function decodeCursor(value: string): { updated_at: string; id: string } | null {
  if (!value) return null;
  const separator = value.lastIndexOf("~");
  const updatedAt = separator > 0 ? value.slice(0, separator) : "";
  const id = separator > 0 ? value.slice(separator + 1) : "";
  if (!Number.isFinite(Date.parse(updatedAt)) || !z.string().uuid().safeParse(id).success) {
    throw invalidInput("划词笔记分页游标无效。");
  }
  return { updated_at: new Date(updatedAt).toISOString(), id };
}

function decodeOccurrenceCursor(value: string): { captured_at: string; id: string } | null {
  if (!value) return null;
  const separator = value.lastIndexOf("~");
  const capturedAt = separator > 0 ? value.slice(0, separator) : "";
  const id = separator > 0 ? value.slice(separator + 1) : "";
  if (!Number.isFinite(Date.parse(capturedAt)) || !z.string().uuid().safeParse(id).success) {
    throw invalidInput("出现记录分页游标无效。");
  }
  return { captured_at: new Date(capturedAt).toISOString(), id };
}

function parseOccurrences(value: unknown): CaptureOccurrence[] {
  let occurrences = value;
  if (typeof occurrences === "string") {
    try { occurrences = JSON.parse(occurrences) as unknown; } catch { return []; }
  }
  if (!Array.isArray(occurrences)) return [];
  return occurrences.flatMap((entry): CaptureOccurrence[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const capturedAt = String(row.captured_at ?? row.created_at ?? "");
    if (!Number.isFinite(Date.parse(capturedAt))) return [];
    return [{
      context_text: typeof row.context_text === "string" ? row.context_text : "",
      source_type: typeof row.source_type === "string" ? row.source_type : "manual",
      source_ref: typeof row.source_ref === "string" ? row.source_ref : null,
      source_title: typeof row.source_title === "string" ? row.source_title : null,
      source_url: typeof row.source_url === "string" ? row.source_url : null,
      created_at: new Date(capturedAt).toISOString(),
    }];
  });
}

function occurrenceFromRow(row: CanonicalOccurrenceRow): CaptureOccurrence {
  return {
    context_text: row.context_text,
    source_type: row.source_type,
    source_ref: row.source_ref,
    source_title: row.source_title,
    source_url: row.source_url,
    created_at: row.captured_at,
  };
}

async function userWordIdsForRows(
  rows: readonly CanonicalCaptureRow[],
  db: SupabaseClient,
  userId: string,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.converted_user_word_id).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const result = await db.from("user_words").select("id,word_id").eq("user_id", userId).in("id", ids);
  if (result.error) databaseFailure(result.error);
  const links = new Map<string, string>((result.data ?? []).map((row: { id: string; word_id: string }) => [row.id, row.word_id]));
  if (ids.some((id) => !links.has(id))) {
    throw new CaptureServiceError(409, "CAPTURE_LINK_INVALID", "这条笔记关联的学习词条已不可用。");
  }
  return links;
}

function noteReviewSummary(row: NoteReviewStateRow): NoteReviewStateSummary {
  return {
    enabled: row.enabled,
    due: new Date(row.due).toISOString(),
    revision: Math.max(0, Math.trunc(Number(row.revision) || 0)),
  };
}

async function noteReviewStatesForRows(
  rows: readonly CanonicalCaptureRow[],
  db: SupabaseClient,
  userId: string,
): Promise<Map<string, NoteReviewStateSummary>> {
  const ids = [...new Set(rows.map((row) => row.id))];
  if (ids.length === 0) return new Map();
  const result = await db.from("note_review_states")
    .select("captured_note_id,enabled,due,revision")
    .eq("user_id", userId)
    .in("captured_note_id", ids);
  if (result.error) databaseFailure(result.error);
  return new Map(((result.data ?? []) as NoteReviewStateRow[]).map((row) => [row.captured_note_id, noteReviewSummary(row)]));
}

function modelFromRow(
  row: CanonicalCaptureRow,
  wordIds: Map<string, string>,
  noteReviewStates: Map<string, NoteReviewStateSummary>,
): CaptureNote {
  const occurrences = parseOccurrences(row.occurrences);
  const createdAt = row.created_at;
  return {
    id: row.id,
    selected_text: row.selected_text,
    normalized_text: row.normalized_text,
    selection_type: row.selection_type,
    note: row.note,
    status: toCaptureStatus(row.status),
    occurrence_count: Math.max(0, Number(row.occurrence_count) || 0),
    user_word_id: row.converted_user_word_id,
    word_id: row.converted_user_word_id ? wordIds.get(row.converted_user_word_id) ?? null : null,
    created_at: createdAt,
    updated_at: row.updated_at,
    first_seen_at: createdAt,
    last_seen_at: occurrences[0]?.created_at ?? row.updated_at,
    latest_occurrence: occurrences[0] ?? null,
    occurrences,
    note_review: noteReviewStates.get(row.id) ?? null,
  };
}

async function readOne(
  id: string,
  db: SupabaseClient,
  userId: string,
  occurrenceCount?: number,
): Promise<CaptureNote> {
  const result = await db.from("captured_notes")
    .select("id,selected_text,normalized_text,selection_type,note,status,converted_user_word_id,created_at,updated_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (result.error) databaseFailure(result.error);
  if (!result.data) throw new CaptureServiceError(404, "CAPTURE_NOT_FOUND", "这条划词笔记不存在或已被移除。");
  const [wordIds, occurrenceResult, noteReviewStates] = await Promise.all([
    userWordIdsForRows([{ ...result.data, occurrence_count: occurrenceCount ?? 0, occurrences: [] } as CanonicalCaptureRow], db, userId),
    db.from("captured_note_occurrences")
      .select("id,context_text,source_type,source_ref,source_title,source_url,captured_at", { count: "exact" })
      .eq("user_id", userId)
      .eq("captured_note_id", id)
      .order("captured_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(3),
    noteReviewStatesForRows([{ ...result.data, occurrence_count: occurrenceCount ?? 0, occurrences: [] } as CanonicalCaptureRow], db, userId),
  ]);
  if (occurrenceResult.error) databaseFailure(occurrenceResult.error);
  const occurrences = ((occurrenceResult.data ?? []) as CanonicalOccurrenceRow[]).map(occurrenceFromRow);
  const row = result.data as Omit<CanonicalCaptureRow, "occurrence_count" | "occurrences">;
  const model = modelFromRow({ ...row, occurrence_count: occurrenceCount ?? occurrenceResult.count ?? 0, occurrences }, wordIds, noteReviewStates);
  return model;
}

export async function getCaptureNoteById(
  id: string,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<CaptureNote> {
  const noteId = z.string().uuid().safeParse(id);
  if (!noteId.success) throw invalidInput("划词笔记标识无效。");
  return readOne(noteId.data, db, userId);
}

async function countCaptureStatuses(db: SupabaseClient, userId: string): Promise<CaptureCounts> {
  const counts = await Promise.all(canonicalStatuses.map(async (status) => {
    const result = await db.from("captured_notes").select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("status", status);
    if (result.error) databaseFailure(result.error);
    return [status, result.count ?? 0] as const;
  }));
  const canonical = Object.fromEntries(counts) as Record<typeof canonicalStatuses[number], number>;
  return {
    inbox: canonical.inbox,
    saved: canonical.saved,
    learning: canonical.converted,
    archived: canonical.dismissed,
  };
}

export async function listCaptureNotes(
  input: unknown = {},
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<CaptureListResponse> {
  const filters = safeParse(captureListRequestSchema, input);
  const cursor = decodeCursor(filters.cursor);
  const [result, counts] = await Promise.all([
    db.rpc("list_captured_notes_v1", {
      p_user_id: userId,
      p_status: filters.status ? toCanonicalCaptureStatus(filters.status) : "all",
      p_query: filters.q,
      p_before_updated_at: cursor?.updated_at ?? null,
      p_before_id: cursor?.id ?? null,
      p_limit: filters.limit + 1,
    }),
    countCaptureStatuses(db, userId),
  ]);
  if (result.error) databaseFailure(result.error);
  const rows = (result.data ?? []) as CanonicalCaptureRow[];
  const visibleRows = rows.slice(0, filters.limit);
  const [wordIds, noteReviewStates] = await Promise.all([
    userWordIdsForRows(visibleRows, db, userId),
    noteReviewStatesForRows(visibleRows, db, userId),
  ]);
  const items = visibleRows.map((row) => modelFromRow(row, wordIds, noteReviewStates));
  const last = items[items.length - 1];
  return {
    items,
    counts,
    next_cursor: rows.length > filters.limit && last ? `${last.updated_at}~${last.id}` : null,
  };
}

export async function createCaptureNote(
  input: unknown,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<CaptureNote & { new_occurrence: boolean }> {
  const value = safeParse(captureCreateRequestSchema, input);
  const selectedText = cleanDisplayText(value.selected_text);
  const normalizedText = normalizeCaptureText(selectedText);
  if (!selectedText || !normalizedText || selectedText.length > 500 || normalizedText.length > 500) {
    throw invalidInput("选中文本须为 1 到 500 字，系统不会截断内容。");
  }
  const legacySource = toCanonicalCaptureSource(value.source_type);
  const sourceUrl = sanitizeSourceUrl(value.source_url);
  const rpc = await db.rpc("create_captured_note_v1", {
    p_user_id: userId,
    p_selected_text: selectedText,
    p_normalized_text: normalizedText,
    p_selection_type: value.selection_type ?? inferCaptureSelectionType(selectedText),
    p_note: value.note ?? "",
    p_context_text: value.context_text ?? "",
    p_source_type: legacySource.source_type,
    p_source_ref: value.source_ref || null,
    p_source_title: value.source_title || legacySource.source_title,
    p_source_url: sourceUrl,
    p_idempotency_key: value.idempotency_key,
  });
  if (rpc.error) databaseFailure(rpc.error);
  const result = rpc.data as { note_id?: unknown; occurrence_count?: unknown; new_occurrence?: unknown } | null;
  if (typeof result?.note_id !== "string") throw new CaptureServiceError(500, "CAPTURE_INVALID_RESPONSE", "划词笔记保存结果无法读取。");
  const note = await readOne(result.note_id, db, userId, Number(result.occurrence_count) || 0);
  return { ...note, new_occurrence: result.new_occurrence === true };
}

export async function updateCaptureNote(
  id: string,
  input: unknown,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<CaptureNote> {
  const noteId = z.string().uuid().safeParse(id);
  if (!noteId.success) throw invalidInput("划词笔记标识无效。");
  const patch = safeParse(captureUpdateRequestSchema, input);
  const current = await db.from("captured_notes")
    .select("status,converted_user_word_id")
    .eq("user_id", userId)
    .eq("id", noteId.data)
    .maybeSingle();
  if (current.error) databaseFailure(current.error);
  if (!current.data) throw new CaptureServiceError(404, "CAPTURE_NOT_FOUND", "这条划词笔记不存在或已被移除。");

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.note !== undefined) update.note = patch.note;
  if (patch.selection_type !== undefined) update.selection_type = patch.selection_type;
  let expectedLinkedUserWordId: string | null | undefined;
  if (patch.status === "archived" || patch.status === "dismissed") {
    update.status = "dismissed";
  } else if (patch.status === "inbox") {
    expectedLinkedUserWordId = typeof current.data.converted_user_word_id === "string"
      ? current.data.converted_user_word_id
      : null;
    update.status = expectedLinkedUserWordId ? "converted" : "inbox";
  } else if (patch.status === "saved") {
    if (current.data.converted_user_word_id) {
      throw new CaptureServiceError(409, "CAPTURE_STATUS_LOCKED", "已连接词库的条目可归档，但不能改成普通收藏。");
    }
    expectedLinkedUserWordId = null;
    update.status = "saved";
  }
  let query = db.from("captured_notes").update(update).eq("user_id", userId).eq("id", noteId.data);
  if (expectedLinkedUserWordId === null) query = query.is("converted_user_word_id", null);
  if (typeof expectedLinkedUserWordId === "string") query = query.eq("converted_user_word_id", expectedLinkedUserWordId);
  const result = await query.select("id").maybeSingle();
  if (result.error) databaseFailure(result.error);
  if (!result.data) {
    const lookup = await db.from("captured_notes").select("status,converted_user_word_id").eq("user_id", userId).eq("id", noteId.data).maybeSingle();
    if (lookup.error) databaseFailure(lookup.error);
    if (!lookup.data) throw new CaptureServiceError(404, "CAPTURE_NOT_FOUND", "这条划词笔记不存在或已被移除。");
    if (lookup.data.status === "converted" || lookup.data.converted_user_word_id) {
      throw new CaptureServiceError(409, "CAPTURE_STATUS_LOCKED", "这条笔记已连接词库，状态刚刚发生变化；请刷新后重试。");
    }
    throw new CaptureServiceError(409, "CAPTURE_UPDATE_CONFLICT", "这条划词笔记刚刚发生变化，请刷新后重试。");
  }
  return readOne(noteId.data, db, userId);
}

export async function addCaptureNoteToLearning(
  id: string,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ note: CaptureNote; scheduled_today: boolean; existing_status: string | null }> {
  const noteId = z.string().uuid().safeParse(id);
  if (!noteId.success) throw invalidInput("划词笔记标识无效。");
  const lookup = await db.from("captured_notes")
    .select("id,selected_text,selection_type,converted_user_word_id")
    .eq("user_id", userId)
    .eq("id", noteId.data)
    .maybeSingle();
  if (lookup.error) databaseFailure(lookup.error);
  if (!lookup.data) throw new CaptureServiceError(404, "CAPTURE_NOT_FOUND", "这条划词笔记不存在或已被移除。");
  const allowedTypes = ["word", "phrase", "collocation"];
  if (!allowedTypes.includes(String(lookup.data.selection_type))) {
    throw new CaptureServiceError(422, "CAPTURE_NOT_CONVERTIBLE", "句子和语法笔记目前只保存在划词笔记中。");
  }
  const displayText = cleanDisplayText(String(lookup.data.selected_text));
  if (!learningTermSchema.safeParse(displayText).success) {
    throw new CaptureServiceError(422, "CAPTURE_NOT_CONVERTIBLE", "只有单词或支持的短语可以加入现有学习队列。");
  }
  const timeZone = await getUserTimeZone(db, userId);
  const date = dateInTimeZone(timeZone, new Date());
  const promotionResult = await db.rpc("promote_captured_note_v1", {
    p_user_id: userId,
    p_captured_note_id: noteId.data,
    p_import_date: date,
    p_display_text: displayText,
  });
  if (promotionResult.error) databaseFailure(promotionResult.error);
  const promotion = promotionResult.data as { user_word_id?: unknown; is_new?: unknown } | null;
  if (typeof promotion?.user_word_id !== "string") throw new CaptureServiceError(500, "CAPTURE_INVALID_RESPONSE", "加入学习的结果无法读取。");
  const linkedWord = await db.from("user_words").select("id,status,word_id")
    .eq("user_id", userId).eq("id", promotion.user_word_id).maybeSingle();
  if (linkedWord.error) databaseFailure(linkedWord.error);
  if (!linkedWord.data) throw new CaptureServiceError(409, "CAPTURE_LINK_INVALID", "这条笔记关联的学习词条已不可用。");
  const scheduledToday = promotion.is_new === true;
  return {
    note: await readOne(noteId.data, db, userId),
    scheduled_today: scheduledToday,
    existing_status: scheduledToday ? null : String(linkedWord.data.status),
  };
}

export async function listCaptureNoteOccurrences(
  id: string,
  input: unknown = {},
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<CaptureOccurrencePage> {
  const noteId = z.string().uuid().safeParse(id);
  if (!noteId.success) throw invalidInput("划词笔记标识无效。");
  const filters = safeParse(occurrencePageRequestSchema, input);
  const cursor = decodeOccurrenceCursor(filters.cursor);
  const owner = await db.from("captured_notes").select("id").eq("user_id", userId).eq("id", noteId.data).maybeSingle();
  if (owner.error) databaseFailure(owner.error);
  if (!owner.data) throw new CaptureServiceError(404, "CAPTURE_NOT_FOUND", "这条划词笔记不存在或已被移除。");
  const countQuery = db.from("captured_note_occurrences").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("captured_note_id", noteId.data);
  let pageQuery = db.from("captured_note_occurrences")
    .select("id,context_text,source_type,source_ref,source_title,source_url,captured_at")
    .eq("user_id", userId).eq("captured_note_id", noteId.data);
  if (cursor) {
    pageQuery = pageQuery.or(`captured_at.lt.${cursor.captured_at},and(captured_at.eq.${cursor.captured_at},id.lt.${cursor.id})`);
  }
  const [count, page] = await Promise.all([
    countQuery,
    pageQuery.order("captured_at", { ascending: false }).order("id", { ascending: false }).limit(filters.limit + 1),
  ]);
  if (count.error) databaseFailure(count.error);
  if (page.error) databaseFailure(page.error);
  const rows = (page.data ?? []) as CanonicalOccurrenceRow[];
  const visible = rows.slice(0, filters.limit).map(occurrenceFromRow);
  const last = visible[visible.length - 1];
  const lastRow = rows[visible.length - 1];
  return {
    items: visible,
    total: count.count ?? 0,
    next_cursor: rows.length > filters.limit && last && lastRow ? `${lastRow.captured_at}~${lastRow.id}` : null,
  };
}
