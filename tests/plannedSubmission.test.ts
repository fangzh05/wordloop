import { describe, expect, it } from "vitest";
import type { LessonExercisePlan } from "../shared/toolContracts.js";
import { plannedSkillEvidence } from "../server/services/plannedSubmission.js";

const wordA = "00000000-0000-4000-8000-000000000001";
const wordB = "00000000-0000-4000-8000-000000000002";

function plan(overrides: Partial<LessonExercisePlan> = {}): LessonExercisePlan {
  return {
    plan_version: 1,
    plan_id: "00000000-0000-4000-9000-000000000001",
    exercise_id: "00000000-0000-4000-9000-000000000002",
    scope: "lesson",
    target_word_ids: [wordA, wordB],
    target_sense: "按语境学习目标义",
    planned_activity_type: "translation_cn_to_en",
    skill_goal: "使用目标义及搭配翻译",
    error_focus: null,
    skill_ids: ["verb_object_collocation", "relative_clause_attachment"],
    hint_level: "meaning",
    estimated_seconds: 38,
    selection_reason: "固定测试计划",
    ...overrides,
  };
}

describe("planned skill evidence", () => {
  it("keeps activity type separate and does not turn an overall grade into evidence for every skill", () => {
    const evidence = plannedSkillEvidence({
      plan: plan(),
      skill_results: [{ skill_id: "verb_object_collocation", word_id: wordA, outcome: "incorrect", evidence: "目标词缺少宾语搭配" }],
      first_attempt: true,
      hint_used: false,
      answer_revealed: false,
      modified_correct: false,
      deterministic_outcome: "incorrect",
    });
    expect(evidence).toEqual([
      expect.objectContaining({ skill_id: "verb_object_collocation", word_id: wordA, outcome: "incorrect" }),
      expect.objectContaining({ skill_id: "relative_clause_attachment", outcome: "not_assessed" }),
    ]);
    expect(evidence[0]?.first_unprompted).toBe(true);
    expect(evidence[1]?.modified_correct).toBe(false);
  });

  it("retains separate word-linked evidence when one skill appears for multiple targets", () => {
    const evidence = plannedSkillEvidence({
      plan: plan({ skill_ids: ["verb_object_collocation"] }),
      skill_results: [
        { skill_id: "verb_object_collocation", word_id: wordA, outcome: "correct", evidence: "自然使用 allocate resources" },
        { skill_id: "verb_object_collocation", word_id: wordB, outcome: "incorrect", evidence: "搭配不成立" },
      ],
      first_attempt: false,
      hint_used: true,
      answer_revealed: false,
      modified_correct: true,
    });
    expect(evidence).toEqual([
      expect.objectContaining({ word_id: wordA, outcome: "correct", modified_correct: true, hint_used: true }),
      expect.objectContaining({ word_id: wordB, outcome: "incorrect", modified_correct: false, hint_used: true }),
    ]);
  });

  it("leaves an unlinked multiword structural skill at task scope instead of assigning it to the anchor word", () => {
    const evidence = plannedSkillEvidence({
      plan: plan({ skill_ids: ["relative_clause_attachment"] }),
      skill_results: [{ skill_id: "relative_clause_attachment", outcome: "incorrect", evidence: "修饰范围错误" }],
      first_attempt: true,
      hint_used: false,
      answer_revealed: false,
      modified_correct: false,
    });
    expect(evidence[0]).toMatchObject({ skill_id: "relative_clause_attachment", outcome: "incorrect" });
    expect(evidence[0]?.word_id).toBeUndefined();
  });

  it("marks visible-target contextual sentence work as prompted application, not unprompted recall", () => {
    const evidence = plannedSkillEvidence({
      plan: plan({
        scope: "consolidation",
        target_word_ids: [wordA],
        planned_activity_type: "sentence",
        skill_ids: ["target_word_application"],
        hint_level: "context",
      }),
      skill_results: [{ skill_id: "target_word_application", word_id: wordA, outcome: "correct" }],
      first_attempt: true,
      hint_used: false,
      answer_revealed: false,
      modified_correct: false,
    });
    expect(evidence[0]).toMatchObject({ outcome: "correct", first_unprompted: true });
  });
});
