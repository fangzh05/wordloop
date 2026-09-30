import type { LessonExercisePlan, SkillEvidence } from "../../shared/toolContracts.js";

export function plannedSkillEvidence(input: {
  plan: LessonExercisePlan;
  skill_results?: Array<{ skill_id: string; word_id?: string; outcome: "correct" | "incorrect" | "partial" | "not_assessed"; evidence?: string }>;
  first_attempt: boolean;
  hint_used: boolean;
  answer_revealed: boolean;
  modified_correct: boolean;
  deterministic_outcome?: "correct" | "incorrect";
}): SkillEvidence[] {
  const evidenceFor = (
    skill_id: string,
    result: NonNullable<typeof input.skill_results>[number] | undefined,
  ): SkillEvidence => {
    const wordId = result?.word_id
      ? input.plan.target_word_ids.includes(result.word_id) ? result.word_id : undefined
      : input.plan.target_word_ids.length === 1 ? input.plan.target_word_ids[0] : undefined;
    const outcome = result?.outcome ?? (input.plan.skill_ids.length === 1 && input.deterministic_outcome
      ? input.deterministic_outcome : "not_assessed");
    const unpromptedTask = input.plan.hint_level === "none"
      && input.plan.scope !== "consolidation"
      && input.plan.planned_activity_type !== "sentence"
      && input.plan.planned_activity_type !== "translation_en_to_cn";
    return {
      skill_id,
      ...(wordId ? { word_id: wordId } : {}),
      outcome,
      first_unprompted: input.first_attempt && !input.hint_used && unpromptedTask,
      hint_used: input.hint_used,
      modified_correct: input.modified_correct && outcome === "correct",
      answer_revealed: input.answer_revealed,
      ...(result?.evidence ? { evidence: result.evidence } : {}),
    };
  };

  const output: SkillEvidence[] = [];
  for (const skill_id of input.plan.skill_ids) {
    // Keep one record per skill/word pair. A Map keyed only by skill_id would
    // silently discard evidence when a multiword task assesses the same skill
    // for more than one target.
    const matching = (input.skill_results ?? []).filter((item) => item.skill_id === skill_id
      && (!item.word_id || input.plan.target_word_ids.includes(item.word_id)));
    if (matching.length) {
      output.push(...matching.map((item) => evidenceFor(skill_id, item)));
    } else {
      output.push(evidenceFor(skill_id, undefined));
    }
  }
  return output;
}
