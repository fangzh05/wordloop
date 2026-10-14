import { describe, expect, it } from "vitest";
import { summarizeLearningTime, type LearningTimeWindowDays } from "../web/src/standalone/learningTimeInsights.js";
import type { BudgetHistoryDay } from "../server/services/learningBudget.js";

const day = (date: string, actual: number, samples: number, error: number, paired: number, wordError = 0, words = 0): BudgetHistoryDay => ({
  date, effective_seconds: actual, samples, predicted_total_ms: paired * 10000,
  prediction_samples: paired, signed_error_total_ms: error, absolute_error_total_ms: Math.abs(error),
  new_word_prediction_samples: words, new_word_predicted_total_ms: words * 77000,
  new_word_signed_error_total_ms: wordError, new_word_absolute_error_total_ms: Math.abs(wordError),
});

describe("learning time insight windows", () => {
  it.each([7, 14, 30] as LearningTimeWindowDays[])("summarizes only the selected %i-day window", range => {
    const history = Array.from({ length: 30 }, (_, index) => day(`2026-10-${String(14-index).padStart(2,"0")}`, 60, 2, 2000, 2));
    const summary = summarizeLearningTime(history, range);
    expect(summary.days).toHaveLength(range);
    expect(summary.effective_seconds).toBe(range * 60);
    expect(summary.samples).toBe(range * 2);
    expect(summary.mean_absolute_error_seconds).toBe(1);
  });
  it("keeps unavailable prediction errors null and summarizes complete-word errors separately", () => {
    const summary = summarizeLearningTime([day("2026-10-14", 30, 1, 0, 0, -4000, 1)], 7);
    expect(summary.mean_absolute_error_seconds).toBeNull();
    expect(summary.mean_signed_error_seconds).toBeNull();
    expect(summary.new_word_prediction_samples).toBe(1);
    expect(summary.new_word_mean_absolute_error_seconds).toBe(4);
    expect(summary.new_word_mean_signed_error_seconds).toBe(-4);
  });
});
