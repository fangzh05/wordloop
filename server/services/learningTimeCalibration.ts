import { z } from "zod";
import { getAuthenticatedUserId, getDatabase, learningTimeCalibrationEnabled } from "../db.js";
import { activityCost } from "../../shared/learningEvidence.js";

export const TIME_MODEL_VERSION = "personal-time-v2-pilot";
// Provisional conservative prior. Production has zero active-time samples;
// this parameter is intentionally NOT claimed to be selected by backtesting.
export const PRIOR_SAMPLES = 20;
const summarySchema = z.object({ activity_type: z.string(), scope: z.string(), stage: z.enum(["answer", "feedback", "explanation"]), samples: z.number().nonnegative(), total_ms: z.number().nonnegative(), histogram: z.record(z.string(), z.number().nonnegative()), updated_at: z.string() });
export type TimeSummary = z.infer<typeof summarySchema>;
export interface CostEstimate { seconds: number; samples: number; confidence: "cold" | "low" | "moderate"; source: "static" | "related" | "personal" }
export interface LearningCostProfile { version: string; costs: Record<string, CostEstimate>; review_seconds: number; new_word_seconds: number; new_word_source: "lifecycle_estimate" | "static"; new_word_samples: number; new_word_confidence: "cold" | "low" | "moderate"; updated_at: string | null }
export function estimateTime(rows: TimeSummary[], activity: string, scope: string, stage: TimeSummary["stage"] = "answer", fallback = activityCost(activity, scope)): CostEstimate {
  const family = (a: string) => a.startsWith("translation") ? "translation" : ["cloze", "exact_cloze", "word_recall", "spelling"].includes(a) ? "recall" : a;
  let selected = rows.filter(r => r.activity_type === activity && r.scope === scope && r.stage === stage);
  let related = false;
  if (!selected.some(r => r.samples > 0)) { selected = rows.filter(r => r.scope === scope && r.stage === stage && family(r.activity_type) === family(activity)); related = true; }
  const n = selected.reduce((s, r) => s + r.samples, 0);
  if (!n) return { seconds: fallback, samples: 0, confidence: "cold", source: "static" };
  const histogram = new Map<number, number>();
  for (const row of selected) for (const [bucket, count] of Object.entries(row.histogram)) histogram.set(Number(bucket), (histogram.get(Number(bucket)) ?? 0) + count);
  // Five-second histograms, clipped to a fixed domain cap (3x fallback).
  // A capped histogram mean is stable and cheap; do not present this as an empirical P90.
  const bins = [...histogram].sort((a, b) => a[0] - b[0]);
  const personal = bins.reduce((s, [bucket, count]) => s + Math.min(bucket * 5 + 2.5, fallback * 3) * count, 0) / n;
  const weight = n / (n + PRIOR_SAMPLES * (related ? 2 : 1));
  const bounded = Math.max(fallback * .5, Math.min(fallback * 3, personal));
  return { seconds: Math.round((weight * bounded + (1 - weight) * fallback) * 10) / 10, samples: n, confidence: n < 30 ? "low" : "moderate", source: related ? "related" : "personal" };
}
export function buildLearningCostProfile(rows: TimeSummary[]): LearningCostProfile {
  const costs: Record<string, CostEstimate> = {};
  for (const scope of ["review", "pretest", "lesson", "consolidation"]) for (const activity of ["review", "pretest_cn_to_en", "word_recall", "cloze", "exact_cloze", "collocation", "derivation", "translation_cn_to_en", "translation_en_to_cn", "sentence"]) {
    costs[`${scope}:${activity}`] = estimateTime(rows, activity, scope);
  }
  const explanation = estimateTime(rows, "explanation", "lesson", "explanation", 30);
  costs["lesson:explanation"] = explanation;
  for (const row of rows.filter(r => r.stage === "feedback")) costs[`${row.scope}:${row.activity_type}:feedback`] = estimateTime(rows, row.activity_type, row.scope, "feedback", 5);
  const newWord = estimateTime(rows, "__complete_new_word__", "lesson", "answer", 77);
  return { version: TIME_MODEL_VERSION, costs, review_seconds: costs["review:review"]!.seconds + (costs["review:review:feedback"]?.seconds ?? 0), new_word_seconds: newWord.seconds, new_word_source: newWord.samples ? "lifecycle_estimate" : "static", new_word_samples: newWord.samples, new_word_confidence: newWord.confidence, updated_at: rows.map(r => r.updated_at).sort().at(-1) ?? null };
}
const cache = new WeakMap<object, Map<string, { until: number; value: LearningCostProfile }>>();
export async function getUserLearningCostProfile(userId = getAuthenticatedUserId(), db = getDatabase()): Promise<LearningCostProfile> {
  if (!learningTimeCalibrationEnabled()) return buildLearningCostProfile([]);
  let entries = cache.get(db);
  if (!entries) { entries = new Map(); cache.set(db, entries); }
  const cached = entries.get(userId);
  if (cached && cached.until > Date.now()) return cached.value;
  try {
    const result = await db.rpc("user_learning_time_profile_v2", { p_user_id: userId });
    if (result.error) return buildLearningCostProfile([]);
    const value = buildLearningCostProfile(z.array(summarySchema).max(240).parse(result.data));
    if (entries.size >= 64) entries.delete(entries.keys().next().value!);
    entries.set(userId, { until: Date.now() + 60000, value });
    return value;
  } catch { return buildLearningCostProfile([]); }
}
export const timeObservationSchema = z.object({ session_id: z.string().uuid(), phase: z.string().min(1).max(50), index: z.number().int().min(0).max(500), retry: z.number().int().min(0).max(100), stage: z.enum(["answer", "feedback", "explanation"]), local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), phase_started_at: z.string().datetime(), active_ms: z.number().int().min(0).max(600000), finalize: z.boolean(), rollover: z.boolean().optional() }).strict();
export async function recordLearningTime(input: z.infer<typeof timeObservationSchema>, db = getDatabase(), userId = getAuthenticatedUserId()) {
  if (!learningTimeCalibrationEnabled()) return { recorded: false };
  const value = timeObservationSchema.parse(input);
  // Telemetry failure must never prevent the following formal submission.
  try { const r = await db.rpc("record_learning_time_v2", { p_user_id: userId, p_observation: value }); return { recorded: !r.error && r.data === true }; } catch { return { recorded: false }; }
}
