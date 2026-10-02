import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { assertDatabaseResult } from "./shared.js";
import { activityCost } from "../../shared/learningEvidence.js";
import { createEmptyCard, Rating } from "ts-fsrs";
import { createFsrsScheduler } from "./fsrsScheduler.js";

export interface BudgetSnapshot {
  date: string; daily_minutes: number; extra_seconds: number; estimated_used_seconds: number;
  remaining_seconds: number; due_count: number; overdue_count: number; new_word_cap: number;
  enabled: boolean; forecast: Array<{ date: string; review_seconds: number }>;
  effective_new_limit?: number; forecast_assumption?: string;
}
export class LearningBudgetReached extends Error {
  constructor() { super("今日预计学习预算已用完，可加练 15 分钟后继续。"); this.name = "LearningBudgetReached"; }
}
/** Good-only, no-fuzz forecast on disposable cards. Never schedules real cards. */
export function newWordForecast(count: number): number[] {
  const scheduler = createFsrsScheduler(false);
  const start = new Date("2026-01-01T00:00:00Z");
  const seconds = Array(7).fill(count * 77) as number[];
  for (let introduced = 0; introduced < 7; introduced++) {
    const now = new Date(start.getTime() + introduced * 86400000);
    let card = scheduler.next(createEmptyCard(now), now, Rating.Good).card;
    for (let day = introduced + 1; day < 7; day++) {
      const when = new Date(start.getTime() + day * 86400000);
      if (card.due <= when) { seconds[day]! += count * 8; card = scheduler.next(card, when, Rating.Good).card; }
    }
  }
  return seconds;
}
export function newWordAllowance(b: BudgetSnapshot): number {
  if (!b.enabled) return b.new_word_cap;
  if (b.overdue_count > 0 || b.due_count * 8 >= b.remaining_seconds) return 0;
  const available = b.remaining_seconds - b.due_count * 8;
  const today = Math.min(b.new_word_cap, Math.floor(available / 77));
  for (let n = today; n >= 0; n--) {
    const projected = newWordForecast(n);
    if (projected.every((s, day) => s + (b.forecast[day]?.review_seconds ?? 0) <= b.daily_minutes * 60)) return n;
  }
  return 0;
}
export async function getLearningBudget(db = getDatabase(), userId = getAuthenticatedUserId()): Promise<BudgetSnapshot> {
  const r = await db.rpc("learning_budget_snapshot_v1", { p_user_id: userId });
  assertDatabaseResult(r.error);
  if (!r.data || typeof r.data.remaining_seconds !== "number") throw new Error("BUDGET_SNAPSHOT_UNAVAILABLE");
  const b = r.data as BudgetSnapshot;
  return { ...b, effective_new_limit: newWordAllowance(b), forecast_assumption: "静态成本；新增词按每日同量、FSRS Good 且不漏学预测。不是实际计时或准确预报。" };
}
export async function reserveLearningBudget(key: string, activity: string, scope?: string, db = getDatabase(), userId = getAuthenticatedUserId()) {
  const seconds = activityCost(activity, scope) + (scope === "lesson" ? 30 : 0);
  const r = await db.rpc("reserve_learning_budget_v1", { p_user_id: userId, p_task_key: key, p_seconds: seconds, p_activity: activity });
  assertDatabaseResult(r.error);
  if (r.data !== true) throw new LearningBudgetReached();
}
export async function setLearningBudget(minutes?: number, addKey?: string, db = getDatabase(), userId = getAuthenticatedUserId()) {
  const r = await db.rpc("set_learning_budget_v1", { p_user_id: userId, p_minutes: minutes ?? null, p_add_key: addKey ?? null });
  assertDatabaseResult(r.error); return r.data as BudgetSnapshot;
}
