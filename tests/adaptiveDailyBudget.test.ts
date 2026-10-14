import { describe, expect, it } from "vitest";
import { createEmptyCard } from "ts-fsrs";
import { planAdaptiveDailyBudget, simulateNewWordMarginalCurves, planningBufferSeconds, type AdaptiveDailyBudgetInput } from "../server/services/adaptiveDailyBudget.js";

const base: AdaptiveDailyBudgetInput = {
  remaining_seconds: 1800, daily_minutes: 30, extra_seconds: 0,
  due_count: 60, overdue_count: 0, review_cost_seconds: 16, new_word_cost_seconds: 80,
  new_word_cap: 20, new_words_started_today: 0,
  future_due_seconds: Array(14).fill(0),
  recent_first_answers: { correct_ratio: 0.9, samples: 40, confidence: "moderate" },
  new_word_cost_confidence: "moderate",
};
const plan = (over: Partial<AdaptiveDailyBudgetInput> = {}) => planAdaptiveDailyBudget({ ...base, ...over });

describe("adaptive daily budget v2", () => {
  it("plans 30 minutes with 16 minutes of review, cap 20 and 80s new words down to ~9", () => {
    const p = plan();
    expect(p.buffer_seconds).toBe(90);
    expect(p.new_words_admissible_now).toBe(9);
    expect(p.recommended_new_words_total).toBe(9);
    expect(p.projected_review_seconds).toBe(960);
    expect(p.projected_new_word_seconds).toBe(720);
    expect(p.future_burden_normal.per_day_seconds).toHaveLength(14);
    expect(p.future_burden_normal.next_14_days_seconds).toBeGreaterThan(0);
  });
  it("clamps the buffer into [60, 180] seconds", () => {
    expect(planningBufferSeconds(600)).toBe(60);
    expect(planningBufferSeconds(100000)).toBe(180);
  });
  it("recommends 0 when due review alone exhausts the budget", () => {
    const p = plan({ due_count: 120 });
    expect(p.new_words_admissible_now).toBe(0);
    expect(p.recommended_new_words_total).toBe(0);
    expect(p.reason_codes).toContain("due_review_priority");
    expect(p.reason_codes).toContain("budget_nearly_exhausted");
  });
  it("raises the target with light review but never past the ceiling", () => {
    const p = plan({ due_count: 0 });
    expect(p.new_words_admissible_now).toBe(20);
    expect(p.recommended_new_words_total).toBeLessThanOrEqual(base.new_word_cap);
    expect(p.reason_codes).toContain("new_word_ceiling_reached");
    expect(p.reason_codes).not.toContain("due_review_priority");
  });
  it("counts words already started today into the cumulative target", () => {
    const p = plan({ new_words_started_today: 5, new_word_cap: 20 });
    expect(p.recommended_new_words_total).toBe(5 + p.new_words_admissible_now);
    expect(p.new_words_admissible_now).toBeLessThanOrEqual(15);
  });
  it("tightens admission under high future workload", () => {
    const unconstrained = plan();
    const blocked = plan({ future_due_seconds: Array(14).fill(5000) });
    expect(blocked.new_words_admissible_now).toBe(0);
    expect(blocked.reason_codes).toContain("future_workload_high");
    const tight = plan({ future_due_seconds: Array(14).fill(1600) });
    expect(tight.new_words_admissible_now).toBeLessThan(unconstrained.new_words_admissible_now);
    expect(tight.reason_codes).toContain("future_workload_high");
    expect(tight.future_burden_elevated.per_day_seconds[0]).toBeGreaterThan(1800);
  });
  it("admits more after a 900 second budget increase", () => {
    expect(plan({ remaining_seconds: 2700 }).new_words_admissible_now)
      .toBeGreaterThan(plan().new_words_admissible_now);
  });
  it("uses static costs on cold start and never claims personalization", () => {
    const p = plan({
      recent_first_answers: { correct_ratio: 1, samples: 0, confidence: "cold" },
      new_word_cost_confidence: "cold",
    });
    expect(p.estimation_status).toBe("static");
    expect(p.reason_codes).toContain("low_history_confidence");
    expect(p.new_words_admissible_now).toBe(9);
  });
  it("flags low-confidence history but calibrates proven profiles", () => {
    expect(plan({ recent_first_answers: { correct_ratio: 0.9, samples: 5, confidence: "low" } }).reason_codes).toContain("low_history_confidence");
    expect(plan().reason_codes).not.toContain("low_history_confidence");
    expect(plan({ new_word_cost_confidence: "low" }).estimation_status).toBe("approximate");
  });
  it("treats a missing exam deadline as no risk", () => {
    expect(plan().reason_codes).not.toContain("exam_deadline_risk");
  });
  it("annotates exam deadline risk without overriding the ceiling", () => {
    const withoutExam = plan();
    const risky = plan({ today_local: "2026-10-13", exam: { target_date: "2026-10-20", remaining_unique_words: 1000 } });
    expect(risky.reason_codes).toContain("exam_deadline_risk");
    expect(risky.new_words_admissible_now).toBe(withoutExam.new_words_admissible_now);
    const met = plan({ today_local: "2026-10-13", exam: { target_date: "2026-10-20", remaining_unique_words: 56 } });
    expect(met.reason_codes).not.toContain("exam_deadline_risk");
    expect(plan({ today_local: "2026-10-13", exam: { target_date: "2026-10-20", remaining_unique_words: 70 } }).reason_codes).toContain("exam_deadline_risk");
    expect(plan({ today_local: "2026-10-13", exam: { target_date: "2026-10-12", remaining_unique_words: 0 } }).reason_codes).not.toContain("exam_deadline_risk");
  });
  it("elevated scenarios cost at least as much as normal ones for weak first answers", () => {
    const weak = plan({ recent_first_answers: { correct_ratio: 0.3, samples: 40, confidence: "moderate" } });
    expect(weak.future_burden_elevated.next_14_days_seconds)
      .toBeGreaterThanOrEqual(weak.future_burden_normal.next_14_days_seconds);
    expect(weak.future_burden_normal.next_14_days_seconds).toBeGreaterThan(0);
  });
  it("leaves input FSRS cards and the input object untouched", () => {
    const card = createEmptyCard(new Date("2026-01-01T00:00:00Z"));
    const cardSnapshot = JSON.parse(JSON.stringify(card));
    const curves = simulateNewWordMarginalCurves({ review_cost_seconds: 16, first_answer_correct_ratio: 0.4, prototype_card: card });
    expect(JSON.parse(JSON.stringify(card))).toEqual(cardSnapshot);
    expect(curves.normal.some(seconds => seconds > 0)).toBe(true);
    const before = JSON.stringify({ ...base });
    plan();
    expect(JSON.stringify({ ...base })).toBe(before);
  });
  it("is fully repeatable", () => {
    expect(simulateNewWordMarginalCurves({ review_cost_seconds: 16 })).toEqual(simulateNewWordMarginalCurves({ review_cost_seconds: 16 }));
    expect(plan()).toEqual(plan());
  });
  it("reuses the same grade scenario and scales future Review cost linearly", () => {
    const first = simulateNewWordMarginalCurves({ review_cost_seconds: 16, first_answer_correct_ratio: 0.55 });
    const sameScenario = simulateNewWordMarginalCurves({ review_cost_seconds: 32, first_answer_correct_ratio: 0.79 });
    expect(sameScenario.normal).toEqual(first.normal.map((seconds) => seconds * 2));
    expect(sameScenario.elevated).toEqual(first.elevated.map((seconds) => seconds * 2));
    expect(simulateNewWordMarginalCurves({ review_cost_seconds: 16, first_answer_correct_ratio: 0.3 }).elevated)
      .not.toEqual(first.elevated);
  });
  it("protects against young-card and interval repeat-load pressure", () => {
    expect(plan({ young_count: 2000 }).new_words_admissible_now)
      .toBeLessThan(plan().new_words_admissible_now);
    expect(plan({ estimated_daily_review_seconds: 2000 }).reason_codes).toContain("future_workload_high");
  });
  it("does not spend today's extra minutes on future days", () => {
    const p = plan({ remaining_seconds: 2700, extra_seconds: 900, future_due_seconds: Array(14).fill(2000) });
    expect(p.new_words_admissible_now).toBe(0);
  });
  it("carries today's outstanding review queue into the elevated tomorrow forecast", () => {
    const p = plan({ due_count: 2, carryover_due_count: 8, new_card_curves: { normal: Array(14).fill(0), elevated: Array(14).fill(0) } });
    expect(p.future_burden_normal.per_day_seconds[0]).toBe(0);
    expect(p.future_burden_elevated.per_day_seconds[0]).toBe(8 * 16 * 1.1);
  });
});
