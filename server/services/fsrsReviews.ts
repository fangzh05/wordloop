import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { RecordReviewSubmissionInput } from "../../shared/toolContracts.js";
import type { ErrorLayer, FsrsRating, ReviewSource, UserWordRow } from "../types.js";
import { assertGradeInvariants, gradingRouteForDirection } from "../../web/src/grading/deterministic.js";
import { assertDatabaseResult } from "./shared.js";
import { normalizeWord } from "./wordNormalization.js";
import { cardToDatabase, reviewLogToDatabase, scheduleReview, stateName } from "./fsrsScheduler.js";

export function assertReviewCardDue(nextReviewAt: string | null, now = new Date()): void {
  const timestamp = nextReviewAt ? Date.parse(nextReviewAt) : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp > now.getTime()) {
    throw new Error("FSRS card is not due.");
  }
}

async function loadUserWord(word: string, db = getDatabase(), userId = getAuthenticatedUserId()): Promise<UserWordRow> {
  const { data: row, error: lookupError } = await db.from("user_words")
    .select("*,word:words!inner(normalized_word)")
    .eq("user_id", userId).eq("word.normalized_word", word).single();
  assertDatabaseResult(lookupError);
  return row as unknown as UserWordRow;
}

function reviewSummary(
  word: string,
  rating: FsrsRating,
  result: ReturnType<typeof scheduleReview>,
): Record<string, unknown> {
  return {
    word, rating, state: stateName(result.card.state),
    stability: result.card.stability, difficulty: result.card.difficulty,
    retrievability: result.retrievability, next_review_at: result.card.due.toISOString(),
    scheduled_days: result.card.scheduled_days,
  };
}

export async function recordReviewResult(input: {
  word: string;
  session_id?: string;
  rating: FsrsRating;
  source: Exclude<ReviewSource, "pretest">;
  reason?: string;
}, now = new Date(), enableFuzz = true): Promise<Record<string, unknown>> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const word = normalizeWord(input.word);
  const row = await loadUserWord(word, db, userId);
  assertReviewCardDue(row.next_review_at, now);
  const result = scheduleReview(row, input.rating, now, enableFuzz);
  const { error } = await db.rpc("record_review_result_v1", {
    p_user_id: userId, p_normalized_word: word, p_session_id: input.session_id ?? null,
    p_rating: result.log.rating, p_source: input.source, p_reason: input.reason ?? null,
    p_card: cardToDatabase(result.card), p_log: reviewLogToDatabase(result.log),
  });
  assertDatabaseResult(error);
  return reviewSummary(word, input.rating, result);
}

export async function recordReviewSubmission(input: RecordReviewSubmissionInput, now = new Date(), enableFuzz = true): Promise<Record<string, unknown>> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const word = normalizeWord(input.word);
  // The atomic due-review submission is the one path allowed to advance FSRS, so
  // it is the one path that must carry a rating — and that rating must agree with
  // the verdict. A failed retrieval rated Good here would silently corrupt the
  // review schedule, so the invariant gate runs before any write. The widget
  // tells us the card's actual direction: a cn_to_en card is a deterministic
  // recall verdict, an en_definition card is a semantic one, and the gate
  // applies the matching error-layer rules to each.
  const route = gradingRouteForDirection("review", input.direction);
  assertGradeInvariants(
    {
      is_correct: input.is_correct,
      error_layer: input.error_layer,
      rating: input.rating,
      feedback: "",
      graded_by: route === "semantic" ? "semantic" : "deterministic",
    },
    { activity_type: "review", advancesFsrs: true, reviewSubmission: true, direction: input.direction },
  );
  const row = await loadUserWord(word, db, userId);
  assertReviewCardDue(row.next_review_at, now);
  const result = scheduleReview(row, input.rating, now, enableFuzz);
  const { data, error } = await db.rpc("record_review_submission_v1", {
    p_user_id: userId,
    p_normalized_word: word,
    p_session_id: input.session_id ?? null,
    p_user_answer: input.user_answer,
    p_is_correct: input.is_correct,
    p_error_layer: input.error_layer,
    p_rating: result.log.rating,
    p_card: cardToDatabase(result.card),
    p_log: reviewLogToDatabase(result.log),
  });
  assertDatabaseResult(error);
  const persisted = data as { attempt?: unknown; review?: unknown } | null;
  const persistedReview = persisted?.review && typeof persisted.review === "object"
    ? persisted.review as Record<string, unknown>
    : {};
  return {
    attempt: persisted?.attempt ?? null,
    review: { ...reviewSummary(word, input.rating, result), ...persistedReview },
  };
}
