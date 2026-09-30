import type { ActiveErrorLayer, LessonProfile } from "../../shared/toolContracts.js";
import type { WordStatus } from "../types.js";

export type { LessonProfile } from "../../shared/toolContracts.js";
export type LessonErrorFocus = ActiveErrorLayer | null;

export interface LessonProfileInput {
  status: WordStatus;
  is_relearn: boolean;
  error_layers: readonly ActiveErrorLayer[];
}

export interface DerivedLessonProfile {
  lesson_profile: LessonProfile;
  error_focus: LessonErrorFocus;
}

/** Choose one exercise profile from the current durable learning state. */
export function deriveLessonProfile(input: LessonProfileInput): DerivedLessonProfile {
  const errorFocus = input.error_layers[0] ?? null;
  if (input.is_relearn || errorFocus) {
    return { lesson_profile: "targeted_relearn", error_focus: errorFocus };
  }
  if (input.status === "uncertain") return { lesson_profile: "quick_recall", error_focus: null };
  if (input.status === "unknown" || input.status === "new") {
    return { lesson_profile: "reinforce", error_focus: null };
  }

  // A frozen queue can outlive a live status change from another client. If
  // there is no active error signal, keep that queued word light.
  return { lesson_profile: "quick_recall", error_focus: null };
}
