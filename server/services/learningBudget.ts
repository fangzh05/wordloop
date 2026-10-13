import { adaptiveDailyBudgetV2Enabled, getAuthenticatedUserId, getDatabase } from "../db.js";
import { assertDatabaseResult } from "./shared.js";
import { activityCost } from "../../shared/learningEvidence.js";
import { createEmptyCard, Rating } from "ts-fsrs";
import { createFsrsScheduler } from "./fsrsScheduler.js";
import { getUserLearningCostProfile, type LearningCostProfile } from "./learningTimeCalibration.js";
import { planAdaptiveDailyBudget, type AdaptiveDailyBudgetPlan, type AdaptiveBudgetReasonCode, type CostConfidence } from "./adaptiveDailyBudget.js";

export interface BudgetForecastDay { date: string; review_seconds: number; review_count?: number }
export interface BudgetHistoryDay {
  date: string; effective_seconds?: number; samples?: number; new_words?: number;
  predicted_total_ms?: number; prediction_samples?: number; signed_error_total_ms?: number; absolute_error_total_ms?: number;
  new_word_prediction_samples?: number; new_word_predicted_total_ms?: number;
  new_word_signed_error_total_ms?: number; new_word_absolute_error_total_ms?: number;
}
export interface ExamBudgetGoal {
  book_id?: string;
  target_date: string | null;
  coverage_target: number | null;
  total_unique_words: number;
  covered_unique_words: number;
  remaining_unique_words: number;
}

export interface BudgetSnapshot {
  date: string; daily_minutes: number; extra_seconds: number; estimated_used_seconds: number;
  remaining_seconds: number; due_count: number; overdue_count: number; new_word_cap: number;
  enabled: boolean; forecast: BudgetForecastDay[];
  effective_new_limit?: number; forecast_assumption?: string;
  new_words_started_today?: number;
  cost_profile?: LearningCostProfile;
  effective_used_seconds?: number; reserved_estimated_seconds?: number; review_override?: boolean;
  unreserved_due_count?: number; unreserved_overdue_count?: number;
  outstanding_due_count?: number; outstanding_overdue_count?: number; reserved_due_count?: number;
  first_answer_samples?: number; first_answer_correct_ratio?: number | null;
  young_count?: number; estimated_daily_review_count?: number;
  time_history?: BudgetHistoryDay[]; new_word_history?: BudgetHistoryDay[];
  exam_goal?: ExamBudgetGoal | null;
  adaptive_plan?: AdaptiveDailyBudgetPlan;
  reason_codes?: AdaptiveBudgetReasonCode[];
  estimated_review_seconds?: number; estimated_new_word_seconds?: number;
  estimated_total_seconds?: number;
}
export class LearningBudgetReached extends Error {
  constructor() { super("今日预计学习预算已用完，可加练 15 分钟后继续。"); this.name = "LearningBudgetReached"; }
}
/** Good-only, no-fuzz forecast on disposable cards. Never schedules real cards. */
export function newWordForecast(count: number, newCost = 77, reviewCost = 8): number[] {
  const scheduler = createFsrsScheduler(false);
  const start = new Date("2026-01-01T00:00:00Z");
  const seconds = Array(7).fill(count * newCost) as number[];
  for (let introduced = 0; introduced < 7; introduced++) {
    const now = new Date(start.getTime() + introduced * 86400000);
    let card = scheduler.next(createEmptyCard(now), now, Rating.Good).card;
    for (let day = introduced + 1; day < 7; day++) {
      const when = new Date(start.getTime() + day * 86400000);
      if (card.due <= when) { seconds[day]! += count * reviewCost; card = scheduler.next(card, when, Rating.Good).card; }
    }
  }
  return seconds;
}
export function newWordAllowance(b: BudgetSnapshot): number {
  if (!b.enabled) return b.new_word_cap;
  return adaptiveDailyBudgetV2Enabled()
    ? getAdaptiveBudgetPlan(b).recommended_new_words_total
    : newWordAllowanceV1(b);
}
/** Conservative V1 fallback, retained for the feature-flag rollback path. */
function newWordAllowanceV1(b: BudgetSnapshot): number {
  const newCost = b.cost_profile?.new_word_seconds ?? 77;
  const reviewCost = b.cost_profile?.review_seconds ?? 8;
  const started = Math.max(0, b.new_words_started_today ?? 0);
  const slots = Math.max(0, b.new_word_cap - started);
  if (!b.enabled) return b.new_word_cap;
  const dueCount = Math.max(0, b.unreserved_due_count ?? b.due_count);
  const overdueCount = Math.max(0, b.unreserved_overdue_count ?? b.overdue_count);
  if (overdueCount > 0 || dueCount * reviewCost >= b.remaining_seconds) return started;
  const available = b.remaining_seconds - dueCount * reviewCost;
  const today = Math.min(slots, Math.floor(Math.max(0, available) / newCost));
  for (let n = today; n >= 0; n--) {
    const projected = newWordForecast(n, newCost, reviewCost);
    if (projected.every((s, day) => {
      const future = b.forecast[day];
      const dueSeconds = typeof future?.review_count === "number"
        ? future.review_count * reviewCost
        : future?.review_seconds ?? 0;
      return s + dueSeconds <= b.daily_minutes * 60;
    })) return Math.min(b.new_word_cap, started + n);
  }
  return started;
}
export function getAdaptiveBudgetPlan(b: BudgetSnapshot): AdaptiveDailyBudgetPlan {
  const profile = b.cost_profile;
  const reviewCost = profile?.review_seconds ?? 8;
  const forecastDays = [...(b.forecast ?? [])]
    .filter(day => day.date !== b.date)
    .slice(0, 14);
  const futureDueSeconds = Array.from({ length: 14 }, (_, index) => {
    const day = forecastDays[index];
    if (!day) return 0;
    return typeof day.review_count === "number"
      ? day.review_count * reviewCost
      : day.review_seconds;
  });
  const sampleCount = b.first_answer_samples ?? 0;
  const confidence: CostConfidence = sampleCount >= 20 ? "moderate" : sampleCount > 0 ? "low" : "cold";
  const correctRatio = typeof b.first_answer_correct_ratio === "number"
    ? Math.max(0, Math.min(1, b.first_answer_correct_ratio)) : 1;
  const exam = b.exam_goal?.target_date
    ? { target_date: b.exam_goal.target_date, remaining_unique_words: Math.max(0, b.exam_goal.remaining_unique_words) }
    : undefined;
  return planAdaptiveDailyBudget({
    remaining_seconds: Math.max(0, b.remaining_seconds),
    daily_minutes: Math.max(0, b.daily_minutes),
    extra_seconds: Math.max(0, b.extra_seconds),
    due_count: Math.max(0, b.unreserved_due_count ?? b.due_count),
    overdue_count: Math.max(0, b.unreserved_overdue_count ?? b.overdue_count),
    carryover_due_count: Math.max(0, b.outstanding_due_count ?? b.due_count),
    review_cost_seconds: reviewCost,
    new_word_cost_seconds: profile?.new_word_seconds ?? 77,
    new_word_cap: Math.max(0, b.new_word_cap),
    new_words_started_today: Math.max(0, b.new_words_started_today ?? 0),
    future_due_seconds: futureDueSeconds,
    young_count: b.young_count,
    estimated_daily_review_seconds: (b.estimated_daily_review_count ?? 0) * reviewCost,
    recent_first_answers: { correct_ratio: correctRatio, samples: sampleCount, confidence },
    new_word_cost_confidence: profile?.new_word_confidence ?? "cold",
    ...(exam ? { exam, today_local: b.date } : {}),
  });
}
/** Bound admission even when an older import already prepared more words. */
export function newWordAdmissionLimit(b: BudgetSnapshot): number {
  const remaining = Math.max(0, (b.effective_new_limit ?? newWordAllowance(b)) - (b.new_words_started_today ?? 0));
  if ((b.remaining_seconds < 8 || b.estimated_used_seconds >= b.daily_minutes * 60 + b.extra_seconds) && b.review_override) return 0;
  return Math.min(6, remaining);
}
export async function getLearningBudget(db = getDatabase(), userId = getAuthenticatedUserId()): Promise<BudgetSnapshot> {
  const r = await db.rpc("learning_budget_snapshot_v1", { p_user_id: userId });
  assertDatabaseResult(r.error);
  if (!r.data || typeof r.data.remaining_seconds !== "number") throw new Error("BUDGET_SNAPSHOT_UNAVAILABLE");
  const profile = await getUserLearningCostProfile(userId, db);
  const b = { ...r.data, cost_profile: profile, ...(profile.time_history && profile.time_history.length >= 30 ? { time_history: profile.time_history } : {}) } as BudgetSnapshot;
  if (!b.enabled) return { ...b, effective_new_limit: b.new_word_cap, forecast_assumption: "已关闭时间预算自动准入，仍遵守新词安全上限。" };
  if (adaptiveDailyBudgetV2Enabled()) {
    try {
      const plan = getAdaptiveBudgetPlan(b);
      const isPersonal = profile.new_word_samples > 0;
      const assumption = isPersonal
        ? `完整新词成本由个人 ${profile.new_word_samples} 个有效教学样本收缩估算。`
        : "学习历史不足，使用原有 77 秒/新词冷启动成本。";
      // The snapshot charges max(measured, reserved) against remaining time;
      // the displayed total must use the same reserved-aware value, because the
      // plan's projections already exclude tasks covered by a reservation.
      const usedSeconds = Math.max(b.estimated_used_seconds, b.effective_used_seconds ?? 0);
      const estimatedTotal = usedSeconds
        + plan.projected_review_seconds + plan.projected_new_word_seconds;
      return {
        ...b,
        effective_new_limit: plan.recommended_new_words_total,
        forecast_assumption: `${assumption}未来预测采用当前 TS-FSRS 参数的正常与偏高情景。`,
        adaptive_plan: plan,
        reason_codes: plan.reason_codes,
        estimated_review_seconds: plan.projected_review_seconds,
        estimated_new_word_seconds: plan.projected_new_word_seconds,
        estimated_total_seconds: estimatedTotal,
      };
    } catch {
      // A planner failure must not block review, grading or progress writes.
      const allowance = newWordAllowanceV1(b);
      return { ...b, effective_new_limit: allowance, forecast_assumption: "预算规划暂不可用，沿用保守固定成本准入。" };
    }
  }
  const costNote = profile.new_word_samples > 0
    ? `完整新词成本按个人已完成教学样本估算（${profile.new_word_samples} 词）`
    : "完整新词成本按初始 77 秒估算";
  return { ...b, effective_new_limit: newWordAllowanceV1(b), forecast_assumption: `${costNote}；沿用保守静态准入。` };
}
export async function reserveLearningBudget(key: string, activity: string, scope?: string, db = getDatabase(), userId = getAuthenticatedUserId()) {
  const profile = await getUserLearningCostProfile(userId, db);
  const costScope = scope ?? (activity === "review" ? "review" : activity === "pretest" ? "pretest" : "lesson");
  const costActivity = activity === "pretest" ? "pretest_cn_to_en" : activity;
  const seconds = Math.ceil((profile.costs[`${costScope}:${costActivity}`]?.seconds ?? activityCost(activity, scope)) + (profile.costs[`${costScope}:${costActivity}:feedback`]?.seconds ?? 0) + (scope === "lesson" ? profile.costs["lesson:explanation"]!.seconds : 0));
  const r = await db.rpc("reserve_learning_budget_v1", { p_user_id: userId, p_task_key: key, p_seconds: seconds, p_activity: activity });
  assertDatabaseResult(r.error);
  if (r.data !== true) throw new LearningBudgetReached();
}
export async function continueDueReview(db = getDatabase(), userId = getAuthenticatedUserId()) {
  const result = await db.rpc("enable_daily_review_v2", { p_user_id: userId });
  assertDatabaseResult(result.error);
}
export async function addOneGroupBudget(requestId: string, db = getDatabase(), userId = getAuthenticatedUserId()) {
  const budget = await getLearningBudget(db, userId);
  // Manual continuation is a user choice to add one more group. Size the
  // addition from the remaining safety ceiling, then let the planner recalculate
  // against today's due work and future FSRS burden after the extra time lands.
  const words = Math.min(6, Math.max(0, budget.new_word_cap-(budget.new_words_started_today ?? 0)));
  const dueCount = Math.max(0, budget.unreserved_due_count ?? budget.due_count);
  if (!words && !dueCount) return false;
  const groupReviewCount = Math.min(25, dueCount);
  const seconds = Math.ceil(words*(budget.cost_profile?.new_word_seconds ?? 77) + groupReviewCount*(budget.cost_profile?.review_seconds ?? 8) + 60);
  await setLearningBudget(undefined, `group:${requestId}:${Math.min(3600,seconds)}`, db, userId);
  return true;
}
export async function setLearningBudget(minutes?: number, addKey?: string, db = getDatabase(), userId = getAuthenticatedUserId()) {
  const r = await db.rpc("set_learning_budget_v1", { p_user_id: userId, p_minutes: minutes ?? null, p_add_key: addKey ?? null });
  assertDatabaseResult(r.error); return r.data as BudgetSnapshot;
}
export async function setAdaptiveExamGoal(
  targetDate: string | null,
  coverageTarget: number | null,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
) {
  const result = await db.rpc("set_adaptive_exam_goal_v2", {
    p_user_id: userId,
    p_exam_deadline: targetDate,
    p_coverage_target: coverageTarget,
  });
  assertDatabaseResult(result.error);
  if (result.data !== true) throw new Error("EXAM_BOOK_REQUIRED");
  return getLearningBudget(db, userId);
}
