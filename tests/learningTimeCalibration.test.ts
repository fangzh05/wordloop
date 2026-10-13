import { describe, expect, it } from "vitest";
import { buildLearningCostProfile, estimateTime, type TimeSummary } from "../server/services/learningTimeCalibration.js";

const row = (user: string, activity: string, scope: string, bucket: number, samples: number): TimeSummary => ({ activity_type: activity, scope, stage: "answer", samples, total_ms: bucket * 5000 * samples, histogram: { [bucket]: samples }, updated_at: "2026-10-13T00:00:00Z" });
describe("per-user learning time shrinkage", () => {
  it("uses static costs for a new learner and keeps the 77 second new-word fallback", () => {
    const profile = buildLearningCostProfile([]);
    expect(profile.costs["lesson:cloze"]?.source).toBe("static");
    expect(profile.new_word_seconds).toBe(77);
    expect(profile.new_word_source).toBe("static");
    expect(profile.new_word_samples).toBe(0);
  });
  it("isolates users and activity types because only the requested user summary is supplied", () => {
    const a = row("a", "cloze", "lesson", 2, 40), b = row("b", "cloze", "lesson", 12, 40);
    expect(estimateTime([a], "cloze", "lesson").seconds).toBeLessThan(estimateTime([b], "cloze", "lesson").seconds);
    expect(estimateTime([a], "translation_cn_to_en", "lesson").source).toBe("static");
  });
  it("shrinks a single long observation to the static prior and bounds its effect", () => {
    const one = row("a", "cloze", "lesson", 119, 1);
    const estimate = estimateTime([one], "cloze", "lesson");
    expect(estimate.source).toBe("personal");
    expect(estimate.confidence).toBe("low");
    expect(estimate.seconds).toBeLessThanOrEqual(24);
    expect(estimate.seconds).toBeGreaterThan(8);
  });
  it("returns cold confidence when no matching or related samples exist", () => {
    expect(estimateTime([], "sentence", "lesson")).toEqual({ seconds: 45, samples: 0, confidence: "cold", source: "static" });
  });
  it("does not compose marginal activity timings into a full-word estimate", () => {
    const profile = buildLearningCostProfile([row("a", "pretest_cn_to_en", "pretest", 3, 100)]);
    expect(profile.new_word_seconds).toBe(77);
    expect(profile.new_word_source).toBe("static");
  });
  it("calibrates complete new words only from unique completed lifecycle samples", () => {
    const profile = buildLearningCostProfile([row("a", "__complete_new_word__", "lesson", 30, 20)]);
    expect(profile.new_word_samples).toBe(20);
    expect(profile.new_word_source).toBe("lifecycle_estimate");
    // 20 observations in the 150-155s bin -> 152.5s capped-mean;
    // n/(n+20)=0.5 shrinkage toward the 77s fallback -> 114.8s.
    expect(profile.new_word_seconds).toBe(114.8);
  });
});
