import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addOneGroupBudget, getAdaptiveBudgetPlan, getLearningBudget, newWordAllowance, newWordAdmissionLimit, newWordForecast, reserveLearningBudget, setAdaptiveExamGoal, LearningBudgetReached, type BudgetSnapshot } from "../server/services/learningBudget.js";
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
  beforeEach(() => vi.stubEnv("WORDLOOP_ADAPTIVE_DAILY_BUDGET_V2", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("pauses new words when due and overdue review exceeds capacity", () => {
    expect(newWordAllowance({ ...budget, overdue_count: 150, due_count: 1000 })).toBe(0);
    expect(newWordAllowance({ ...budget, due_count: 338 })).toBe(0);
  });
  it("counts prior new words and limits admission by remaining time and user cap", () => {
    const overdue = { ...budget, overdue_count: 1 };
    expect(newWordAdmissionLimit({ ...overdue, new_words_started_today: 5 })).toBe(6);
    expect(newWordAdmissionLimit({ ...overdue, new_words_started_today: 6 })).toBe(6);
    expect(newWordAdmissionLimit({ ...overdue, remaining_seconds: 76 })).toBe(0);
    expect(newWordAdmissionLimit({ ...overdue, remaining_seconds: 154 })).toBe(1);
    expect(newWordAdmissionLimit({ ...overdue, new_word_cap: 3 })).toBe(3);
    expect(newWordAllowance({ ...overdue, new_words_started_today: 5, remaining_seconds: 76 })).toBe(5);
    expect(newWordAdmissionLimit({ ...overdue, enabled: false })).toBe(6);
    expect(newWordAdmissionLimit({ ...overdue, enabled: false, new_word_cap: 3 })).toBe(3);
    expect(newWordAdmissionLimit({ ...overdue, enabled: false, new_word_cap: 3, new_words_started_today: 2 })).toBe(1);
  });
  it("uses the authenticated learner's calibrated costs when admitting new words", () => {
    const personal = { ...budget, overdue_count: 1, new_word_cap: 20, remaining_seconds: 300,
      cost_profile: { version: "personal-time-v2-pilot", costs: {}, review_seconds: 20, new_word_seconds: 150,
        new_word_source: "lifecycle_estimate" as const, new_word_samples: 20, new_word_confidence: "low" as const, updated_at: null } };
    expect(newWordAllowance(personal)).toBe(1);
    expect(newWordAllowance({ ...personal, cost_profile: undefined })).toBe(3);
  });
  it("reserves study and consolidation costs and respects the word cap", () => {
    expect(newWordAllowance({ ...budget, new_word_cap: 3 })).toBe(3);
    expect(newWordAllowance({ ...budget, remaining_seconds: 76 })).toBe(0);
    expect(newWordAllowance(budget)).toBeLessThanOrEqual(Math.floor(2700 / 77));
  });
  it("uses cumulative limits after a completed round", () => {
    expect(newWordAllowance({ ...budget, new_words_started_today: 20, remaining_seconds: 770 })).toBe(29);
    expect(newWordAdmissionLimit({ ...budget, new_words_started_today: 49 })).toBe(1);
    expect(newWordAdmissionLimit({ ...budget, new_words_started_today: 50 })).toBe(0);
  });
  it("future overload stops new admissions without touching input", () => {
    const input = { ...budget, forecast: [{ date: "2026-10-03", review_seconds: 2800 }] };
    const before = JSON.stringify(input); expect(newWordAllowance(input)).toBe(0); expect(JSON.stringify(input)).toBe(before);
    expect(newWordForecast(2)).toHaveLength(7);
    expect(newWordForecast(2)).toEqual(newWordForecast(2));
  });
  it("uses the unified cumulative target in actual next-round admission", () => {
    expect(newWordAdmissionLimit({ ...budget, effective_new_limit: 2, new_words_started_today: 1 })).toBe(1);
    expect(newWordAdmissionLimit({ ...budget, effective_new_limit: 0 })).toBe(0);
  });
  it("does not start new words after the user explicitly continues Review only", () => {
    expect(newWordAdmissionLimit({ ...budget, review_override: true, remaining_seconds: 0,
      estimated_used_seconds: 2700, effective_new_limit: 20, new_words_started_today: 3 })).toBe(0);
  });
  it("aligns future forecasts by local date and prefers review counts over stale static seconds", () => {
    const snapshot: BudgetSnapshot = { ...budget, date: "2026-10-02", new_word_cap: 0,
      forecast: [
        { date: "2026-10-02", review_count: 100, review_seconds: 800 },
        { date: "2026-10-03", review_count: 2, review_seconds: 1 },
        { date: "2026-10-04", review_seconds: 37 },
      ] };
    const p = getAdaptiveBudgetPlan(snapshot);
    expect(p.future_burden_normal.per_day_seconds[0]).toBe(16);
    expect(p.future_burden_normal.per_day_seconds[1]).toBe(37);
  });
  it("returns one V2 plan from the shared backend and supports flag rollback", async () => {
    const db = { rpc: vi.fn(async () => ({ data: budget, error: null })) } as any;
    vi.stubEnv("WORDLOOP_ADAPTIVE_DAILY_BUDGET_V2", "true");
    try {
      const result = await getLearningBudget(db, "user-a");
      expect(result.adaptive_plan?.recommended_new_words_total).toBe(result.effective_new_limit);
      expect(result.reason_codes).toContain("low_history_confidence");
      vi.stubEnv("WORDLOOP_ADAPTIVE_DAILY_BUDGET_V2", "false");
      expect((await getLearningBudget(db, "user-a")).adaptive_plan).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it("keeps the V1 fallback target cumulative so prior words are not subtracted twice", async () => {
    const snapshot = { ...budget, daily_minutes: 30, remaining_seconds: 300, new_words_started_today: 4 };
    const db = { rpc: vi.fn(async (name: string) => ({ data: name === "learning_budget_snapshot_v1" ? snapshot : true, error: null })) } as any;
    vi.stubEnv("WORDLOOP_ADAPTIVE_DAILY_BUDGET_V2", "false");
    vi.stubEnv("WORDLOOP_TIME_CALIBRATION_V2", "false");
    try {
      const result = await getLearningBudget(db, "user-a");
      expect(result.effective_new_limit).toBe(7);
      expect(newWordAdmissionLimit(result)).toBe(3);
    } finally { vi.unstubAllEnvs(); }
  });
  it("persists an implicitly selected legacy exam book before saving its goal", async () => {
    const snapshot = { ...budget, exam_goal: { book_id: "kaoyan", target_date: "2026-12-22", coverage_target: null } };
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === "set_adaptive_exam_goal_v2") return { data: calls.filter(([rpc]) => rpc === name).length > 1, error: null };
      if (name === "list_exam_books_v1") return { data: { selected_book_id: "kaoyan" }, error: null };
      if (name === "learning_budget_snapshot_v1") return { data: snapshot, error: null };
      return { data: { book_id: "kaoyan" }, error: null };
    }) } as any;

    await setAdaptiveExamGoal("2026-12-22", null, db, "user-a");

    expect(calls.map(([name]) => name)).toEqual([
      "set_adaptive_exam_goal_v2", "list_exam_books_v1", "set_exam_book_v1",
      "set_adaptive_exam_goal_v2", "learning_budget_snapshot_v1",
    ]);
    expect(calls[2]).toEqual(["set_exam_book_v1", { p_user_id: "user-a", p_book_id: "kaoyan" }]);
    expect(calls[3]).toEqual(["set_adaptive_exam_goal_v2", {
      p_user_id: "user-a", p_exam_deadline: "2026-12-22", p_coverage_target: null,
    }]);
  });
  it("keeps exam goal saving on the direct path for an explicitly selected book", async () => {
    const db = { rpc: vi.fn(async (name: string) => ({
      data: name === "set_adaptive_exam_goal_v2" ? true : budget,
      error: null,
    })) } as any;

    await setAdaptiveExamGoal(null, 500, db, "user-a");

    expect(db.rpc.mock.calls.map(([name]: [string]) => name)).toEqual([
      "set_adaptive_exam_goal_v2", "learning_budget_snapshot_v1",
    ]);
  });
  it("still requires a selected book when the server has no explicit or legacy default", async () => {
    const db = { rpc: vi.fn(async (name: string) => ({
      data: name === "set_adaptive_exam_goal_v2" ? false : { selected_book_id: null },
      error: null,
    })) } as any;

    await expect(setAdaptiveExamGoal(null, null, db, "user-a")).rejects.toThrow("EXAM_BOOK_REQUIRED");
    expect(db.rpc.mock.calls.map(([name]: [string]) => name)).toEqual([
      "set_adaptive_exam_goal_v2", "list_exam_books_v1",
    ]);
  });
  it("counts reserved task cost in the displayed estimated total, not measured time alone", async () => {
    // The snapshot charges max(reserved, actual) against remaining seconds and
    // excludes reserved Reviews from the plan's projections, so the displayed
    // total must start from the reserved-aware used value. Preferring
    // effective_used_seconds (measured only) would understate by reserved - actual.
    const snapshot = { ...budget, remaining_seconds: 1500,
      estimated_used_seconds: 1200, effective_used_seconds: 300,
      due_count: 0, overdue_count: 0, unreserved_due_count: 0, unreserved_overdue_count: 0,
      new_word_cap: 0, new_words_started_today: 0 };
    const db = { rpc: vi.fn(async (name: string) => ({ data: name === "learning_budget_snapshot_v1" ? snapshot : true, error: null })) } as any;
    vi.stubEnv("WORDLOOP_ADAPTIVE_DAILY_BUDGET_V2", "true");
    vi.stubEnv("WORDLOOP_TIME_CALIBRATION_V2", "false");
    try {
      const result = await getLearningBudget(db, "user-a");
      expect(result.estimated_review_seconds).toBe(0);
      expect(result.estimated_new_word_seconds).toBe(0);
      expect(result.estimated_total_seconds).toBe(1200);
    } finally { vi.unstubAllEnvs(); }
  });
  it("adds a calibrated group budget after the adaptive daily target is reached", async () => {
    const snapshot = { ...budget, remaining_seconds: 0, new_words_started_today: 9, new_word_cap: 20, due_count: 2 };
    const db = { rpc: vi.fn(async (name: string) => ({ data: name === "learning_budget_snapshot_v1" ? snapshot : true, error: null })) } as any;
    vi.stubEnv("WORDLOOP_ADAPTIVE_DAILY_BUDGET_V2", "true");
    vi.stubEnv("WORDLOOP_TIME_CALIBRATION_V2", "false");
    try {
      expect(await addOneGroupBudget("00000000-0000-4000-8000-0000000000AA", db, "user-a")).toBe(true);
      expect(db.rpc).toHaveBeenLastCalledWith("set_learning_budget_v1", {
        p_user_id: "user-a", p_minutes: null, p_add_key: "group:00000000-0000-4000-8000-0000000000AA:538",
      });
    } finally { vi.unstubAllEnvs(); }
  });
  it("includes validated feedback reading time in an exercise reservation", async () => {
    const row = { activity_type: "translation_cn_to_en", scope: "lesson", stage: "feedback",
      samples: 30, total_ms: 150000, histogram: { "1": 30 }, updated_at: "2026-10-02T00:00:00Z" };
    const db = { rpc: vi.fn(async (name: string) => ({ data: name === "user_learning_time_profile_v2" ? [row] : true, error: null })) } as any;
    vi.stubEnv("WORDLOOP_TIME_CALIBRATION_V2", "true");
    try {
      await reserveLearningBudget("exercise:feedback", "translation_cn_to_en", "lesson", db, "user-a");
      expect(db.rpc).toHaveBeenLastCalledWith("reserve_learning_budget_v1", {
        p_user_id: "user-a", p_task_key: "exercise:feedback", p_seconds: 67, p_activity: "translation_cn_to_en",
      });
    } finally { vi.unstubAllEnvs(); }
  });
  it("distinguishes budget rejection from database failure", async () => {
    const db = { rpc: vi.fn(async () => ({ data: false, error: null })) } as any;
    await expect(reserveLearningBudget("exercise:1", "translation_cn_to_en", "lesson", db, "u")).rejects.toBeInstanceOf(LearningBudgetReached);
    expect(db.rpc).toHaveBeenCalledWith("reserve_learning_budget_v1", expect.objectContaining({ p_seconds: 60 }));
    db.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    await expect(getLearningBudget(db, "u")).rejects.toThrow();
  });
});
