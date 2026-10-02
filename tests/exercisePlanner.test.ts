import { describe, expect, it } from "vitest";
import { cadenceCandidatePlans, consolidationActivityForCursor, planLessonRound, summarizeShortTaskCoverage } from "../server/services/exercisePlanner.js";
import type { PlannerWord, RecentPlannedActivity } from "../server/services/exercisePlanner.js";

function words(count: number, overrides: Partial<PlannerWord> = {}): PlannerWord[] {
  return Array.from({ length: count }, (_, index) => ({
    word_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    word: `target${index + 1}`,
    target_sense: `目标核心义 ${index + 1}`,
    part_of_speech: "v.",
    lesson_profile: "quick_recall" as const,
    error_focus: null,
    ...overrides,
  }));
}

function ids(): () => string {
  let index = 0;
  return () => `00000000-0000-4000-9000-${String(++index).padStart(12, "0")}`;
}

describe("exercisePlanner", () => {
  it("plans one frozen primary exercise per word and covers two or more task types", () => {
    for (const count of [5, 6, 7]) {
      const plans = planLessonRound({ words: words(count), id_factory: ids() });
      expect(plans).toHaveLength(count);
      expect(new Set(plans.map((plan) => plan.exercise_id)).size).toBe(count);
      expect(new Set(plans.map((plan) => plan.plan_id)).size).toBe(count);
      expect(new Set(plans.map((plan) => plan.planned_activity_type)).size).toBeGreaterThanOrEqual(2);
      expect(plans.filter((plan) => plan.planned_activity_type === "translation_cn_to_en").length).toBeGreaterThanOrEqual(1);
      expect(plans.every((plan) => plan.scope === "lesson" && plan.target_word_ids.length === 1)).toBe(true);
    }
  });

  it("allows quick_recall to use short translation and appropriate collocation tasks", () => {
    const plans = planLessonRound({ words: words(5), id_factory: ids() });
    expect(plans.some((plan) => plan.planned_activity_type === "translation_cn_to_en")).toBe(true);
    expect(plans.some((plan) => plan.planned_activity_type === "collocation")).toBe(true);
    expect(plans.every((plan) => plan.planned_activity_type !== "derivation")).toBe(true);
    const translation = plans.find((plan) => plan.planned_activity_type === "translation_cn_to_en");
    expect(translation?.skill_ids).toEqual(["target_sense_retrieval", "verb_object_collocation", "syntactic_word_use"]);
    expect(translation?.skill_ids).not.toContain("translation_cn_to_en");
  });

  it("keeps spelling focus ahead of coverage and stores why that window may be exceptional", () => {
    const history: RecentPlannedActivity[] = Array.from({ length: 19 }, () => ({ scope: "lesson", activity_type: "word_recall" }));
    const focused = words(1, { lesson_profile: "targeted_relearn", is_relearn: true, error_focus: "spelling" });
    const [plan] = planLessonRound({ words: focused, recent_activities: history, id_factory: ids() });
    expect(plan?.planned_activity_type).toBe("word_recall");
    expect(plan?.skill_ids).toEqual(["target_word_spelling"]);
    expect(plan?.coverage_exception_reason).toContain("专项错误");
  });

  it("accepts adapter skill signals as estimates but lets the planner choose the activity", () => {
    const plan = planLessonRound({
      words: words(1),
      skill_signals: [{ skill_id: "verb_object_collocation", state: "needs_practice", source: "adapter", confidence: 0.91 }],
      id_factory: ids(),
    })[0]!;
    expect(plan.planned_activity_type).toBe("collocation");
    expect(plan.skill_signals?.[0]).toMatchObject({ source: "adapter", state: "needs_practice" });
    expect(plan.skill_ids).not.toContain("translation_cn_to_en");
    expect(plan.skill_ids).toContain("verb_object_collocation");
    expect(plan.planned_activity_type).not.toBe("verb_object_collocation");
  });

  it("keeps the four-step consolidation rotation and its frozen task candidates inside the planner", () => {
    expect([0, 1, 2, 3, 4].map(consolidationActivityForCursor)).toEqual([
      "translation_en_to_cn", "translation_cn_to_en", "translation_en_to_cn", "sentence", "translation_en_to_cn",
    ]);
    const primary = planLessonRound({ words: words(1), id_factory: ids() })[0]!;
    const candidates = cadenceCandidatePlans(primary, "target1");
    expect(Object.keys(candidates)).toEqual(["0", "1", "2", "3"]);
    expect(Object.values(candidates).map((candidate) => (candidate as { plan: { planned_activity_type: string } }).plan.planned_activity_type))
      .toEqual(["translation_en_to_cn", "translation_cn_to_en", "translation_en_to_cn", "sentence"]);
    expect(Object.values(candidates).every((candidate) => (candidate as { plan: { scope: string } }).plan.scope === "consolidation")).toBe(true);
  });

  it("meets the rolling 20-task mix with a fixed seed-like queue when the prior window is retrieval-heavy", () => {
    const history: RecentPlannedActivity[] = Array.from({ length: 19 }, () => ({ scope: "lesson", activity_type: "word_recall" }));
    const plans = planLessonRound({ words: words(5), recent_activities: history, id_factory: ids() });
    const window = [...history.map(({ activity_type }) => ({ activity_type })), ...plans.map((plan) => ({
      activity_type: plan.planned_activity_type,
      coverage_exception_reason: plan.coverage_exception_reason,
    }))].slice(-20);
    const summary = summarizeShortTaskCoverage(window);
    expect(summary.translations).toBeGreaterThanOrEqual(2);
    expect(summary.activity_types.length).toBeGreaterThanOrEqual(3);
    expect(summary.retrieval_count).toBeLessThanOrEqual(15);
    expect(plans.map((plan) => plan.planned_activity_type)).toEqual([
      "translation_cn_to_en", "translation_cn_to_en", "collocation", "collocation", "collocation",
    ]);
  });

  it("summarizes the rolling 20-task gate and keeps exceptions visible", () => {
    const activities = [
      ...Array.from({ length: 14 }, () => ({ activity_type: "word_recall" })),
      ...Array.from({ length: 4 }, () => ({ activity_type: "collocation" })),
      ...Array.from({ length: 2 }, () => ({ activity_type: "translation_cn_to_en" })),
    ];
    expect(summarizeShortTaskCoverage(activities).meets_initial_targets).toBe(true);
    const exceptional = activities.map((item, index) => ({
      ...item,
      ...(index === 19 ? { activity_type: "word_recall", coverage_exception_reason: "专项拼写练习优先。" } : {}),
    }));
    expect(summarizeShortTaskCoverage(exceptional)).toMatchObject({
      meets_initial_targets: false,
      exceptions: ["专项拼写练习优先。"],
    });
  });
});
