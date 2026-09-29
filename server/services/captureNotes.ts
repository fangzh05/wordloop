import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { assertDatabaseResult } from "./shared.js";
import { importWords, prepareDailyNewWords } from "./words.js";
import { normalizeWord } from "./wordNormalization.js";

export type CaptureSelectionType = "word" | "phrase" | "sentence";
export type CaptureStatus = "inbox" | "saved" | "learning" | "archived";
export type CaptureSourceType = "lesson" | "review" | "pretest" | "dashboard" | "manual";

export interface CaptureNote {
  id: string;
  selected_text: string;
  normalized_text: string;
  selection_type: CaptureSelectionType;
  note: string;
  status: CaptureStatus;
  occurrence_count: number;
  linked_word_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  latest_occurrence: {
    context_text: string;
    source_type: CaptureSourceType;
    source_ref: string | null;
    created_at: string;
  } | null;
}

interface CaptureNoteRow extends Omit<CaptureNote, "latest_occurrence"> {}

const learnableWordPattern = /^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*)?$/u;

export function normalizeCaptureText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

export function inferCaptureSelectionType(value: string): CaptureSelectionType {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  const tokens = cleaned ? cleaned.split(" ") : [];
  if (tokens.length <= 1 && !/[.!?。！？;；:]$/u.test(cleaned)) return "word";
  if (tokens.length <= 7 && !/[.!?。！？]$/u.test(cleaned)) return "phrase";
  return "sentence";
}

async function ownedNote(
  id: string,
  db: SupabaseClient,
  userId: string,
): Promise<CaptureNoteRow> {
  const { data, error } = await db
    .from("capture_notes")
    .select("id,selected_text,normalized_text,selection_type,note,status,occurrence_count,linked_word_id,first_seen_at,last_seen_at,updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  assertDatabaseResult(error);
  if (!data) throw new Error("CAPTURE_NOT_FOUND");
  return data as CaptureNoteRow;
}

async function captureNoteById(
  id: string,
  db: SupabaseClient,
  userId: string,
): Promise<CaptureNote> {
  const row = await ownedNote(id, db, userId);
  const { data: occurrence, error } = await db
    .from("capture_note_occurrences")
    .select("context_text,source_type,source_ref,created_at")
    .eq("note_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertDatabaseResult(error);
  return {
    ...row,
    latest_occurrence: occurrence ? {
      context_text: String(occurrence.context_text ?? ""),
      source_type: occurrence.source_type as CaptureSourceType,
      source_ref: typeof occurrence.source_ref === "string" ? occurrence.source_ref : null,
      created_at: String(occurrence.created_at),
    } : null,
  };
}

async function counts(db: SupabaseClient, userId: string): Promise<Record<CaptureStatus, number>> {
  const statuses: CaptureStatus[] = ["inbox", "saved", "learning", "archived"];
  const values = await Promise.all(statuses.map(async (status) => {
    const { count, error } = await db
      .from("capture_notes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", status);
    assertDatabaseResult(error);
    return [status, count ?? 0] as const;
  }));
  return Object.fromEntries(values) as Record<CaptureStatus, number>;
}

export async function listCaptureNotes(
  input: { status?: CaptureStatus; limit?: number } = {},
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ items: CaptureNote[]; counts: Record<CaptureStatus, number> }> {
  const limit = Math.min(Math.max(input.limit ?? 80, 1), 200);
  let query = db
    .from("capture_notes")
    .select("id,selected_text,normalized_text,selection_type,note,status,occurrence_count,linked_word_id,first_seen_at,last_seen_at,updated_at")
    .eq("user_id", userId)
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (input.status) query = query.eq("status", input.status);

  const { data, error } = await query;
  assertDatabaseResult(error);
  const rows = (data ?? []) as CaptureNoteRow[];
  const ids = rows.map((row) => row.id);
  const latestByNote = new Map<string, CaptureNote["latest_occurrence"]>();

  if (ids.length > 0) {
    const { data: occurrences, error: occurrenceError } = await db
      .from("capture_note_occurrences")
      .select("note_id,context_text,source_type,source_ref,created_at")
      .in("note_id", ids)
      .order("created_at", { ascending: false });
    assertDatabaseResult(occurrenceError);
    for (const occurrence of occurrences ?? []) {
      const noteId = String(occurrence.note_id);
      if (latestByNote.has(noteId)) continue;
      latestByNote.set(noteId, {
        context_text: String(occurrence.context_text ?? ""),
        source_type: occurrence.source_type as CaptureSourceType,
        source_ref: typeof occurrence.source_ref === "string" ? occurrence.source_ref : null,
        created_at: String(occurrence.created_at),
      });
    }
  }

  return {
    items: rows.map((row) => ({ ...row, latest_occurrence: latestByNote.get(row.id) ?? null })),
    counts: await counts(db, userId),
  };
}

export async function createCaptureNote(input: {
  selected_text: string;
  context_text?: string;
  selection_type?: CaptureSelectionType;
  source_type?: CaptureSourceType;
  source_ref?: string | null;
}, db = getDatabase(), userId = getAuthenticatedUserId()): Promise<CaptureNote> {
  const selectedText = input.selected_text.replace(/\s+/gu, " ").trim();
  const normalizedText = normalizeCaptureText(selectedText);
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await db
    .from("capture_notes")
    .select("id,status,occurrence_count")
    .eq("user_id", userId)
    .eq("normalized_text", normalizedText)
    .maybeSingle();
  assertDatabaseResult(existingError);

  let id: string;
  if (existing) {
    id = String(existing.id);
    const status = existing.status === "archived" ? "inbox" : existing.status;
    const { error } = await db
      .from("capture_notes")
      .update({
        selected_text: selectedText,
        selection_type: input.selection_type ?? inferCaptureSelectionType(selectedText),
        occurrence_count: Number(existing.occurrence_count ?? 0) + 1,
        last_seen_at: now,
        status,
      })
      .eq("id", id)
      .eq("user_id", userId);
    assertDatabaseResult(error);
  } else {
    const { data, error } = await db
      .from("capture_notes")
      .insert({
        user_id: userId,
        selected_text: selectedText,
        normalized_text: normalizedText,
        selection_type: input.selection_type ?? inferCaptureSelectionType(selectedText),
        status: "inbox",
        occurrence_count: 1,
        first_seen_at: now,
        last_seen_at: now,
      })
      .select("id")
      .single();
    assertDatabaseResult(error);
    id = String(data.id);
  }

  const { error: occurrenceError } = await db
    .from("capture_note_occurrences")
    .insert({
      note_id: id,
      context_text: (input.context_text ?? "").slice(0, 4000),
      source_type: input.source_type ?? "manual",
      source_ref: input.source_ref ?? null,
    });
  assertDatabaseResult(occurrenceError);

  return captureNoteById(id, db, userId);
}

export async function updateCaptureNote(
  id: string,
  input: { note?: string; status?: CaptureStatus },
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<CaptureNote> {
  await ownedNote(id, db, userId);
  const patch: Record<string, unknown> = {};
  if (typeof input.note === "string") patch.note = input.note.slice(0, 2000);
  if (input.status) patch.status = input.status;
  if (Object.keys(patch).length > 0) {
    const { error } = await db.from("capture_notes").update(patch).eq("id", id).eq("user_id", userId);
    assertDatabaseResult(error);
  }
  return captureNoteById(id, db, userId);
}

export async function addCaptureNoteToLearning(
  id: string,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ note: CaptureNote; prepared: number; added: number }> {
  const capture = await ownedNote(id, db, userId);
  const text = capture.selected_text.replace(/\s+/gu, " ").trim();
  if (!learnableWordPattern.test(text)) throw new Error("CAPTURE_NOT_LEARNABLE");

  await importWords({ words: [text], source: "capture_notes" }, db, userId);
  const prepared = await prepareDailyNewWords(db, userId);
  const normalized = normalizeWord(text);
  const { data: word, error: wordError } = await db
    .from("words")
    .select("id")
    .eq("normalized_word", normalized)
    .maybeSingle();
  assertDatabaseResult(wordError);

  const { error } = await db
    .from("capture_notes")
    .update({ status: "learning", linked_word_id: word?.id ?? null })
    .eq("id", id)
    .eq("user_id", userId);
  assertDatabaseResult(error);

  const note = await updateCaptureNote(id, {}, db, userId);
  return { note, prepared: prepared.prepared, added: prepared.added };
}
