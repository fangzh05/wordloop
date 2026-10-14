/** Offline, prequential comparison for the existing personal time-cost model.
 * This module is never imported by the Worker request path. */
export type BacktestStage = "answer" | "feedback" | "explanation";
export type BacktestModel = "static" | "personal_mean" | "p50" | "p75" | "trimmed_mean" | "ewma" | "shrinkage";

export interface LearningTimeBacktestObservation {
  /** Stable pseudonymous grouping key. It is never returned in the report. */
  learnerKey: string;
  date: string;
  observedAt: string;
  activityType: string;
  scope: string;
  stage: BacktestStage;
  activeMs: number | null;
  /** Set only when the caller can verify the entire day's time is observed. */
  dailyBudgetSeconds?: number | null;
  completeDay?: boolean;
}

export interface BacktestMetric {
  samples: number;
  maeSeconds: number | null;
  meanBiasSeconds: number | null;
  p75AbsoluteErrorSeconds: number | null;
}

export interface BudgetOverrunMetric {
  completeDays: number;
  actualOverrunDays: number;
  actualOverrunRate: number | null;
  forecastedOverrunDays: number;
  missedOverrunDays: number;
  missedOverrunRate: number | null;
}

export interface LearningTimeBacktestReport {
  method: "date-ordered-prior-days-only";
  priorSamples: number;
  totalRows: number;
  validRows: number;
  validCoverage: number;
  excludedMissingTime: number;
  excludedInvalidTime: number;
  learnerCount: number;
  models: Record<BacktestModel, BacktestMetric & { budgetOverrun: BudgetOverrunMetric }>;
  byActivity: Record<string, Record<BacktestModel, BacktestMetric>>;
}

interface ValidObservation extends LearningTimeBacktestObservation {
  activeMs: number;
}

const MODEL_NAMES: readonly BacktestModel[] = ["static", "personal_mean", "p50", "p75", "trimmed_mean", "ewma", "shrinkage"];
const MIN_VALID_MS = 250;
const MAX_VALID_MS = 300_000;

function fallbackSeconds(activity: string, scope: string, stage: BacktestStage): number {
  if (activity === "__complete_new_word__") return 77;
  if (stage === "explanation") return 30;
  if (stage === "feedback") return 5;
  if (scope === "consolidation") return 90;
  if (["collocation", "derivation"].includes(activity)) return 15;
  if (activity.startsWith("translation")) return 30;
  if (["sentence", "semantic_expression"].includes(activity)) return 45;
  return 8;
}

function family(activity: string): string {
  if (activity.startsWith("translation")) return "translation";
  if (["cloze", "exact_cloze", "word_recall", "spelling"].includes(activity)) return "recall";
  return activity;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function validObservation(row: LearningTimeBacktestObservation): row is ValidObservation {
  return typeof row.learnerKey === "string" && row.learnerKey.length > 0
    && isDate(row.date) && typeof row.activityType === "string" && row.activityType.length > 0
    && typeof row.scope === "string" && row.scope.length > 0
    && ["answer", "feedback", "explanation"].includes(row.stage)
    && Number.isFinite(Date.parse(row.observedAt))
    && Number.isInteger(row.activeMs) && row.activeMs! >= MIN_VALID_MS && row.activeMs! <= MAX_VALID_MS;
}

function estimate(row: ValidObservation, history: ValidObservation[], model: BacktestModel, priorSamples: number): number {
  const fallback = fallbackSeconds(row.activityType, row.scope, row.stage);
  if (model === "static") return fallback;

  const cutoff30 = addDays(row.date, -30);
  const matching = history.filter(item => item.date >= cutoff30 && item.date < row.date
    && item.scope === row.scope && item.stage === row.stage);
  let selected = matching.filter(item => item.activityType === row.activityType);
  let related = false;
  if (selected.length === 0) {
    selected = matching.filter(item => family(item.activityType) === family(row.activityType));
    related = true;
  }
  if (selected.length === 0) return fallback;

  const recent = selected.filter(item => item.date >= addDays(row.date, -14));
  const training = recent.length >= 30 ? recent : selected;
  const rawValues = training.map(item => item.activeMs / 1000);
  if (model === "personal_mean") {
    return rawValues.reduce((total, value) => total + value, 0) / rawValues.length;
  }

  const sortedValues = [...rawValues].sort((a, b) => a - b);
  const quantile = (fraction: number) => sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)] ?? fallback;
  const robustValues = rawValues.map(value => Math.min(value, fallback * 3));
  let candidate: number;
  if (model === "p50") candidate = quantile(0.5);
  else if (model === "p75") candidate = quantile(0.75);
  else if (model === "trimmed_mean") {
    const sorted = [...robustValues].sort((a, b) => a - b);
    const trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0;
    const kept = sorted.slice(trim, sorted.length - trim || undefined);
    candidate = kept.reduce((total, value) => total + value, 0) / kept.length;
  } else if (model === "ewma") {
    // Completion timestamps provide within-day order; alpha is fixed for reproducibility.
    const chronological = [...training].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    candidate = Math.min(chronological[0]!.activeMs / 1000, fallback * 3);
    for (const item of chronological.slice(1)) candidate = 0.3 * Math.min(item.activeMs / 1000, fallback * 3) + 0.7 * candidate;
  } else {
    candidate = robustValues.reduce((total, value) => total + value, 0) / robustValues.length;
  }
  if (model !== "shrinkage") return Math.max(fallback * 0.5, Math.min(fallback * 3, candidate));

  // Match production's five-second histogram midpoint and three-times fallback cap.
  const cappedMean = training.reduce((total, item) => {
    const bucketMidpointSeconds = Math.floor(item.activeMs / 5000) * 5 + 2.5;
    return total + Math.min(bucketMidpointSeconds, fallback * 3);
  }, 0) / training.length;
  const bounded = Math.max(fallback * 0.5, Math.min(fallback * 3, cappedMean));
  const strength = priorSamples * (related ? 2 : 1);
  const weight = training.length / (training.length + strength);
  return weight * bounded + (1 - weight) * fallback;
}

function percentile75(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)] ?? null;
}

function metrics(errors: number[], biases: number[]): BacktestMetric {
  if (errors.length === 0) return { samples: 0, maeSeconds: null, meanBiasSeconds: null, p75AbsoluteErrorSeconds: null };
  return {
    samples: errors.length,
    maeSeconds: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    meanBiasSeconds: biases.reduce((sum, value) => sum + value, 0) / biases.length,
    p75AbsoluteErrorSeconds: percentile75(errors),
  };
}

interface DailyForecast {
  budgetSeconds: number;
  complete: boolean;
  actualMs: number;
  predictedMs: Record<BacktestModel, number>;
}

function overrunMetrics(days: DailyForecast[], model: BacktestModel): BudgetOverrunMetric {
  const eligible = days.filter(day => day.complete && Number.isFinite(day.budgetSeconds) && day.budgetSeconds >= 0);
  const actualOverruns = eligible.filter(day => day.actualMs > day.budgetSeconds * 1000).length;
  const forecasted = eligible.filter(day => day.predictedMs[model] > day.budgetSeconds * 1000).length;
  const missed = eligible.filter(day => day.actualMs > day.budgetSeconds * 1000 && day.predictedMs[model] <= day.budgetSeconds * 1000).length;
  return {
    completeDays: eligible.length,
    actualOverrunDays: actualOverruns,
    actualOverrunRate: eligible.length ? actualOverruns / eligible.length : null,
    forecastedOverrunDays: forecasted,
    missedOverrunDays: missed,
    missedOverrunRate: actualOverruns ? missed / actualOverruns : null,
  };
}

/**
 * Evaluates each valid task using only this learner's valid observations from
 * earlier local dates. Same-day rows are held out together to match the
 * production predictor's same-day exclusion. Results never contain learner keys.
 */
export function backtestLearningTimeCosts(
  observations: LearningTimeBacktestObservation[],
  priorSamples = 20,
): LearningTimeBacktestReport {
  if (!Number.isInteger(priorSamples) || priorSamples < 1 || priorSamples > 500) {
    throw new RangeError("priorSamples must be an integer between 1 and 500");
  }
  const valid: ValidObservation[] = [];
  let missing = 0;
  let invalid = 0;
  for (const row of observations) {
    if (row.activeMs === null) { missing++; continue; }
    if (row.activeMs < MIN_VALID_MS || row.activeMs > MAX_VALID_MS || !Number.isInteger(row.activeMs)) { invalid++; continue; }
    if (!validObservation(row)) { invalid++; continue; }
    valid.push(row);
  }
  valid.sort((a, b) => a.date.localeCompare(b.date) || a.learnerKey.localeCompare(b.learnerKey)
    || a.activityType.localeCompare(b.activityType) || a.scope.localeCompare(b.scope) || a.stage.localeCompare(b.stage));

  const errors = new Map<BacktestModel, number[]>(MODEL_NAMES.map(model => [model, []]));
  const biases = new Map<BacktestModel, number[]>(MODEL_NAMES.map(model => [model, []]));
  const activityErrors = new Map<string, Map<BacktestModel, { errors: number[]; biases: number[] }>>();
  const userHistory = new Map<string, ValidObservation[]>();
  const daily = new Map<string, DailyForecast>();
  const incompleteDaily = new Set<string>();
  for (const row of observations) {
    if (typeof row.learnerKey !== "string" || !row.learnerKey || !isDate(row.date)) continue;
    if (row.dailyBudgetSeconds === null || row.dailyBudgetSeconds === undefined || row.completeDay !== true
      || !Number.isFinite(row.dailyBudgetSeconds) || row.dailyBudgetSeconds < 0
      || row.activeMs === null || !Number.isInteger(row.activeMs) || row.activeMs < MIN_VALID_MS || row.activeMs > MAX_VALID_MS) {
      incompleteDaily.add(`${row.learnerKey}|${row.date}`);
    }
  }

  for (let index = 0; index < valid.length;) {
    const first = valid[index]!;
    let end = index + 1;
    while (end < valid.length && valid[end]!.learnerKey === first.learnerKey && valid[end]!.date === first.date) end++;
    const dayRows = valid.slice(index, end);
    const history = (userHistory.get(first.learnerKey) ?? []).filter(item => item.date >= addDays(first.date, -30));
    userHistory.set(first.learnerKey, history);
    const dayPredictionCache = new Map<string, Record<BacktestModel, number>>();

    for (const row of dayRows) {
      const group = `${row.activityType}|${row.scope}|${row.stage}`;
      let groupModels = activityErrors.get(group);
      if (!groupModels) {
        groupModels = new Map(MODEL_NAMES.map(model => [model, { errors: [], biases: [] }]));
        activityErrors.set(group, groupModels);
      }
      const dayKey = `${row.learnerKey}|${row.date}`;
      const budgetValue = row.dailyBudgetSeconds;
      if (budgetValue !== null && budgetValue !== undefined && Number.isFinite(budgetValue) && budgetValue >= 0) {
        let aggregate = daily.get(dayKey);
        if (!aggregate) {
          aggregate = { budgetSeconds: budgetValue, complete: row.completeDay === true, actualMs: 0,
            predictedMs: Object.fromEntries(MODEL_NAMES.map(model => [model, 0])) as Record<BacktestModel, number> };
          daily.set(dayKey, aggregate);
        } else if (aggregate.budgetSeconds !== budgetValue) {
          aggregate.complete = false;
        }
        if (row.completeDay !== true) aggregate.complete = false;
        aggregate.actualMs += row.activeMs;
      } else {
        incompleteDaily.add(dayKey);
      }

      let predictions = dayPredictionCache.get(group);
      if (!predictions) {
        predictions = Object.fromEntries(MODEL_NAMES.map(model => [model, estimate(row, history, model, priorSamples)])) as Record<BacktestModel, number>;
        dayPredictionCache.set(group, predictions);
      }
      for (const model of MODEL_NAMES) {
        const predicted = predictions[model];
        const error = Math.abs(row.activeMs / 1000 - predicted);
        const bias = row.activeMs / 1000 - predicted;
        errors.get(model)!.push(error);
        biases.get(model)!.push(bias);
        groupModels.get(model)!.errors.push(error);
        groupModels.get(model)!.biases.push(bias);
        const forecast = daily.get(dayKey);
        if (forecast) forecast.predictedMs[model] += predicted * 1000;
      }
    }
    // Add this local day only after every same-day prediction has been scored.
    history.push(...dayRows);
    index = end;
  }
  for (const key of incompleteDaily) {
    const forecast = daily.get(key);
    if (forecast) forecast.complete = false;
  }

  const models = Object.fromEntries(MODEL_NAMES.map(model => [model, {
    ...metrics(errors.get(model)!, biases.get(model)!), budgetOverrun: overrunMetrics([...daily.values()], model),
  }])) as LearningTimeBacktestReport["models"];
  const byActivity = Object.fromEntries([...activityErrors].sort(([a], [b]) => a.localeCompare(b)).map(([group, values]) => [group,
    Object.fromEntries(MODEL_NAMES.map(model => [model, metrics(values.get(model)!.errors, values.get(model)!.biases)])) as Record<BacktestModel, BacktestMetric>,
  ]));
  return {
    method: "date-ordered-prior-days-only",
    priorSamples,
    totalRows: observations.length,
    validRows: valid.length,
    validCoverage: observations.length ? valid.length / observations.length : 0,
    excludedMissingTime: missing,
    excludedInvalidTime: invalid,
    learnerCount: new Set(valid.map(row => row.learnerKey)).size,
    models,
    byActivity,
  };
}
