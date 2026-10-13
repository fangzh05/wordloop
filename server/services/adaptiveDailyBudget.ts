import { createEmptyCard, Rating, type Card, type Grade } from "ts-fsrs";
import { createFsrsScheduler } from "./fsrsScheduler.js";

/**
 * Adaptive Daily Budget V2 planner.
 *
 * Pure, deterministic, explainable. Runs a small-scale TS-FSRS simulation on
 * disposable cards (fixed epoch, no fuzz) only at the planning boundary; never
 * touches or schedules production cards. Deadline goals only annotate risk —
 * they never override the ceiling or due-review-first rules.
 */

export const PLANNING_HORIZON_DAYS = 14;
/** Fixed simulation epoch so curves are identical on every call. */
const SIMULATION_EPOCH = new Date("2026-01-01T00:00:00Z");

export type AdaptiveBudgetReasonCode =
  | "due_review_priority"
  | "budget_nearly_exhausted"
  | "future_workload_high"
  | "new_word_ceiling_reached"
  | "low_history_confidence"
  | "exam_deadline_risk";

const REASON_CODE_ORDER: AdaptiveBudgetReasonCode[] = [
  "due_review_priority", "budget_nearly_exhausted", "future_workload_high",
  "new_word_ceiling_reached", "low_history_confidence", "exam_deadline_risk",
];

export type EstimationStatus = "static" | "approximate" | "calibrated";
export type CostConfidence = "cold" | "low" | "moderate";

export interface FirstAnswerPerformance {
  correct_ratio: number;
  samples: number;
  confidence: CostConfidence;
}

export interface NewCardCurves { normal: number[]; elevated: number[] }

export interface ExamGoal { target_date: string; remaining_unique_words: number }

export interface AdaptiveDailyBudgetInput {
  remaining_seconds: number;
  daily_minutes: number;
  extra_seconds: number;
  due_count: number;
  overdue_count: number;
  /** All due cards, including those frozen in today's displayed review queue. */
  carryover_due_count?: number;
  /** Formal per-review cost in seconds. */
  review_cost_seconds: number;
  /** Full new-word (lesson lifecycle) cost in seconds. */
  new_word_cost_seconds: number;
  /** Daily new-word ceiling. */
  new_word_cap: number;
  new_words_started_today: number;
  /** Existing future due burden in seconds, index 0 = tomorrow. */
  future_due_seconds: number[];
  /** Existing short-interval cards and interval-based repeat-load floor. */
  young_count?: number;
  estimated_daily_review_seconds?: number;
  recent_first_answers?: FirstAnswerPerformance;
  new_word_cost_confidence?: CostConfidence;
  /** Optional precomputed per-card marginal curves; simulated when absent. */
  new_card_curves?: NewCardCurves;
  exam?: ExamGoal;
  /** Local date (YYYY-MM-DD) required to evaluate an exam deadline. */
  today_local?: string;
}

export interface FutureBurden {
  per_day_seconds: number[];
  next_7_days_seconds: number;
  next_14_days_seconds: number;
}

export interface AdaptiveDailyBudgetPlan {
  /** Cumulative target including words already started today. */
  recommended_new_words_total: number;
  new_words_admissible_now: number;
  projected_review_seconds: number;
  projected_new_word_seconds: number;
  future_burden_normal: FutureBurden;
  future_burden_elevated: FutureBurden;
  reason_codes: AdaptiveBudgetReasonCode[];
  estimation_status: EstimationStatus;
  buffer_seconds: number;
}

/** 5% safety buffer, clamped to [60, 180] seconds. */
export function planningBufferSeconds(remainingSeconds: number): number {
  return Math.min(180, Math.max(60, Math.round(remainingSeconds * 0.05)));
}

function padOrClip(values: number[], length = PLANNING_HORIZON_DAYS): number[] {
  return Array.from({ length }, (_, i) => values[i] ?? 0);
}

function summarizeBurden(perDay: number[]): FutureBurden {
  const sum = (from: number, to: number) => perDay.slice(from, to).reduce((s, v) => s + v, 0);
  return { per_day_seconds: perDay, next_7_days_seconds: sum(0, 7), next_14_days_seconds: sum(0, 14) };
}

/** Deterministic elevated-scenario grade: weaker first answers -> more Again/Hard. */
function elevatedGrade(correctRatio: number): Grade {
  if (correctRatio < 0.5) return Rating.Again;
  if (correctRatio < 0.8) return Rating.Hard;
  return Rating.Good;
}

export interface MarginalCurveOptions {
  review_cost_seconds: number;
  first_answer_correct_ratio?: number;
  /** Read-only prototype (e.g. a real card shape); never mutated. */
  prototype_card?: Card;
}
const marginalCache = new Map<string, NewCardCurves>();

/**
 * Simulate ONE disposable new card's marginal future review cost per day
 * (days 1..14 after introduction) for the normal (all Good) and elevated
 * (performance-derived Again/Hard) scenarios. Simulated once, then multiplied
 * by the candidate count. No new forgetting rates: only ratings differ.
 */
export function simulateNewWordMarginalCurves(options: MarginalCurveOptions): NewCardCurves {
  const ratio = options.first_answer_correct_ratio ?? 1;
  const cacheKey = `${options.review_cost_seconds}:${ratio}`;
  const cached = !options.prototype_card ? marginalCache.get(cacheKey) : undefined;
  if (cached) return { normal: [...cached.normal], elevated: [...cached.elevated] };
  const scheduler = createFsrsScheduler(false);
  const build = (gradeFor: () => Grade): number[] => {
    const base = options.prototype_card ? { ...options.prototype_card } : createEmptyCard(SIMULATION_EPOCH);
    let card = scheduler.next(base, SIMULATION_EPOCH, gradeFor()).card;
    const curve = Array(PLANNING_HORIZON_DAYS).fill(0) as number[];
    for (let day = 1; day <= PLANNING_HORIZON_DAYS; day++) {
      const when = new Date(SIMULATION_EPOCH.getTime() + day * 86400000);
      if (card.due <= when) {
        curve[day - 1] = (curve[day - 1] ?? 0) + options.review_cost_seconds;
        card = scheduler.next(card, when, gradeFor()).card;
      }
    }
    return curve;
  };
  const result = {
    normal: build(() => Rating.Good),
    elevated: build(() => elevatedGrade(ratio)),
  };
  if (!options.prototype_card) {
    if (marginalCache.size >= 32) marginalCache.delete(marginalCache.keys().next().value!);
    marginalCache.set(cacheKey, { normal: [...result.normal], elevated: [...result.elevated] });
  }
  return result;
}

function statusFor(confidence: CostConfidence | undefined): EstimationStatus {
  if (!confidence || confidence === "cold") return "static";
  return confidence === "low" ? "approximate" : "calibrated";
}

/**
 * Search candidates from the feasible upper bound downwards and return the
 * largest count that fits today's budget and the 7-14 day burden protection.
 */
export function planAdaptiveDailyBudget(input: AdaptiveDailyBudgetInput): AdaptiveDailyBudgetPlan {
  const codes = new Set<AdaptiveBudgetReasonCode>();
  const buffer = planningBufferSeconds(input.remaining_seconds);
  const usable = Math.max(0, input.remaining_seconds - buffer);
  // Extra minutes are today's only; future days use the recurring budget.
  const futureCeiling = Math.max(0, input.daily_minutes * 60);
  const reviewSeconds = Math.max(0, input.due_count) * Math.max(0, input.review_cost_seconds);
  const newCost = Math.max(0, input.new_word_cost_seconds);
  const started = Math.max(0, input.new_words_started_today);
  const slots = Math.max(0, input.new_word_cap - started);
  const afterReview = usable - reviewSeconds;
  if (reviewSeconds > 0 || input.overdue_count > 0) codes.add("due_review_priority");
  if (afterReview < newCost) codes.add("budget_nearly_exhausted");

  const firstAnswers = input.recent_first_answers ?? { correct_ratio: 1, samples: 0, confidence: "cold" as CostConfidence };
  if (firstAnswers.samples < 20 || firstAnswers.confidence !== "moderate") codes.add("low_history_confidence");

  const curves = input.new_card_curves
    ? { normal: padOrClip(input.new_card_curves.normal), elevated: padOrClip(input.new_card_curves.elevated) }
    : simulateNewWordMarginalCurves({
      review_cost_seconds: input.review_cost_seconds,
      // With no personal signal, the elevated chart uses a documented Hard
      // scenario; this is a sensitivity bound, not an estimated success rate.
      first_answer_correct_ratio: firstAnswers.samples > 0 ? firstAnswers.correct_ratio : 0.75,
    });
  // Plan conservatively on the elevated curve when independent first answers are weak or unproven.
  const planningCurve = firstAnswers.correct_ratio < 0.8 || firstAnswers.confidence !== "moderate" ? curves.elevated : curves.normal;
  const repeatFloor = Math.max(0, input.estimated_daily_review_seconds ?? 0);
  // Snapshot counts cards with a scheduled interval under 21 days; amortize
  // that conservative floor over the same horizon to avoid inflating 7-day work.
  const youngFloor = Math.max(0, input.young_count ?? 0) * input.review_cost_seconds / 21;
  const futureDue = padOrClip(input.future_due_seconds).map(seconds => Math.max(0, seconds, repeatFloor));
  // Interval-load and young-card floors account for repeat work not represented
  // by a card's single next due date. Failure uplift is a sensitivity scenario.
  const failureUplift = firstAnswers.samples > 0 ? Math.min(.5, Math.max(0, 1-firstAnswers.correct_ratio)) : .25;
  const elevatedDue = futureDue.map(seconds => Math.max(seconds, youngFloor) * (1+failureUplift));
  // Normal assumes today's outstanding Reviews are completed. The elevated
  // case carries them to tomorrow, so an unfinished queue is visible in the
  // future-workload constraint even after today's plan stops admitting work.
  if (elevatedDue.length > 0) {
    elevatedDue[0] = (elevatedDue[0] ?? 0)
      + Math.max(0, input.carryover_due_count ?? input.due_count) * Math.max(0, input.review_cost_seconds) * (1+failureUplift);
  }

  const timeMax = newCost > 0 ? (afterReview > 0 ? Math.floor(afterReview / newCost) : 0) : slots;
  const upper = Math.max(0, Math.min(timeMax, slots));
  let admitted = -1;
  for (let n = upper; n >= 0; n--) {
    const fitsFuture = elevatedDue.every((seconds, day) => seconds + n * (planningCurve[day] ?? 0) <= futureCeiling);
    if (fitsFuture) { admitted = n; break; }
  }
  if (admitted < 0) { admitted = 0; codes.add("future_workload_high"); }
  if (admitted < upper) codes.add("future_workload_high");
  if (admitted === slots && (slots === 0 || upper === slots)) codes.add("new_word_ceiling_reached");

  if (input.exam && input.today_local) {
    const days = Math.ceil((Date.parse(`${input.exam.target_date}T00:00:00Z`) - Date.parse(`${input.today_local}T00:00:00Z`)) / 86400000);
    const requiredPerDay = input.exam.remaining_unique_words / Math.max(1, days);
    if (input.exam.remaining_unique_words > 0 && (days <= 0 || requiredPerDay > admitted)) codes.add("exam_deadline_risk");
  }

  const burden = (baseline: number[], curve: number[]): FutureBurden => summarizeBurden(baseline.map((seconds, day) => seconds + admitted * (curve[day] ?? 0)));

  return {
    recommended_new_words_total: started + admitted,
    new_words_admissible_now: admitted,
    projected_review_seconds: reviewSeconds,
    projected_new_word_seconds: admitted * newCost,
    future_burden_normal: burden(futureDue, curves.normal),
    future_burden_elevated: burden(elevatedDue, curves.elevated),
    reason_codes: REASON_CODE_ORDER.filter(code => codes.has(code)),
    estimation_status: statusFor(input.new_word_cost_confidence),
    buffer_seconds: buffer,
  };
}
