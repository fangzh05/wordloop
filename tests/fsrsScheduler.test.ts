import { describe, expect, it } from "vitest";
import { fsrs, State } from "ts-fsrs";
import { cardFromUserWord, cardToDatabase, createFsrsScheduler, scheduleReview } from "../server/services/fsrsScheduler.js";
import type { UserWordRow } from "../server/types.js";

function row(overrides: Partial<UserWordRow> = {}): UserWordRow {
  return {
    id: "uw", user_id: "user", word_id: "word", status: "new", source: "test",
    first_seen_at: "2026-09-13T00:00:00.000Z", last_seen_at: "2026-09-13T00:00:00.000Z",
    last_reviewed_at: null, correct_count: 0, wrong_count: 0, consecutive_correct: 0,
    meaning_error: false, collocation_error: false, grammar_error: false,
    pronunciation_error: false, spelling_error: false, mastered: false,
    next_review_at: "2026-09-13T00:00:00.000Z", fsrs_stability: 0, fsrs_difficulty: 0,
    fsrs_elapsed_days: 0, fsrs_scheduled_days: 0, fsrs_learning_steps: 0,
    fsrs_reps: 0, fsrs_lapses: 0, fsrs_state: State.New, ...overrides,
  };
}

describe("FSRS v6 scheduler", () => {
  it("uses the one production long-term policy without changing retention, interval cap, or weights", () => {
    const scheduler = createFsrsScheduler();
    expect(scheduler.parameters).toMatchObject({
      request_retention: 0.9,
      maximum_interval: 36500,
      enable_short_term: false,
      enable_fuzz: true,
    });
    expect(scheduler.parameters.w).toEqual(fsrs().parameters.w);
  });

  it.each([
    ["again", 0.75, 1.5],
    ["hard", 1.5, 3],
    ["good", 2, 5],
    ["easy", 6, 14],
  ] as const)("schedules Fresh + %s at a day-scale interval with production fuzz", (rating, minDays, maxDays) => {
    const now = new Date("2026-09-13T00:00:00Z");
    const result = scheduleReview(row(), rating, now);
    const intervalDays = (result.card.due.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);

    expect(result.card.state).toBe(State.Review);
    expect(result.card.learning_steps).toBe(0);
    expect(result.card.reps).toBe(1);
    expect(result.card.due.getTime() - now.getTime()).toBeGreaterThan(6 * 60 * 60 * 1000);
    expect(intervalDays).toBeGreaterThanOrEqual(minDays);
    expect(intervalDays).toBeLessThanOrEqual(maxDays);
    expect(Number.isFinite(result.card.stability)).toBe(true);
    expect(Number.isFinite(result.card.difficulty)).toBe(true);
  });

  it("Good advances due and a later Again increments lapse", () => {
    let current = row();
    let at = new Date("2026-09-13T00:00:00Z");
    for (let step = 0; step < 3 && current.fsrs_state !== State.Review; step++) {
      const next = scheduleReview(current, "good", at, false);
      current = row({ ...cardToDatabase(next.card), status: "review" } as Partial<UserWordRow>);
      at = next.card.due;
    }
    expect(current.fsrs_state).toBe(State.Review);
    const beforeLapses = current.fsrs_lapses;
    const failed = scheduleReview(current, "again", at, false);
    expect(failed.card.lapses).toBe(beforeLapses + 1);
  });

  it("round-trips DB card fields without inventing legacy memory state", () => {
    const legacy = row({ next_review_at: "2026-10-01T00:00:00Z" });
    const card = cardFromUserWord(legacy);
    expect(card.state).toBe(State.New);
    expect(card.stability).toBe(0);
    expect(card.difficulty).toBe(0);
    expect(cardToDatabase(card).next_review_at).toBe("2026-10-01T00:00:00.000Z");
  });
});
