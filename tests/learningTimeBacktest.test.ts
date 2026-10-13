import { describe, expect, it } from "vitest";
import { backtestLearningTimeCosts, type LearningTimeBacktestObservation as Observation } from "../shared/learningTimeBacktest.js";

const row = (learnerKey: string, date: string, activeMs: number | null, extra: Partial<Observation> = {}): Observation => ({
  learnerKey, date, observedAt: `${date}T12:00:00.000Z`, activeMs, activityType: "cloze", scope: "lesson", stage: "answer", ...extra,
});

describe("time-ordered personal learning-cost backtest", () => {
  it("holds out the whole local day and isolates learner histories", () => {
    const report = backtestLearningTimeCosts([
      row("learner-a", "2026-10-01", 10000),
      row("learner-a", "2026-10-01", 50000),
      row("learner-b", "2026-10-01", 40000),
      row("learner-a", "2026-10-02", 10000),
      row("learner-b", "2026-10-02", 40000),
    ]);
    expect(report.models.static.maeSeconds).toBe(22);
    expect(report.byActivity["cloze|lesson|answer"]?.personal_mean.maeSeconds).toBeGreaterThan(0);
    expect(report.models.shrinkage.samples).toBe(5);
    expect(JSON.stringify(report)).not.toContain("learner-a");
    expect(JSON.stringify(report)).not.toContain("learner-b");
  });

  it("compares static, personal mean and production shrinkage with prior dates only", () => {
    const rows = [
      row("a", "2026-10-01", 40000),
      row("a", "2026-10-02", 40000),
      row("a", "2026-10-03", 40000),
      row("a", "2026-10-04", 40000),
      row("a", "2026-10-05", 40000),
      row("a", "2026-10-06", 40000),
      row("a", "2026-10-07", 40000),
      row("a", "2026-10-08", 40000),
      row("a", "2026-10-09", 40000),
      row("a", "2026-10-10", 40000),
      row("a", "2026-10-11", 40000),
      row("a", "2026-10-12", 40000),
      row("a", "2026-10-13", 40000),
      row("a", "2026-10-14", 40000),
    ];
    const report = backtestLearningTimeCosts(rows);
    expect(report.models.static.maeSeconds).toBe(32);
    expect(report.models.personal_mean.maeSeconds).toBeLessThan(report.models.static.maeSeconds!);
    expect(report.models.shrinkage.maeSeconds).toBeLessThan(report.models.static.maeSeconds!);
    expect(report.models.shrinkage.meanBiasSeconds).toBeGreaterThan(0);
    expect(report.models.shrinkage.p75AbsoluteErrorSeconds).toBeGreaterThanOrEqual(0);
    expect(report.models.p50.maeSeconds).toBeLessThan(report.models.static.maeSeconds!);
    expect(report.models.p75.maeSeconds).toBeLessThan(report.models.static.maeSeconds!);
    expect(report.models.trimmed_mean.maeSeconds).toBeLessThan(report.models.static.maeSeconds!);
    expect(report.models.ewma.maeSeconds).toBeLessThan(report.models.static.maeSeconds!);
  });

  it("reports missing/out-of-range coverage and scores overrun only for complete days", () => {
    const report = backtestLearningTimeCosts([
      row("a", "2026-10-01", null, { dailyBudgetSeconds: 20, completeDay: true }),
      row("a", "2026-10-02", 50000, { dailyBudgetSeconds: 30, completeDay: true }),
      row("a", "2026-10-03", 50000, { dailyBudgetSeconds: 30, completeDay: false }),
      row("a", "2026-10-04", 700000, { dailyBudgetSeconds: 30, completeDay: true }),
    ]);
    expect(report).toMatchObject({ totalRows: 4, validRows: 2, validCoverage: 0.5, excludedMissingTime: 1, excludedInvalidTime: 1 });
    expect(report.models.static.budgetOverrun).toMatchObject({ completeDays: 1, actualOverrunDays: 1, actualOverrunRate: 1, missedOverrunDays: 1, missedOverrunRate: 1 });
    expect(report.models.personal_mean.budgetOverrun.completeDays).toBe(1);
  });

  it("returns explicit empty metrics for the current zero-observation production audit", () => {
    const report = backtestLearningTimeCosts([row("a", "2026-10-01", null)]);
    expect(report.validRows).toBe(0);
    expect(report.models.static).toMatchObject({ samples: 0, maeSeconds: null, meanBiasSeconds: null, p75AbsoluteErrorSeconds: null });
    expect(report.models.static.budgetOverrun.actualOverrunRate).toBeNull();
  });
});
