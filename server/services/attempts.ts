import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ActivityType, ErrorLayer } from "../types.js";
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
  const { data, error } = await getDatabase().rpc("record_attempt_v1", {
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

