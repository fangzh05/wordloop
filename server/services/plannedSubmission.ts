import type { LessonExercisePlan, SkillEvidence } from "../../shared/toolContracts.js";

import { EVIDENCE_VERSION, isSkillId } from "../../shared/learningEvidence.js";

export function plannedSkillEvidence(input: {
  plan: LessonExercisePlan;
  skill_results?: Array<{ skill_id: string; word_id?: string; outcome: "correct" | "incorrect" | "partial" | "not_assessed"; evidence?: string }>;
  first_attempt: boolean;
  hint_used: boolean;
  answer_revealed: boolean;
  modified_correct: boolean;
  overall_correct?: boolean;
  deterministic_error_layer?: string;
  deterministic_outcome?: "correct" | "incorrect";
}): SkillEvidence[] {
  const evidenceFor = (
    skill_id: string,
    result: NonNullable<typeof input.skill_results>[number] | undefined,
  ): SkillEvidence => {
    const wordId = result?.word_id
      ? input.plan.target_word_ids.includes(result.word_id) ? result.word_id : undefined
      : input.plan.target_word_ids.length === 1 ? input.plan.target_word_ids[0] : undefined;
    const deterministic = input.deterministic_outcome;
    const inferred = !deterministic ? "not_assessed"
      : input.plan.skill_ids.length === 1 ? deterministic
      : skill_id === "target_word_spelling" ? input.deterministic_error_layer === "spelling" ? "incorrect" : deterministic === "correct" ? "correct" : "not_assessed"
      : skill_id === "target_sense_retrieval" ? input.deterministic_error_layer === "spelling" ? "not_assessed" : deterministic
      : "not_assessed";
    const outcome = result?.outcome ?? inferred;
    const visibleTarget = ["sentence", "semantic_expression", "translation_en_to_cn"].includes(input.plan.planned_activity_type);
    const retrieval = ["target_sense_retrieval", "target_word_spelling"].includes(skill_id);
    const invalid = !isSkillId(skill_id) ? "unknown_skill"
      : (input.skill_results ?? []).some(r => !input.plan.skill_ids.includes(r.skill_id) || (r.word_id && !input.plan.target_word_ids.includes(r.word_id))) ? "out_of_plan"
      : input.plan.target_word_ids.length > 1 && !wordId && !["syntactic_word_use", "sentence_structure", "relative_clause_attachment", "concession_scope"].includes(skill_id) ? "ambiguous_target"
      : (input.skill_results ?? []).some(r => r.skill_id === skill_id && r.word_id === result?.word_id && r.outcome !== result?.outcome) ? "conflicting_labels"
      : input.overall_correct === true && outcome === "incorrect" && input.deterministic_error_layer !== "spelling" ? "contradictory_verdict"
      : "";
    const unpromptedTask = !(visibleTarget && retrieval) && input.plan.hint_level !== "guided";
    const reason = invalid || (outcome === "not_assessed" || outcome === "partial" ? outcome
      : visibleTarget && retrieval ? "visible_target"
      : input.answer_revealed ? "answer_revealed"
      : input.modified_correct ? "modified_correct"
      : input.hint_used || input.plan.hint_level === "guided" ? "assisted"
      : !input.first_attempt ? "repeat_attempt" : "first_independent");
    const quality = invalid || ["not_assessed", "partial", "visible_target"].includes(reason) ? "IGNORE"
      : reason === "first_independent" ? "OBSERVE"
      : input.answer_revealed || outcome === "correct" ? "LEARN_ONLY" : "IGNORE";
    return {
      skill_id,
      quality, quality_reason: reason, evidence_version: EVIDENCE_VERSION,
      ...(wordId ? { word_id: wordId } : {}),
      outcome,
      first_unprompted: input.first_attempt && !input.hint_used && !input.answer_revealed && unpromptedTask,
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
      const unique = new Map(matching.map(item => [item.word_id ?? "", item]));
      output.push(...[...unique.values()].map((item) => evidenceFor(skill_id, item)));
    } else {
      output.push(evidenceFor(skill_id, undefined));
    }
  }
  return output;
}
