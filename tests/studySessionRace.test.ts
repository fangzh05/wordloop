import { describe, expect, it, vi } from "vitest";
import { getOrCreateActiveStudySession, makeStudyState, persistStudyState } from "../server/services/studySessions.js";

const userId = "00000000-0000-4000-8000-000000000001";
const state = makeStudyState({
  date: "2026-09-15",
  widget: "lesson",
  phase: "lesson_explain",
  current_word: "plantation",
  current_index: 0,
  retry_count: 0,
  payload: { widget: "lesson", word: "plantation" },
});

function rawSession(): Record<string, unknown> {
  return {
    id: "winner",
    user_id: userId,
    started_at: "2026-09-15T00:00:00.000Z",
    ended_at: null,
    new_words_count: 0,
    review_words_count: 0,
    state,
    updated_at: "2026-09-15T00:00:00.000Z",
  };
}

function raceDb() {
  let activeReads = 0;
  const insertResult = { data: null, error: { code: "23505", message: "duplicate active session" } };
  const updateResult = { data: rawSession(), error: null };
  const db = {
    from: vi.fn((table: string) => {
      if (table !== "study_sessions") throw new Error(`unexpected table ${table}`);
      const builder: Record<string, any> = {};
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(async () => {
        activeReads += 1;
        return activeReads === 1 ? { data: null, error: null } : { data: rawSession(), error: null };
      });
      builder.insert = vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(async () => insertResult) })) }));
      builder.update = vi.fn(() => ({
        eq: vi.fn(function (this: any) { return this; }),
        is: vi.fn(function (this: any) { return this; }),
        select: vi.fn(() => ({ single: vi.fn(async () => updateResult) })),
      }));
      return builder;
    }),
  };
  return { db, getActiveReads: () => activeReads };
}

describe("active study-session insert race", () => {
  it("re-reads the winner once instead of surfacing the unique violation", async () => {
    const { db, getActiveReads } = raceDb();
    const result = await getOrCreateActiveStudySession(state, db as any, userId);
    expect(result.id).toBe("winner");
    expect(getActiveReads()).toBe(2);
  });

  it("persists state into the winner after a raced insert", async () => {
    const { db, getActiveReads } = raceDb();
    const result = await persistStudyState(state, db as any, userId);
    expect(result.id).toBe("winner");
    expect(getActiveReads()).toBe(2);
    expect(db.from).toHaveBeenCalledTimes(4);
  });
});
