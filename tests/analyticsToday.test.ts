import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTodayOverview } from "../server/services/analytics.js";
import { dateInTimeZone, localDateRange } from "../server/services/shared.js";

const mocks = vi.hoisted(() => ({
  getTodayCompletedLessonWords: vi.fn(async (_db?: unknown, _userId?: string, _now?: Date, _timeZone?: string, _range?: { start: string; end: string }) => new Set(["beta", "gamma"])),
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

function queryBuilder(result: unknown, calls: unknown[][] = []) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq", "is", "order", "limit", "gte", "lt"]) {
    builder[method] = (...args: unknown[]) => { calls.push([method, ...args]); return builder; };
  }
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe("Today overview progress reuse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses durable formal Review logs while reusing session rows for relearn counts", async () => {
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
    const queryCalls: unknown[][] = [];
    const from = vi.fn((table: string) => {
      if (table === "study_sessions") {
        studySessionReads += 1;
        if (studySessionReads === 1) return queryBuilder({ data: activeSession, error: null }, queryCalls);
        if (studySessionReads === 2) return queryBuilder({ data: [activeSession], error: null }, queryCalls);
        return queryBuilder({ data: [{ id: activeSession.id, review_items: reviewItems }], error: null }, queryCalls);
      }
      return queryBuilder({ data: null, count: 4, error: null }, queryCalls);
    });
    const rpc = vi.fn(async () => ({ data: progressSnapshot, error: null }));
    const db = { from, rpc } as unknown as SupabaseClient;

    const result = await getTodayOverview(db, "user-1");

    expect(result.progress.review).toMatchObject({ completed: 4, total: 7, remaining: 3, scope: "today_recorded_sessions" });
    expect(result.progress.pretest).toEqual(progressSnapshot.today);
    expect(result.progress.formal_learning).toMatchObject({ completed_words: 2, new_words: 1, relearn_words: 1 });
    expect(result.progress.due_now).toBe(3);
    expect(result.captures.inbox_count).toBe(4);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("get_progress_snapshot_v1", expect.objectContaining({ p_user_id: "user-1" }));
    const [, , asOf, timeZone, range] = mocks.getTodayCompletedLessonWords.mock.calls[0]!;
    expect(range).toEqual(localDateRange(dateInTimeZone(timeZone!, asOf!), timeZone!));
    expect(from.mock.calls.filter(([table]) => table === "study_sessions")).toHaveLength(2);
    expect(from.mock.calls.filter(([table]) => table === "fsrs_review_logs")).toHaveLength(1);
    expect(queryCalls).toContainEqual(["eq", "review_source", "review"]);
    expect(queryCalls).toContainEqual(["select", "id", { count: "exact", head: true }]);
  });

  it("loads Review snapshots selectively and retains completed Review counts after later stages", async () => {
    const reviewItems = ["alpha", "beta", "gamma"].map(word => ({ word, review_kind: "fsrs_due" }));
    const sessionRows = [
      { id: "review-1", review_words_count: 1, widget: "review", phase: "review_complete", current_index: 3, relearn_words: [] },
      { id: "lesson-1", review_words_count: 2, widget: "lesson", phase: "lesson_explain", current_index: 0, relearn_words: ["beta"] },
    ];
    let studySessionReads = 0;
    const queryCalls: unknown[][] = [];
    const from = vi.fn((table: string) => {
      if (table === "study_sessions") {
        studySessionReads += 1;
        if (studySessionReads === 1) return queryBuilder({ data: null, error: null }, queryCalls);
        if (studySessionReads === 2) return queryBuilder({ data: sessionRows, error: null }, queryCalls);
        return queryBuilder({ data: [{ id: "review-1", review_items: reviewItems }], error: null }, queryCalls);
      }
      return queryBuilder({ data: null, count: table === "fsrs_review_logs" ? 5 : 0, error: null }, queryCalls);
    });
    const progressSnapshot = {
      today: { total: 0, known: 0, uncertain: 0, unknown: 0, completed: 0 },
      all_time: { total_words: 0, mastered: 0, learning: 0, error_book: 0 },
      fsrs: { due_now: 0, due_today: 0, tomorrow: 0, due_next_7_days: 0, average_stability: 0 },
      settings: { daily_new_word_limit: 20 },
    };
    const rpc = vi.fn(async () => ({ data: progressSnapshot, error: null }));

    const result = await getTodayOverview({ from, rpc } as unknown as SupabaseClient, "user-1");

    expect(result.progress.review).toEqual({ completed: 5, total: 5, remaining: 0, scope: "today_recorded_sessions" });
    expect(from.mock.calls.filter(([table]) => table === "study_sessions")).toHaveLength(2);
    expect(from.mock.calls.filter(([table]) => table === "fsrs_review_logs")).toHaveLength(1);
    expect(queryCalls).toContainEqual(["eq", "review_source", "review"]);
  });
});
