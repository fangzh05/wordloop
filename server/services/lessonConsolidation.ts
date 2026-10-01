import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { StudyState } from "../types.js";
import { lessonExercisePlanSchema, type LessonExercisePlan } from "../../shared/toolContracts.js";
import { assertDatabaseResult } from "./shared.js";

export type ConsolidationKind = "translation" | "translation_cn_to_en" | "sentence";

export interface PendingLessonTask {
  plan: LessonExercisePlan;
  kind: ConsolidationKind;
  target_words: string[];
}

function parsePendingTask(value: unknown): PendingLessonTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const plan = lessonExercisePlanSchema.safeParse(candidate.plan);
  const words = Array.isArray(candidate.target_words)
    ? candidate.target_words.filter((word): word is string => typeof word === "string" && word.trim().length > 0)
    : [];
  const kind = candidate.kind;
  if (!plan.success || plan.data.scope !== "consolidation" || words.length < 1 || words.length > 2
    || !["translation", "translation_cn_to_en", "sentence"].includes(String(kind))) return null;
  return { plan: plan.data, kind: kind as ConsolidationKind, target_words: words };
}

export async function getLessonCadence(
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ completion_credit: number; rotation_cursor: number; pending_task: PendingLessonTask | null }> {
  const { data, error } = await db.from("user_lesson_cadence")
    .select("completion_credit,rotation_cursor,pending_task")
    .eq("user_id", userId)
    .maybeSingle();
  assertDatabaseResult(error);
  if (!data) return { completion_credit: 0, rotation_cursor: 0, pending_task: null };
  return {
    completion_credit: Number(data.completion_credit ?? 0),
    rotation_cursor: Number(data.rotation_cursor ?? 0),
    pending_task: parsePendingTask(data.pending_task),
  };
}

function isFinalAcceptedLessonRound(state: StudyState): boolean {
  if (state.widget !== "lesson" || state.phase !== "lesson_complete" || state.payload.mode !== "feedback") return false;
  const queue = state.flow.lesson_words ?? [];
  const feedback = state.payload.feedback;
  if (queue.length === 0 || state.current_index !== queue.length - 1 || !state.current_word
    || state.current_word.toLocaleLowerCase() !== (queue[queue.length - 1] ?? "").toLocaleLowerCase()
    || typeof feedback !== "object" || feedback === null || Array.isArray(feedback)) return false;
  const verdict = feedback as Record<string, unknown>;
  return verdict.is_correct === true || verdict.reveal_answer === true;
}

/**
 * Attach the one durable pending task to a normal round's end once per task.
 * The cadence table owns credit, cursor, and pending state; no historical
 * round scan or wall-clock modulo participates in the rotation.
 */
export async function decideLessonConsolidation(
  state: StudyState,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudyState> {
  if (!isFinalAcceptedLessonRound(state) || state.payload.consolidation === true) return state;
  const { data, error } = await db.from("user_lesson_cadence")
    .select("pending_task,last_reminder_task_id")
    .eq("user_id", userId)
    .maybeSingle();
  assertDatabaseResult(error);
  const task = parsePendingTask(data?.pending_task);
  if (!task || data?.last_reminder_task_id === task.plan.exercise_id) return state;
  let reminderUpdate = db.from("user_lesson_cadence")
    .update({ last_reminder_task_id: task.plan.exercise_id, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  // PostgREST IS accepts null/booleans, not a UUID. Subsequent reminders
  // require equality against the previous UUID for the same CAS guard.
  reminderUpdate = data?.last_reminder_task_id == null
    ? reminderUpdate.is("last_reminder_task_id", null)
    : reminderUpdate.eq("last_reminder_task_id", data.last_reminder_task_id);
  const { error: updateError } = await reminderUpdate;
  assertDatabaseResult(updateError);
  return {
    ...state,
    payload: {
      ...state.payload,
      consolidation: true,
      consolidation_kind: task.kind,
      consolidation_trigger_round: 10,
      consolidation_target_words: task.target_words,
      consolidation_plan: task.plan,
      consolidation_status: "pending",
    },
  };
}
