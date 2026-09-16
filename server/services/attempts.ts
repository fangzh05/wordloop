import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { RecordAttemptInput as SharedRecordAttemptInput } from "../../shared/toolContracts.js";
import { assertGradeInvariants, gradingRouteForDirection } from "../../web/src/grading/deterministic.js";
import { assertDatabaseResult } from "./shared.js";
import { normalizeWord } from "./wordNormalization.js";

export type RecordAttemptInput = SharedRecordAttemptInput;

export async function recordAttempt(input: RecordAttemptInput): Promise<Record<string, unknown>> {
  // Fail-closed gate: no attempt reaches durable state unless its verdict obeys
  // the grading invariants. Ordinary practice never advances FSRS, so it must
  // arrive without a rating. The tool input carries no graded_by claim of its
  // own, so the verdict's authority is derived from the route for this type:
  // that is what lets the gate reject a language-level error layer on a
  // deterministic question while leaving semantic questions unrestricted.
  const route = gradingRouteForDirection(input.activity_type, input.direction);
  assertGradeInvariants(
    {
      is_correct: input.is_correct,
      error_layer: input.error_layer,
      feedback: "",
      graded_by: route === "semantic" ? "semantic" : "deterministic",
    },
    { activity_type: input.activity_type, advancesFsrs: false, direction: input.direction },
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
