import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { dateInTimeZone } from "./shared.js";
import { getUserTimeZone } from "./words.js";

export const captureSelectionTypeSchema = z.enum(["word", "phrase", "collocation", "sentence", "grammar"]);
export const captureStatusSchema = z.enum(["inbox", "saved", "dismissed", "converted"]);
export const captureSourceTypeSchema = z.enum(["lesson_example", "lesson_prompt", "review_question", "manual"]);

const captureCreateSchema = z.object({
  selected_text: z.string().trim().min(1).max(500),
  selection_type: captureSelectionTypeSchema,
  note: z.string().max(500).optional(),
  context_text: z.string().max(1200).optional(),
  source_type: captureSourceTypeSchema.default("manual"),
  source_ref: z.string().trim().max(256).optional(),
  source_title: z.string().trim().max(200).optional(),
  source_url: z.string().url().max(2000).optional(),
  idempotency_key: z.string().uuid(),
}).strict();

const capturePatchSchema = z.object({
  note: z.string().max(500).optional(),
  selection_type: captureSelectionTypeSchema.optional(),
  status: z.enum(["inbox", "saved", "dismissed"]).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "At least one field must be provided.");

const captureListSchema = z.object({
  status: z.enum(["inbox", "saved", "dismissed", "converted", "all"]).default("inbox"),
  q: z.string().trim().max(120).default(""),
  cursor: z.string().max(100).default("").transform((value, context) => {
    if (!value) return null;
    const separator = value.lastIndexOf("~");
    const updatedAt = separator > 0 ? value.slice(0, separator) : "";
    const id = separator > 0 ? value.slice(separator + 1) : "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(updatedAt)
      || !Number.isFinite(Date.parse(updatedAt)) || !z.string().uuid().safeParse(id).success) {
      context.addIssue({ code: "custom", message: "Invalid Notes cursor." });
      return z.NEVER;
    }
    return { updated_at: updatedAt, id };
  }),
}).strict();

export const captureLearningTermSchema = z.string().trim().min(1).max(100).refine(
  (term) => /^[\p{Script=Latin}\p{M}]+(?:[ '\u2019-][\p{Script=Latin}\p{M}]+)*$/u.test(term),
  "Only words and phrases made from letters, spaces, apostrophes, or hyphens can enter study.",
);

export function normalizeCaptureText(value: string): string {
  return normalizeCaptureDisplayText(value).toLowerCase();
}

export function normalizeCaptureDisplayText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export class CapturedNotesError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CapturedNotesError";
  }
}

const PAGE_SIZE = 25;

export interface CapturedNoteOccurrence {
  context_text: string;
  source_type: z.infer<typeof captureSourceTypeSchema>;
  source_title: string | null;
  source_url: string | null;
  captured_at: string;
}

export interface CapturedNote {
  id: string;
  selected_text: string;
  normalized_text: string;
  selection_type: z.infer<typeof captureSelectionTypeSchema>;
  note: string;
  status: z.infer<typeof captureStatusSchema>;
  converted_user_word_id: string | null;
  created_at: string;
  updated_at: string;
  occurrence_count: number;
  occurrences: CapturedNoteOccurrence[];
}

export interface CapturedNotePage {
  items: CapturedNote[];
  next_cursor: string | null;
}

export interface CaptureCreateInput {
  selected_text: string;
  selection_type: z.infer<typeof captureSelectionTypeSchema>;
  note?: string;
  context_text?: string;
  source_type?: z.infer<typeof captureSourceTypeSchema>;
  source_ref?: string;
  source_title?: string;
  source_url?: string;
  idempotency_key: string;
}

function invalidInput(message: string): CapturedNotesError {
  return new CapturedNotesError(400, "INVALID_CAPTURE_REQUEST", message);
}

function throwDatabaseError(error: { message?: string } | null): never {
  const message = error?.message ?? "";
  if (message.includes("CAPTURE_NOT_FOUND")) {
    throw new CapturedNotesError(404, "CAPTURE_NOT_FOUND", "这个 Notes 条目不存在。");
  }
  if (message.includes("CAPTURE_UNSUPPORTED_TYPE") || message.includes("CAPTURE_TERM_INVALID")) {
    throw new CapturedNotesError(422, "CAPTURE_NOT_CONVERTIBLE", "此条目目前只能保存在 Notes，不能加入学习卡。");
  }
  if (message.includes("CAPTURE_IDEMPOTENCY_CONFLICT")) {
    throw new CapturedNotesError(409, "CAPTURE_IDEMPOTENCY_CONFLICT", "本次记录请求编号已用于其他表达，请重新记录。");
  }
  if (message.includes("CAPTURE_LINK_INVALID")) {
    throw new CapturedNotesError(409, "CAPTURE_LINK_INVALID", "这个 Notes 条目关联的学习卡已不可用。");
  }
  throw new Error("CAPTURE_DATABASE_ERROR");
}

function sanitizedSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidInput("来源地址只能使用 HTTP 或 HTTPS。");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const safeUrl = `${url.origin}${url.pathname}`;
  if (safeUrl.length > 500) throw invalidInput("来源地址过长。");
  return safeUrl;
}

function validateId(value: string): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw invalidInput("Notes 条目标识无效。");
  return parsed.data;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidInput("Notes 请求内容无效或超出长度限制。");
  return result.data;
}

export async function listCapturedNotes(
  query: unknown,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<CapturedNotePage> {
  const filters = parsed(captureListSchema, query);
  const { data, error } = await db.rpc("list_captured_notes_v1", {
    p_user_id: userId,
    p_status: filters.status,
    p_query: filters.q,
    p_before_updated_at: filters.cursor?.updated_at ?? null,
    p_before_id: filters.cursor?.id ?? null,
    p_limit: PAGE_SIZE + 1,
  });
  if (error) throwDatabaseError(error);
  const rows = (data ?? []) as CapturedNote[];
  const items = rows.slice(0, PAGE_SIZE);
  return {
    items,
    next_cursor: rows.length > PAGE_SIZE && items.length > 0
      ? `${items[items.length - 1]?.updated_at}~${items[items.length - 1]?.id}`
      : null,
  };
}

export async function createCapturedNote(
  input: unknown,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ note_id: string; occurrence_count: number; new_occurrence: boolean }> {
  const value = parsed(captureCreateSchema, input);
  const normalizedText = normalizeCaptureText(value.selected_text);
  if (!normalizedText || normalizedText.length > 500) throw invalidInput("请先选择或输入一段文本。");
  const result = await db.rpc("create_captured_note_v1", {
    p_user_id: userId,
    p_selected_text: value.selected_text,
    p_normalized_text: normalizedText,
    p_selection_type: value.selection_type,
    p_note: value.note ?? "",
    p_context_text: value.context_text ?? "",
    p_source_type: value.source_type,
    p_source_ref: value.source_ref || null,
    p_source_title: value.source_title || null,
    p_source_url: sanitizedSourceUrl(value.source_url),
    p_idempotency_key: value.idempotency_key,
  });
  if (result.error) throwDatabaseError(result.error);
  return result.data as { note_id: string; occurrence_count: number; new_occurrence: boolean };
}

export async function updateCapturedNote(
  id: string,
  input: unknown,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ id: string }> {
  const noteId = validateId(id);
  const patch = parsed(capturePatchSchema, input);
  const lookup = await db.from("captured_notes")
    .select("id,status")
    .eq("user_id", userId)
    .eq("id", noteId)
    .maybeSingle();
  if (lookup.error) throwDatabaseError(lookup.error);
  if (!lookup.data) throw new CapturedNotesError(404, "CAPTURE_NOT_FOUND", "这个 Notes 条目不存在。");
  if (patch.status !== undefined && lookup.data.status === "converted") {
    throw new CapturedNotesError(409, "CAPTURE_STATUS_LOCKED", "已加入学习的条目不能改回其他状态。");
  }

  let updateQuery = db.from("captured_notes")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", noteId);
  if (patch.status !== undefined) updateQuery = updateQuery.neq("status", "converted");
  const update = await updateQuery.select("id").maybeSingle();
  if (update.error) throwDatabaseError(update.error);
  if (!update.data) {
    if (patch.status !== undefined) {
      throw new CapturedNotesError(409, "CAPTURE_STATUS_LOCKED", "已加入学习的条目不能改回其他状态。");
    }
    throw new CapturedNotesError(404, "CAPTURE_NOT_FOUND", "这个 Notes 条目不存在。");
  }
  return { id: noteId };
}

export async function promoteCapturedNote(
  id: string,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ note_id: string; normalized_word: string; is_new: boolean }> {
  const noteId = validateId(id);
  const lookup = await db.from("captured_notes")
    .select("id,selected_text,selection_type,converted_user_word_id")
    .eq("user_id", userId)
    .eq("id", noteId)
    .maybeSingle();
  if (lookup.error) throwDatabaseError(lookup.error);
  if (!lookup.data) throw new CapturedNotesError(404, "CAPTURE_NOT_FOUND", "这个 Notes 条目不存在。");
  if (lookup.data.converted_user_word_id) {
    return {
      note_id: noteId,
      normalized_word: normalizeCaptureText(lookup.data.selected_text as string),
      is_new: false,
    };
  }
  if (!(["word", "phrase", "collocation"] as string[]).includes(lookup.data.selection_type as string)) {
    throw new CapturedNotesError(422, "CAPTURE_NOT_CONVERTIBLE", "句子和语法条目目前只保存在 Notes。");
  }
  const displayText = normalizeCaptureDisplayText(lookup.data.selected_text as string);
  const term = captureLearningTermSchema.safeParse(displayText);
  if (!term.success) throw new CapturedNotesError(422, "CAPTURE_NOT_CONVERTIBLE", "这段表达不能作为当前学习词条，请先编辑为词或短语。");

  const date = dateInTimeZone(await getUserTimeZone(db, userId));
  const result = await db.rpc("promote_captured_note_v1", {
    p_user_id: userId,
    p_captured_note_id: noteId,
    p_import_date: date,
    p_display_text: displayText,
  });
  if (result.error) throwDatabaseError(result.error);
  const promotion = result.data as { note_id: string; normalized_word: string; is_new: boolean };
  return { note_id: promotion.note_id, normalized_word: promotion.normalized_word, is_new: promotion.is_new };
}
