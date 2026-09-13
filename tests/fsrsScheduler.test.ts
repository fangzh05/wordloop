import { describe, expect, it } from "vitest";
import { State } from "ts-fsrs";
import { cardFromUserWord, cardToDatabase, scheduleReview } from "../server/services/fsrsScheduler.js";
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
  for (const rating of ["again", "hard", "good", "easy"] as const) {
    it(`schedules New + ${rating}`, () => {
      const result = scheduleReview(row(), rating, new Date("2026-09-13T00:00:00Z"), false);
      expect(result.card.reps).toBe(1);
      expect(result.card.due.getTime()).toBeGreaterThan(Date.parse("2026-09-13T00:00:00Z"));
    });
  }

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
