// These tests isolate the original flow; budget admission is exercised in learningBudget.test.ts.
vi.mock("../server/services/learningBudget.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/services/learningBudget.js")>(),
  getLearningBudget: vi.fn(async () => ({ date:"2026-10-02",daily_minutes:45,remaining_seconds:2700,estimated_used_seconds:0,due_count:0,overdue_count:0,new_word_cap:50,effective_new_limit:50,enabled:true,forecast:[] })),
  reserveLearningBudget: vi.fn(async () => undefined),
}));
import { describe, expect, it, vi } from "vitest";
import { recordPretestResult } from "../server/services/words.js";

describe("deterministic Pretest attempt persistence", () => {
  it("keeps a spelling near miss as correct with its spelling layer", async () => {
    const userWord = {
      id: "user-word-1",
      user_id: "user-1",
      word_id: "word-1",
      status: "new",
      source: "daily",
      first_seen_at: "2026-09-28T00:00:00.000Z",
      last_seen_at: "2026-09-28T00:00:00.000Z",
      last_reviewed_at: null,
      correct_count: 0,
      wrong_count: 0,
      consecutive_correct: 0,
      meaning_error: false,
      collocation_error: false,
      grammar_error: false,
      pronunciation_error: false,
      spelling_error: false,
      mastered: false,
      next_review_at: null,
      fsrs_stability: 0,
      fsrs_difficulty: 0,
      fsrs_elapsed_days: 0,
      fsrs_learning_steps: 0,
      fsrs_scheduled_days: 0,
      fsrs_reps: 0,
      fsrs_lapses: 0,
      fsrs_state: 0,
      word: { normalized_word: "alleviate" },
    };
    const originalAttempt = {
      id: "attempt-1",
      user_id: "user-1",
      word_id: "word-1",
      activity_type: "pretest_cn_to_en",
      user_answer: "aleviate",
      is_correct: false,
      error_layer: "none",
    };
    let savedAttempt: Record<string, unknown> = { ...originalAttempt };
    let rpcArgs: Record<string, unknown> | undefined;
    const db = {
      from(table: string) {
        let operation: "select" | "update" = "select";
        let update: Record<string, unknown> = {};
        const builder: Record<string, any> = {};
        builder.select = vi.fn(() => builder);
        builder.update = vi.fn((values: Record<string, unknown>) => {
          operation = "update";
          update = values;
          return builder;
        });
        builder.eq = vi.fn(() => builder);
        builder.gte = vi.fn(() => builder);
        builder.order = vi.fn(() => builder);
        builder.limit = vi.fn(() => builder);
        builder.single = vi.fn(async () => ({ data: userWord, error: null }));
        builder.maybeSingle = vi.fn(async () => {
          if (table !== "attempts") throw new Error(`unexpected maybeSingle on ${table}`);
          if (operation === "select") return { data: { id: originalAttempt.id }, error: null };
          savedAttempt = { ...savedAttempt, ...update };
          return { data: { id: savedAttempt.id }, error: null };
        });
        return builder;
      },
      rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        rpcArgs = args;
        return { data: { word: "alleviate", result: "uncertain" }, error: null };
      }),
    };

    await recordPretestResult({
      word: "alleviate",
      result: "uncertain",
      user_answer: "aleviate",
      activity_type: "pretest_cn_to_en",
    }, db as never, "user-1", "2026-09-28T00:00:00.000Z");

    expect(rpcArgs).toMatchObject({ p_result: "uncertain", p_user_answer: "aleviate" });
    expect(savedAttempt).toEqual({
      ...originalAttempt,
      is_correct: true,
      error_layer: "spelling",
    });
  });
});
