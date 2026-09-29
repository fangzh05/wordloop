import { describe, expect, it } from "vitest";
import { memorySummary, reviewSummaryAndTrend } from "../server/services/analytics.js";
import type { UserWordRow } from "../server/types.js";

function row(overrides: Partial<UserWordRow> = {}): UserWordRow {
  return {
    id: "user-word", user_id: "user", word_id: "word", status: "review", source: "test",
    first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-01T00:00:00Z",
    last_reviewed_at: "2026-09-29T00:00:00Z", correct_count: 0, wrong_count: 0,
    consecutive_correct: 0, meaning_error: false, collocation_error: false,
    grammar_error: false, pronunciation_error: false, spelling_error: false,
    mastered: false, next_review_at: "2026-10-01T00:00:00Z", fsrs_stability: 5,
    fsrs_difficulty: 5, fsrs_elapsed_days: 1, fsrs_scheduled_days: 7,
    fsrs_learning_steps: 0, fsrs_reps: 2, fsrs_lapses: 0, fsrs_state: 2,
    ...overrides,
  };
}

describe("analytics metrics", () => {
  it("uses only valid scheduled memory values and reports exclusions instead of zero-filling", () => {
    const asOf = new Date("2026-09-30T00:43:56+08:00");
    const scheduler = { get_retrievability: () => 0.8 } as unknown as ReturnType<typeof import("../server/services/fsrsScheduler.js")["createFsrsScheduler"]>;
    const summary = memorySummary([
      row({ fsrs_stability: 5.2408, fsrs_difficulty: 6.69 }),
      row({ id: "second", word_id: "second", fsrs_stability: 5.2408, fsrs_difficulty: 6.69 }),
      row({ id: "bad", word_id: "bad", fsrs_stability: Number.NaN }),
      row({ id: "zero", word_id: "zero", fsrs_stability: 0 }),
      row({ id: "invalid-d", word_id: "invalid-d", fsrs_stability: 5.2408, fsrs_difficulty: Number.NaN }),
    ], asOf, scheduler);

    expect(summary.scheduled_word_count).toBe(5);
    expect(summary.excluded_count).toBe(3);
    expect(summary.stability_days.mean).toBeCloseTo(5.2408);
    expect(summary.stability_days.median).toBeCloseTo(5.2408);
    expect(summary.difficulty.mean).toBeCloseTo(5.845);
    expect(summary.retrievability_below_target_count).toBeGreaterThanOrEqual(0);
    expect(summary.scatter.points).toHaveLength(2);
    expect(summary.retrievability_count).toBe(3);
    expect(summary.retrievability_missing_count).toBe(2);
    expect(memorySummary([], asOf, scheduler).stability_days.mean).toBeNull();
  });

  it("aggregates rolling recall from numerators and denominators, not daily percentages", () => {
    const rows = [
      { local_date: "2026-09-29", first_review_count: 3, eligible_count: 2, successes: 1, failures: 1, invalid_rating_count: 0, below_interval_count: 1 },
      { local_date: "2026-09-30", first_review_count: 4, eligible_count: 1, successes: 1, failures: 0, invalid_rating_count: 1, below_interval_count: 2 },
    ];
    const result = reviewSummaryAndTrend(rows, new Date("2026-09-30T00:43:56+08:00"), "Asia/Shanghai", 7);
    expect(result.summary).toMatchObject({ samples: 3, passes: 2, failures: 1, invalid_ratings: 1, below_interval_first_reviews: 3, success_rate: 2 / 3, small_sample: true, as_of_note: "今日截至当前" });
    expect(result.trend.at(-1)?.rolling_7d).toMatchObject({ samples: 3, passes: 2, rate: 2 / 3 });
  });
});
