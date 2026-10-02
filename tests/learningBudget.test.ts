import { describe, expect, it, vi } from "vitest";
import { getLearningBudget, newWordAllowance, newWordForecast, reserveLearningBudget, LearningBudgetReached, type BudgetSnapshot } from "../server/services/learningBudget.js";
import { updateBkt, predictCorrect, predictionMetrics } from "../server/services/bkt.js";
import { plannedSkillEvidence } from "../server/services/plannedSubmission.js";
import type { LessonExercisePlan } from "../shared/toolContracts.js";

const budget: BudgetSnapshot = { date: "2026-10-02", daily_minutes: 45, extra_seconds: 0, estimated_used_seconds: 0, remaining_seconds: 2700, due_count: 0, overdue_count: 0, new_word_cap: 50, enabled: true, forecast: [] };
const plan: LessonExercisePlan = { plan_version: 1, plan_id: "00000000-0000-4000-8000-000000000001", exercise_id: "00000000-0000-4000-8000-000000000002", target_word_ids: ["00000000-0000-4000-8000-000000000003"], target_sense: "分配", scope: "lesson", planned_activity_type: "translation_cn_to_en", skill_ids: ["target_sense_retrieval", "verb_object_collocation"], skill_goal: "test", error_focus: null, hint_level: "meaning", estimated_seconds: 30, selection_reason: "test" };
const flags = { first_attempt: true, hint_used: false, answer_revealed: false, modified_correct: false };

describe("evidence learning contract", () => {
  it("separates a correct meaning from a wrong collocation, without rejecting Chinese prompts", () => {
    const evidence = plannedSkillEvidence({ plan, ...flags, overall_correct: false, skill_results: [{ skill_id: "target_sense_retrieval", outcome: "correct" }, { skill_id: "verb_object_collocation", outcome: "incorrect" }] });
    expect(evidence.map(e => [e.outcome, e.quality])).toEqual([["correct", "OBSERVE"], ["incorrect", "OBSERVE"]]);
  });
  it.each(["partial", "not_assessed"] as const)("never turns %s into a binary observation", outcome => {
    expect(plannedSkillEvidence({ plan, ...flags, skill_results: [{ skill_id: plan.skill_ids[0]!, outcome }] })[0]?.quality).toBe("IGNORE");
  });
  it.each([{ answer_revealed: true }, { hint_used: true }, { first_attempt: false, modified_correct: true }])("records assisted completion as exposure: %j", assisted => {
    expect(plannedSkillEvidence({ plan, ...flags, ...assisted, skill_results: [{ skill_id: plan.skill_ids[0]!, outcome: "correct" }] })[0]?.quality).toBe("LEARN_ONLY");
  });
  it("rejects foreign skills and contradictory duplicate labels", () => {
    for (const skill_results of [[{ skill_id: "invented", outcome: "correct" as const }], [{ skill_id: plan.skill_ids[0]!, outcome: "correct" as const }, { skill_id: plan.skill_ids[0]!, outcome: "incorrect" as const }]]) {
      expect(plannedSkillEvidence({ plan, ...flags, skill_results })[0]?.quality).toBe("IGNORE");
    }
  });
  it("does not infer unassessed skills from a semantic overall verdict", () => {
    expect(plannedSkillEvidence({ plan, ...flags, overall_correct: true }).every(e => e.quality === "IGNORE")).toBe(true);
  });
  it("visible target blocks recall but permits independent application", () => {
    const p = { ...plan, planned_activity_type: "sentence" as const, skill_ids: ["target_sense_retrieval", "target_word_application"] };
    const e = plannedSkillEvidence({ plan: p, ...flags, skill_results: p.skill_ids.map(skill_id => ({ skill_id, outcome: "correct" })) });
    expect(e.map(r => r.quality)).toEqual(["IGNORE", "OBSERVE"]);
  });
});
describe("fixed shadow BKT", () => {
  it("matches the Bayesian posterior and learning transition", () => {
    expect(updateBkt(.2, "OBSERVE", true)).toBeCloseTo((.18 / .34) * .9 + .1);
    expect(updateBkt(.2, "OBSERVE", false)).toBeCloseTo((.02 / .66) * .9 + .1);
    expect(updateBkt(.2, "LEARN_ONLY", null)).toBeCloseTo(.28);
    expect(updateBkt(.2, "IGNORE", null)).toBe(.2);
  });
  it("validates probabilities and binary observations", () => {
    expect(() => updateBkt(NaN, "OBSERVE", true)).toThrow();
    expect(() => updateBkt(.2, "OBSERVE", null)).toThrow();
    expect(predictCorrect(.2)).toBeCloseTo(.34);
  });
  it("reports empty calibration honestly and scores pre-observation probabilities", () => {
    expect(predictionMetrics([]).brier).toBeNull();
    expect(predictionMetrics([{ prediction: .8, correct: true }, { prediction: .2, correct: false }]).brier).toBeCloseTo(.04);
  });
});
describe("time budget admission", () => {
  it("stops new words for overdue cards and overloaded reviews", () => {
    expect(newWordAllowance({ ...budget, overdue_count: 1 })).toBe(0);
    expect(newWordAllowance({ ...budget, due_count: 338 })).toBe(0);
  });
  it("reserves study and consolidation costs and respects the word cap", () => {
    expect(newWordAllowance({ ...budget, new_word_cap: 3 })).toBe(3);
    expect(newWordAllowance({ ...budget, remaining_seconds: 76 })).toBe(0);
    expect(newWordAllowance(budget)).toBeLessThanOrEqual(Math.floor(2700 / 77));
  });
  it("future overload stops new admissions without touching input", () => {
    const input = { ...budget, forecast: [{ date: "2026-10-03", review_seconds: 2800 }] };
    const before = JSON.stringify(input); expect(newWordAllowance(input)).toBe(0); expect(JSON.stringify(input)).toBe(before);
    expect(newWordForecast(2)).toHaveLength(7);
    expect(newWordForecast(2)).toEqual(newWordForecast(2));
  });
  it("distinguishes budget rejection from database failure", async () => {
    const db = { rpc: vi.fn(async () => ({ data: false, error: null })) } as any;
    await expect(reserveLearningBudget("exercise:1", "translation_cn_to_en", "lesson", db, "u")).rejects.toBeInstanceOf(LearningBudgetReached);
    expect(db.rpc).toHaveBeenCalledWith("reserve_learning_budget_v1", expect.objectContaining({ p_seconds: 60 }));
    db.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    await expect(getLearningBudget(db, "u")).rejects.toThrow();
  });
});
