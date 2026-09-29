import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { RecordAttemptInput as SharedRecordAttemptInput } from "../../shared/toolContracts.js";
import { assertGradeInvariants, gradingRouteForDirection } from "../../web/src/grading/deterministic.js";
import { assertDatabaseResult, dateInTimeZone, localDateRange } from "./shared.js";
import { normalizeWord } from "./wordNormalization.js";
import { getUserTimeZone } from "./words.js";

export type RecordAttemptInput = SharedRecordAttemptInput;

export const LESSON_ACTIVITY_TYPES = [
  "exact_cloze",
  "cloze",
  "translation_cn_to_en",
  "translation_en_to_cn",
  "collocation",
  "derivation",
  "recall",
  "sentence",
  "spelling",
  "word_recall",
  "semantic_expression",
] as const;

interface LessonAttemptWordRow {
  word: { normalized_word: string } | Array<{ normalized_word: string }>;
}

/** Return normalized words with a formal Lesson attempt during the user's local day. */
export async function getTodayCompletedLessonWords(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  now = new Date(),
): Promise<Set<string>> {
  const timeZone = await getUserTimeZone(db, userId);
  const date = dateInTimeZone(timeZone, now);
  const { start, end } = localDateRange(date, timeZone);
  const { data, error } = await db
    .from("attempts")
    .select("word:words!inner(normalized_word)")
    .eq("user_id", userId)
    .gte("created_at", start)
    .lt("created_at", end)
    .in("activity_type", [...LESSON_ACTIVITY_TYPES]);
  assertDatabaseResult(error);

  const words = new Set<string>();
  for (const row of (data ?? []) as unknown as LessonAttemptWordRow[]) {
    const relation = Array.isArray(row.word) ? row.word[0] : row.word;
    const normalized = relation?.normalized_word ? normalizeWord(relation.normalized_word) : "";
    if (normalized) words.add(normalized);
  }
  return words;
}

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
