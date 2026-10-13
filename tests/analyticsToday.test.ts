import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTodayOverview } from "../server/services/analytics.js";

const mocks = vi.hoisted(() => ({
  getTodayCompletedLessonWords: vi.fn(async () => new Set(["beta", "gamma"])),
  getUserTimeZone: vi.fn(async () => "Asia/Shanghai"),
}));

vi.mock("../server/services/attempts.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/services/attempts.js")>(),
  getTodayCompletedLessonWords: mocks.getTodayCompletedLessonWords,
}));

vi.mock("../server/services/words.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/services/words.js")>(),
  getUserTimeZone: mocks.getUserTimeZone,
}));

function queryBuilder(result: unknown) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq", "is", "order", "limit", "gte", "lt"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe("Today overview progress reuse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reuses its active and daily session rows for Review progress", async () => {
    const reviewItems = ["alpha", "beta", "gamma"].map(word => ({
      word,
      meaning_zh: "词义",
      direction: "cn_to_en" as const,
      error_layers: [],
      is_due: true,
      review_kind: "fsrs_due" as const,
      next_review_at: null,
    }));
    const activeSession = {
      id: "session-1",
      user_id: "user-1",
      started_at: "2026-10-14T00:00:00.000Z",
      ended_at: null,
      new_words_count: 0,
      review_words_count: 1,
      updated_at: "2026-10-14T00:01:00.000Z",
      widget: "review",
      phase: "review",
      current_index: 1,
      relearn_words: ["beta"],
      review_items: reviewItems,
    };
    const progressSnapshot = {
      today: { total: 8, known: 3, uncertain: 2, unknown: 3, completed: 5 },
      all_time: { total_words: 8, mastered: 0, learning: 8, error_book: 0 },
      fsrs: { due_now: 3, due_today: 3, tomorrow: 0, due_next_7_days: 3, average_stability: 2 },
      settings: { daily_new_word_limit: 20 },
    };
    let studySessionReads = 0;
    const from = vi.fn((table: string) => {
      if (table === "study_sessions") {
        studySessionReads += 1;
        return studySessionReads === 1
          ? queryBuilder({ data: activeSession, error: null })
          : queryBuilder({ data: [activeSession], error: null });
      }
      return queryBuilder({ data: null, count: 4, error: null });
    });
    const rpc = vi.fn(async () => ({ data: progressSnapshot, error: null }));
    const db = { from, rpc } as unknown as SupabaseClient;

    const result = await getTodayOverview(db, "user-1");

    expect(result.progress.review).toMatchObject({ completed: 1, total: 3, remaining: 2, scope: "active_session" });
    expect(result.progress.pretest).toEqual(progressSnapshot.today);
    expect(result.progress.formal_learning).toMatchObject({ completed_words: 2, new_words: 1, relearn_words: 1 });
    expect(result.captures.inbox_count).toBe(4);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("get_progress_snapshot_v1", expect.objectContaining({ p_user_id: "user-1" }));
    expect(from.mock.calls.filter(([table]) => table === "study_sessions")).toHaveLength(2);
  });
});
