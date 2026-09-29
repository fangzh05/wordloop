import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  captureLearningTermSchema,
  createCapturedNote,
  listCapturedNotes,
  normalizeCaptureDisplayText,
  normalizeCaptureText,
  promoteCapturedNote,
  updateCapturedNote,
} from "../server/services/capturedNotes.js";

const userId = "00000000-0000-4000-8000-000000000001";
const noteId = "00000000-0000-4000-8000-000000000002";

describe("captured Notes service", () => {
  it("normalizes capture text without merging different word forms", () => {
    expect(normalizeCaptureText("  RECUR\t\n rent  ")).toBe("recur rent");
    expect(normalizeCaptureText("Cafe\u0301")).toBe("café");
    expect(normalizeCaptureDisplayText("  Cafe\u0301\t culture ")).toBe("Café culture");
    expect(normalizeCaptureText("recur")).not.toBe(normalizeCaptureText("recurrent"));
  });

  it("accepts bounded English terms and rejects sentences and non-Latin learning terms", () => {
    expect(captureLearningTermSchema.safeParse("take into account").success).toBe(true);
    expect(captureLearningTermSchema.safeParse(normalizeCaptureDisplayText("take   into account")).success).toBe(true);
    expect(captureLearningTermSchema.safeParse("learner’s permit").success).toBe(true);
    expect(captureLearningTermSchema.safeParse("a sentence, with punctuation.").success).toBe(false);
    expect(captureLearningTermSchema.safeParse("学习").success).toBe(false);
    expect(captureLearningTermSchema.safeParse(" ").success).toBe(false);
    expect(captureLearningTermSchema.safeParse("a".repeat(101)).success).toBe(false);
  });

  it("creates a note and idempotent occurrence through the capture RPC only", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { note_id: noteId, occurrence_count: 1, new_occurrence: true },
      error: null,
    });
    const db = { rpc } as unknown as SupabaseClient;

    const result = await createCapturedNote({
      selected_text: "  Café\t culture ",
      selection_type: "phrase",
      context_text: "A short source sentence.",
      source_type: "lesson_example",
      source_url: "https://example.test/lesson?token=secret#answer",
      idempotency_key: noteId,
    }, db, userId);

    expect(result.note_id).toBe(noteId);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("create_captured_note_v1", expect.objectContaining({
      p_user_id: userId,
      p_selected_text: "Café\t culture",
      p_normalized_text: "café culture",
      p_source_url: "https://example.test/lesson",
      p_idempotency_key: noteId,
    }));
    expect(Object.keys(db)).toEqual(["rpc"]);
  });

  it("rejects a client-supplied user id before making a database call", async () => {
    const rpc = vi.fn();
    const db = { rpc } as unknown as SupabaseClient;
    await expect(createCapturedNote({
      selected_text: "recur",
      selection_type: "word",
      idempotency_key: noteId,
      user_id: "00000000-0000-4000-8000-000000000099",
    }, db, userId)).rejects.toMatchObject({ code: "INVALID_CAPTURE_REQUEST", status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes validated user-scoped search and pagination to the list RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const db = { rpc } as unknown as SupabaseClient;
    const cursor = "2026-09-29T11:22:46.123Z~00000000-0000-4000-8000-000000000002";
    const page = await listCapturedNotes({ status: "all", q: "context", cursor }, db, userId);
    expect(page).toEqual({ items: [], next_cursor: null });
    expect(rpc).toHaveBeenCalledWith("list_captured_notes_v1", {
      p_user_id: userId,
      p_status: "all",
      p_query: "context",
      p_before_updated_at: "2026-09-29T11:22:46.123Z",
      p_before_id: noteId,
      p_limit: 26,
    });
  });

  it("rejects malformed page cursors before querying the database", async () => {
    const rpc = vi.fn();
    const db = { rpc } as unknown as SupabaseClient;
    await expect(listCapturedNotes({ cursor: "1~00000000-0000-4000-8000-000000000002" }, db, userId))
      .rejects.toMatchObject({ code: "INVALID_CAPTURE_REQUEST", status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not repeat a promotion after the note already links a learning card", async () => {
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: noteId, selected_text: "recur", selection_type: "word", converted_user_word_id: userId },
        error: null,
      }),
    };
    const rpc = vi.fn();
    const db = { from: vi.fn(() => builder), rpc } as unknown as SupabaseClient;
    const result = await promoteCapturedNote(noteId, db, userId);
    expect(result).toEqual({ note_id: noteId, normalized_word: "recur", is_new: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not overwrite a converted status if promotion wins a concurrent update", async () => {
    const lookup = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: noteId, status: "inbox" }, error: null }),
    };
    const update = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const from = vi.fn().mockReturnValueOnce(lookup).mockReturnValueOnce(update);
    const db = { from } as unknown as SupabaseClient;

    await expect(updateCapturedNote(noteId, { status: "dismissed" }, db, userId))
      .rejects.toMatchObject({ code: "CAPTURE_STATUS_LOCKED", status: 409 });
    expect(update.neq).toHaveBeenCalledWith("status", "converted");
  });
});
