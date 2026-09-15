import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ActivityType, ErrorLayer } from "../types.js";
import { assertGradeInvariants } from "../../web/src/grading/deterministic.js";
import { assertDatabaseResult } from "./shared.js";
import { normalizeWord } from "./wordNormalization.js";

export interface RecordAttemptInput {
  word: string;
  session_id?: string;
  activity_type: ActivityType;
  user_answer: string;
  is_correct: boolean;
  error_layer: ErrorLayer;
}

export async function recordAttempt(input: RecordAttemptInput): Promise<Record<string, unknown>> {
  // Fail-closed gate: no attempt reaches durable state unless its verdict obeys
  // the grading invariants. Ordinary practice never advances FSRS, so it must
  // arrive without a rating and its verdict must match the route for its type.
  assertGradeInvariants(
    { is_correct: input.is_correct, error_layer: input.error_layer, feedback: "", graded_by: "deterministic" },
    { activity_type: input.activity_type, advancesFsrs: false },
  );
  const { data, error } = await getDatabase().rpc("record_attempt_v2", {
    p_user_id: getAuthenticatedUserId(),
    p_normalized_word: normalizeWord(input.word),
    p_session_id: input.session_id ?? null,
    p_activity_type: input.activity_type,
    p_user_answer: input.user_answer,
    p_is_correct: input.is_correct,
    p_error_layer: input.error_layer,
  });
  assertDatabaseResult(error);
  return data as Record<string, unknown>;
}
