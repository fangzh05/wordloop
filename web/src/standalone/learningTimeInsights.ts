import type { BudgetHistoryDay } from "../../../server/services/learningBudget.js";

export type LearningTimeWindowDays = 7 | 14 | 30;
export interface LearningTimeSummary {
  days: BudgetHistoryDay[];
  effective_seconds: number;
  samples: number;
  prediction_samples: number;
  mean_absolute_error_seconds: number | null;
  mean_signed_error_seconds: number | null;
  new_word_prediction_samples: number;
  new_word_mean_absolute_error_seconds: number | null;
  new_word_mean_signed_error_seconds: number | null;
}

function mean(totalMs: number, samples: number): number | null {
  return samples > 0 ? totalMs / samples / 1000 : null;
}

export function summarizeLearningTime(history: BudgetHistoryDay[], range: LearningTimeWindowDays): LearningTimeSummary {
  const days = history.slice(0, range);
  const sum = (read: (day: BudgetHistoryDay) => number | undefined) => days.reduce((total, day) => total + (read(day) ?? 0), 0);
  const predictionSamples = sum(day => day.prediction_samples);
  const newWordPredictionSamples = sum(day => day.new_word_prediction_samples);
  return {
    days,
    effective_seconds: sum(day => day.effective_seconds),
    samples: sum(day => day.samples),
    prediction_samples: predictionSamples,
    mean_absolute_error_seconds: mean(sum(day => day.absolute_error_total_ms), predictionSamples),
    mean_signed_error_seconds: mean(sum(day => day.signed_error_total_ms), predictionSamples),
    new_word_prediction_samples: newWordPredictionSamples,
    new_word_mean_absolute_error_seconds: mean(sum(day => day.new_word_absolute_error_total_ms), newWordPredictionSamples),
    new_word_mean_signed_error_seconds: mean(sum(day => day.new_word_signed_error_total_ms), newWordPredictionSamples),
  };
}
