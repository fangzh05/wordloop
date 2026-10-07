import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CaptureServiceError,
  addCaptureNoteToLearning,
  createCaptureNote,
  listCaptureNoteOccurrences,
  listCaptureNotes,
} from "../server/services/captureNotes.js";

const userId = "00000000-0000-4000-8000-000000000001";
const noteId = "00000000-0000-4000-8000-000000000002";
const occurrenceId = "00000000-0000-4000-8000-000000000003";

function queryBuilder(result: Record<string, unknown>): any {
  const query: Record<string, any> = {};
  for (const method of ["select", "eq", "neq", "is", "in", "or", "order", "limit", "update"]) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => result);
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return query;
}

function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: noteId,
    selected_text: "Café culture",
    normalized_text: "café culture",
    selection_type: "phrase",
    note: "",
    status: "inbox",
    converted_user_word_id: null,
    created_at: "2026-09-29T10:00:00.000Z",
    updated_at: "2026-09-29T10:05:00.000Z",
    ...overrides,
  };
}

describe("canonical Capture adapter", () => {
  it.each([true, false])("creates only through the RPC and carries new_occurrence=%s without leaking source credentials", async (newOccurrence) => {
    const rpc = vi.fn().mockResolvedValue({
      data: { note_id: noteId, occurrence_count: 1, new_occurrence: newOccurrence }, error: null,
    });
    const noteQuery = queryBuilder({ data: noteRow(), error: null });
    const occurrenceQuery = queryBuilder({
      data: [{
        id: occurrenceId, context_text: "A short sentence.", source_type: "manual",
        source_ref: null, source_title: "WordLoop · 预测试", source_url: "https://example.test/lesson",
        captured_at: "2026-09-29T10:05:00.000Z",
      }], count: 1, error: null,
    });
    const noteReviewQuery = queryBuilder({ data: [], error: null });
    const from = vi.fn((table: string) => {
      if (table === "captured_notes") return noteQuery;
      if (table === "captured_note_occurrences") return occurrenceQuery;
      if (table === "note_review_states") return noteReviewQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    const db = { rpc, from } as unknown as SupabaseClient;

    const result = await createCaptureNote({
      selected_text: " Cafe\u0301   culture ",
      context_text: "A short sentence.",
      source_type: "pretest",
      source_url: "https://user:pass@example.test/lesson?token=private#answer",
      idempotency_key: occurrenceId,
    }, db, userId);

    expect(rpc).toHaveBeenCalledExactlyOnceWith("create_captured_note_v1", expect.objectContaining({
      p_user_id: userId,
      p_selected_text: "Café   culture",
      p_normalized_text: "café culture",
      p_source_type: "manual",
      p_source_title: "WordLoop · 预测试",
      p_source_url: "https://example.test/lesson",
      p_idempotency_key: occurrenceId,
    }));
    expect(from.mock.calls.map(([table]) => table)).toEqual(["captured_notes", "captured_note_occurrences", "note_review_states"]);
    expect(result.user_word_id).toBeNull();
    expect(result.new_occurrence).toBe(newOccurrence);
    expect(occurrenceQuery.eq).toHaveBeenCalledWith("is_duplicate", false);
    expect(result.latest_occurrence?.created_at).toBe("2026-09-29T10:05:00.000Z");
  });

  it("rejects a missing idempotency key before touching the database", async () => {
    const rpc = vi.fn();
    const db = { rpc, from: vi.fn() } as unknown as SupabaseClient;
    await expect(createCaptureNote({ selected_text: "recur", selection_type: "word" }, db, userId))
      .rejects.toMatchObject({ code: "INVALID_CAPTURE_REQUEST", status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps phrases longer than two words in Capture without sending them to the learning queue", async () => {
    const noteQuery = queryBuilder({ data: noteRow({ selected_text: "to be attributed to", selection_type: "phrase" }), error: null });
    const rpc = vi.fn();
    const from = vi.fn(() => noteQuery);
    const db = { rpc, from } as unknown as SupabaseClient;
    await expect(addCaptureNoteToLearning(noteId, db, userId)).rejects.toMatchObject({
      code: "CAPTURE_NOT_CONVERTIBLE", status: 422,
    });
    expect(from).toHaveBeenCalledExactlyOnceWith("captured_notes");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses the canonical server search RPC, bounded cursor, and independently scoped status counts", async () => {
    const rows = [
      {
        ...noteRow(), occurrence_count: 4,
        occurrences: [{ context_text: "latest context", source_type: "review_question", source_title: null, source_url: null, captured_at: "2026-09-29T11:00:00Z" }],
      },
      {
        ...noteRow({ id: occurrenceId, updated_at: "2026-09-29T09:00:00Z", status: "converted", converted_user_word_id: "00000000-0000-4000-8000-000000000004" }),
        occurrence_count: 1,
        occurrences: [],
      },
    ];
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
    const countQueries: any[] = [];
    const userWords = queryBuilder({
      data: [{ id: "00000000-0000-4000-8000-000000000004", word_id: "00000000-0000-4000-8000-000000000005" }],
      error: null,
    });
    const from = vi.fn<(table: string) => any>((table) => {
      if (table === "user_words") return userWords;
      const query = queryBuilder({ count: 3, data: null, error: null });
      countQueries.push(query);
      return query;
    });
    const db = { rpc, from } as unknown as SupabaseClient;

    const result = await listCaptureNotes({ status: "learning", q: "culture", limit: 1 }, db, userId);

    expect(rpc).toHaveBeenCalledWith("list_captured_notes_v1", {
      p_user_id: userId,
      p_status: "converted",
      p_query: "culture",
      p_before_updated_at: null,
      p_before_id: null,
      p_limit: 2,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.occurrence_count).toBe(4);
    expect(result.items[0]?.latest_occurrence?.source_type).toBe("review_question");
    expect(result.next_cursor).toBe(`${result.items[0]?.updated_at}~${noteId}`);
    expect(result.counts).toEqual({ inbox: 3, saved: 3, learning: 3, archived: 3 });
  });

  it("returns not found for an occurrence request whose note is not owned by the caller", async () => {
    const owner = queryBuilder({ data: null, error: null });
    const from = vi.fn(() => owner);
    const db = { from } as unknown as SupabaseClient;

    await expect(listCaptureNoteOccurrences(noteId, {}, db, userId)).rejects.toMatchObject({
      code: "CAPTURE_NOT_FOUND", status: 404,
    } satisfies Partial<CaptureServiceError>);
    expect(from).toHaveBeenCalledExactlyOnceWith("captured_notes");
  });
});
