import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card,
  type Grade,
  type ReviewLog,
} from "ts-fsrs";
import type { FsrsRating, UserWordRow } from "../types.js";

const parameters = {
  request_retention: 0.90,
  maximum_interval: 36500,
  enable_short_term: true,
  learning_steps: ["1m", "10m"] as const,
  relearning_steps: ["10m"] as const,
};

export function createFsrsScheduler(enableFuzz = true) {
  return fsrs({ ...parameters, enable_fuzz: enableFuzz });
}

export const ratingMap: Record<FsrsRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export function cardFromUserWord(row: UserWordRow): Card {
  const empty = createEmptyCard(row.next_review_at ? new Date(row.next_review_at) : new Date());
  return {
    ...empty,
    due: row.next_review_at ? new Date(row.next_review_at) : empty.due,
    last_review: row.last_reviewed_at ? new Date(row.last_reviewed_at) : undefined,
    stability: row.fsrs_stability ?? 0,
    difficulty: row.fsrs_difficulty ?? 0,
    elapsed_days: row.fsrs_elapsed_days ?? 0,
    scheduled_days: row.fsrs_scheduled_days ?? 0,
    learning_steps: row.fsrs_learning_steps ?? 0,
    reps: row.fsrs_reps ?? 0,
    lapses: row.fsrs_lapses ?? 0,
    state: (row.fsrs_state ?? State.New) as State,
  };
}

export function cardToDatabase(card: Card): Record<string, unknown> {
  return {
    fsrs_stability: card.stability,
    fsrs_difficulty: card.difficulty,
    fsrs_elapsed_days: card.elapsed_days,
    fsrs_scheduled_days: card.scheduled_days,
    fsrs_learning_steps: card.learning_steps,
    fsrs_reps: card.reps,
    fsrs_lapses: card.lapses,
    fsrs_state: card.state,
    next_review_at: card.due.toISOString(),
    last_reviewed_at: card.last_review?.toISOString() ?? null,
  };
}

export function reviewLogToDatabase(log: ReviewLog): Record<string, unknown> {
  return {
    rating: log.rating,
    state: log.state,
    due: log.due.toISOString(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsed_days: log.elapsed_days,
    last_elapsed_days: log.last_elapsed_days,
    scheduled_days: log.scheduled_days,
    learning_steps: log.learning_steps,
    reviewed_at: log.review.toISOString(),
  };
}

export function scheduleReview(row: UserWordRow, rating: FsrsRating, now = new Date(), enableFuzz = true) {
  const scheduler = createFsrsScheduler(enableFuzz);
  const result = scheduler.next(cardFromUserWord(row), now, ratingMap[rating]);
  return {
    ...result,
    retrievability: scheduler.get_retrievability(result.card, now, false),
  };
}

export function stateName(state: State): "New" | "Learning" | "Review" | "Relearning" {
  return State[state] as "New" | "Learning" | "Review" | "Relearning";
}
