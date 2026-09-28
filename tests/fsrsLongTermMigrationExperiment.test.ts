import { describe, expect, it } from "vitest";
import { fsrs, Rating, State } from "ts-fsrs";
import {
  cardFromUserWord,
  createFsrsScheduler,
  scheduleReview,
} from "../server/services/fsrsScheduler.js";
import type { FsrsRating, UserWordRow } from "../server/types.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const SIX_HOURS = 6 * 60 * 60 * 1000;

function row(overrides: Partial<UserWordRow> = {}): UserWordRow {
  return {
    id: "user-word",
    user_id: "user",
    word_id: "word",
    status: "review",
    source: "test",
    first_seen_at: "2026-09-01T00:00:00.000Z",
    last_seen_at: "2026-09-28T12:00:00.000Z",
    last_reviewed_at: "2026-09-28T11:00:00.000Z",
    correct_count: 1,
    wrong_count: 0,
    consecutive_correct: 1,
    meaning_error: false,
    collocation_error: false,
    grammar_error: false,
    pronunciation_error: false,
    spelling_error: false,
    mastered: false,
    next_review_at: NOW.toISOString(),
    fsrs_stability: 5.2,
    fsrs_difficulty: 5.4,
    fsrs_elapsed_days: 10,
    fsrs_scheduled_days: 10,
    fsrs_learning_steps: 0,
    fsrs_reps: 8,
    fsrs_lapses: 2,
    fsrs_state: State.Review,
    ...overrides,
  };
}

const transitions: Array<{ name: string; card: UserWordRow; rating: FsrsRating }> = [
  {
    name: "Learning + Again",
    card: row({
      fsrs_state: State.Learning,
      fsrs_stability: 0.212,
      fsrs_difficulty: 6.4133,
      fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0,
      fsrs_learning_steps: 0,
      fsrs_reps: 1,
      fsrs_lapses: 0,
    }),
    rating: "again",
  },
  {
    name: "Learning + Good",
    card: row({
      fsrs_state: State.Learning,
      fsrs_stability: 2.3065,
      fsrs_difficulty: 2.11810397,
      fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0,
      fsrs_learning_steps: 1,
      fsrs_reps: 1,
      fsrs_lapses: 0,
    }),
    rating: "good",
  },
  {
    name: "Relearning + Again",
    card: row({
      fsrs_state: State.Relearning,
      fsrs_stability: 1.05557597,
      fsrs_difficulty: 8.47323965,
      fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0,
      fsrs_learning_steps: 0,
      fsrs_reps: 9,
      fsrs_lapses: 3,
    }),
    rating: "again",
  },
  {
    name: "Relearning + Good",
    card: row({
      fsrs_state: State.Relearning,
      fsrs_stability: 1.05557597,
      fsrs_difficulty: 8.47323965,
      fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0,
      fsrs_learning_steps: 0,
      fsrs_reps: 9,
      fsrs_lapses: 3,
    }),
    rating: "good",
  },
  { name: "Review + Again", card: row(), rating: "again" },
  { name: "Review + Good", card: row(), rating: "good" },
];

describe("global LongTermScheduler migration regressions", () => {
  it("uses one long-term production policy with existing retention, cap, fuzz, and weights", () => {
    const scheduler = createFsrsScheduler();
    expect(scheduler.parameters).toMatchObject({
      request_retention: 0.9,
      maximum_interval: 36500,
      enable_short_term: false,
      enable_fuzz: true,
    });
    expect(scheduler.parameters.w).toEqual(fsrs().parameters.w);
  });

  it.each(transitions)("continues $name at a day-scale interval without minute steps", ({ card, rating }) => {
    const previousState = card.fsrs_state;
    const result = scheduleReview(card, rating, NOW);
    const intervalMs = result.card.due.getTime() - NOW.getTime();

    expect(State[result.log.state]).toBe(State[previousState]);
    expect(State[result.card.state]).toBe("Review");
    expect(result.card.learning_steps).toBe(0);
    expect(result.card.scheduled_days).toBeGreaterThan(0);
    expect(intervalMs).toBeGreaterThan(SIX_HOURS);
    expect(Number.isFinite(result.card.stability)).toBe(true);
    expect(Number.isFinite(result.card.difficulty)).toBe(true);
    expect(result.card.difficulty).toBeGreaterThanOrEqual(1);
    expect(result.card.difficulty).toBeLessThanOrEqual(10);
  });

  it("keeps the known one-time Learning + Again lapse transition as FSRS output", () => {
    const learning = transitions[0]!.card;
    const legacyBasic = fsrs({
      request_retention: 0.9,
      maximum_interval: 36500,
      enable_short_term: true,
      learning_steps: ["1m", "10m"],
      relearning_steps: ["10m"],
      enable_fuzz: false,
    });
    const oldResult = legacyBasic.next(cardFromUserWord(learning), NOW, Rating.Again);
    const migratedResult = createFsrsScheduler(false).next(cardFromUserWord(learning), NOW, Rating.Again);

    expect(oldResult.card.lapses).toBe(learning.fsrs_lapses);
    expect(migratedResult.card.lapses).toBe(learning.fsrs_lapses + 1);
    expect(State[migratedResult.card.state]).toBe("Review");
  });
});
