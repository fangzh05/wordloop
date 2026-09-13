import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { FsrsRating, ReviewSource, UserWordRow } from "../types.js";
import { assertDatabaseResult } from "./shared.js";
import { normalizeWord } from "./wordNormalization.js";
import { cardToDatabase, reviewLogToDatabase, scheduleReview, stateName } from "./fsrsScheduler.js";

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
  const { data: row, error: lookupError } = await db.from("user_words")
    .select("*,word:words!inner(normalized_word)")
    .eq("user_id", userId).eq("word.normalized_word", word).single();
  assertDatabaseResult(lookupError);
  const result = scheduleReview(row as unknown as UserWordRow, input.rating, now, enableFuzz);
  const { error } = await db.rpc("record_review_result_v1", {
    p_user_id: userId, p_normalized_word: word, p_session_id: input.session_id ?? null,
    p_rating: result.log.rating, p_source: input.source, p_reason: input.reason ?? null,
    p_card: cardToDatabase(result.card), p_log: reviewLogToDatabase(result.log),
  });
  assertDatabaseResult(error);
  return {
    word, rating: input.rating, state: stateName(result.card.state),
    stability: result.card.stability, difficulty: result.card.difficulty,
    retrievability: result.retrievability, next_review_at: result.card.due.toISOString(),
    scheduled_days: result.card.scheduled_days,
  };
}
