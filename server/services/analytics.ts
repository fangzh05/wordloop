import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { analyticsEnvelopeSchema, analyticsRangeSchema, todayOverviewSchema, type AnalyticsEnvelope, type AnalyticsRange, type AnalyticsSection } from "../../shared/analyticsContracts.js";
import type { UserWordRow } from "../types.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { cardFromUserWord, createFsrsScheduler } from "./fsrsScheduler.js";
import { addCalendarDays, dateInTimeZone, localDateRange } from "./shared.js";
import { getUserTimeZone } from "./words.js";
import { normalizeWord } from "./wordNormalization.js";
import { normalizeStudyStateForRead, studyStateSchema } from "./studySessions.js";

const DEFINITION_VERSION = "wordloop-analytics-v1" as const;
const PAGE_SIZE = 1000;
const MAX_SCATTER_POINTS = 1000;
const reviewRowSchema = z.object({
  local_date: z.string(),
  first_review_count: z.coerce.number(),
  eligible_count: z.coerce.number(),
  successes: z.coerce.number(),
  failures: z.coerce.number(),
  invalid_rating_count: z.coerce.number(),
  below_interval_count: z.coerce.number(),
});

const userWordSelect = "id,user_id,word_id,status,source,first_seen_at,last_seen_at,last_reviewed_at,correct_count,wrong_count,consecutive_correct,meaning_error,collocation_error,grammar_error,pronunciation_error,spelling_error,mastered,next_review_at,fsrs_stability,fsrs_difficulty,fsrs_elapsed_days,fsrs_scheduled_days,fsrs_learning_steps,fsrs_reps,fsrs_lapses,fsrs_state";

export class AnalyticsServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AnalyticsServiceError";
  }
}

interface ReviewDay {
  local_date: string;
  first_review_count: number;
  eligible_count: number;
  successes: number;
  failures: number;
  invalid_rating_count: number;
  below_interval_count: number;
}

interface MemoryCardView {
  user_word_id: string;
  word_id: string;
  difficulty: number;
  stability_days: number;
  retrievability: number | null;
  lapses: number;
  next_review_at: string | null;
}

interface FocusCandidate extends MemoryCardView {
  active_error_layers: string[];
  reasons: string[];
  is_overdue: boolean;
}

function daysForRange(range: AnalyticsRange): number {
  return Number.parseInt(range, 10);
}

function validateTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw new AnalyticsServiceError(500, "INVALID_USER_TIMEZONE", "用户时区设置无效，无法生成学习洞察。");
  }
}

function assertDb(error: { message?: string } | null): void {
  if (error) throw new AnalyticsServiceError(500, "ANALYTICS_QUERY_FAILED", "学习洞察暂时不可用，请稍后重试。");
}

function envelope<T>(data: T, asOf: Date, timeZone: string, coverage: Record<string, unknown>, nextCursor?: string | null): AnalyticsEnvelope<T> {
  return analyticsEnvelopeSchema.parse({
    data,
    as_of: asOf.toISOString(),
    timezone: timeZone,
    definition_version: DEFINITION_VERSION,
    coverage,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  }) as AnalyticsEnvelope<T>;
}

function baseCoverage(asOf: Date, timeZone: string, days: number) {
  const through = dateInTimeZone(timeZone, asOf);
  return {
    from: addCalendarDays(through, -(days - 1)),
    through,
    event_tables: ["fsrs_review_logs", "attempts", "captured_note_occurrences"],
    first_lesson_completion: "unavailable",
  };
}

async function context(db: SupabaseClient, userId: string) {
  const asOf = new Date();
  const timeZone = validateTimeZone(await getUserTimeZone(db, userId));
  return { asOf, timeZone, today: dateInTimeZone(timeZone, asOf) };
}

async function readReviewDays(
  db: SupabaseClient,
  userId: string,
  asOf: Date,
  timeZone: string,
  days: number,
): Promise<ReviewDay[]> {
  const result = await db.rpc("get_analytics_review_days_v1", {
    p_user_id: userId,
    p_as_of: asOf.toISOString(),
    p_timezone: timeZone,
    p_days: days,
  });
  assertDb(result.error);
  return (result.data ?? []).map((value: unknown) => reviewRowSchema.parse(value));
}

async function readDueDistribution(db: SupabaseClient, userId: string, asOf: Date, timeZone: string): Promise<Record<string, unknown>> {
  const result = await db.rpc("get_analytics_due_distribution_v1", {
    p_user_id: userId,
    p_as_of: asOf.toISOString(),
    p_timezone: timeZone,
  });
  assertDb(result.error);
  if (typeof result.data !== "object" || result.data === null || Array.isArray(result.data)) {
    throw new AnalyticsServiceError(500, "ANALYTICS_INVALID_RESPONSE", "到期分布结果无法读取。");
  }
  return result.data as Record<string, unknown>;
}

async function readMemoryRows(db: SupabaseClient, userId: string): Promise<UserWordRow[]> {
  const rows: UserWordRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db.from("user_words")
      .select(userWordSelect)
      .eq("user_id", userId)
      .gt("fsrs_reps", 0)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    assertDb(result.error);
    const page = (result.data ?? []) as unknown as UserWordRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function readActiveErrorRows(db: SupabaseClient, userId: string): Promise<UserWordRow[]> {
  const rows: UserWordRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db.from("user_words")
      .select(userWordSelect)
      .eq("user_id", userId)
      .or("meaning_error.eq.true,collocation_error.eq.true,grammar_error.eq.true,pronunciation_error.eq.true,spelling_error.eq.true")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    assertDb(result.error);
    const page = (result.data ?? []) as unknown as UserWordRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function bucketIndex(value: number, boundaries: readonly number[]): number {
  const index = boundaries.findIndex((edge) => value < edge);
  return index === -1 ? boundaries.length : index;
}

function summarizeCounts(values: number[], labels: readonly string[], boundaries: readonly number[]) {
  const counts = new Array(labels.length).fill(0) as number[];
  for (const value of values) {
    const index = bucketIndex(value, boundaries);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return labels.map((label, index) => ({ label, count: counts[index] ?? 0 }));
}

export function getRetrievability(row: UserWordRow, asOf: Date, scheduler = createFsrsScheduler()): number | null {
  if (row.fsrs_reps <= 0 || !row.last_reviewed_at || !finite(row.fsrs_stability) || row.fsrs_stability <= 0) return null;
  try {
    const value = scheduler.get_retrievability(cardFromUserWord(row), asOf, false);
    return typeof value === "number" && finite(value) && value >= 0 && value <= 1 ? value : null;
  } catch {
    return null;
  }
}

function memoryCardRows(rows: readonly UserWordRow[], asOf: Date, scheduler = createFsrsScheduler()): MemoryCardView[] {
  return rows.flatMap((row) => {
    const difficulty = row.fsrs_difficulty;
    const stability = row.fsrs_stability;
    if (!finite(difficulty) || difficulty < 1 || difficulty > 10 || !finite(stability) || stability <= 0) return [];
    return [{
      user_word_id: row.id,
      word_id: row.word_id,
      difficulty,
      stability_days: stability,
      retrievability: getRetrievability(row, asOf, scheduler),
      lapses: row.fsrs_lapses,
      next_review_at: row.next_review_at,
    }];
  });
}

export function memorySummary(rows: readonly UserWordRow[], asOf: Date, scheduler = createFsrsScheduler()) {
  const validStabilities = rows.map((row) => row.fsrs_stability).filter((value) => finite(value) && value > 0);
  const validDifficulties = rows.map((row) => row.fsrs_difficulty).filter((value) => finite(value) && value >= 1 && value <= 10);
  const cards = memoryCardRows(rows, asOf, scheduler);
  const retrievabilities = rows.flatMap((row) => {
    const value = getRetrievability(row, asOf, scheduler);
    return value === null ? [] : [value];
  });
  const invalidMemoryValues = rows.filter((row) =>
    !finite(row.fsrs_stability) || row.fsrs_stability <= 0
      || !finite(row.fsrs_difficulty) || row.fsrs_difficulty < 1 || row.fsrs_difficulty > 10,
  ).length;
  const scatterCandidates = cards.slice().sort((left, right) => left.user_word_id.localeCompare(right.user_word_id));
  const visibleScatter = scatterCandidates.length <= MAX_SCATTER_POINTS
    ? scatterCandidates
    : Array.from({ length: MAX_SCATTER_POINTS }, (_, index) => scatterCandidates[Math.floor(index * scatterCandidates.length / MAX_SCATTER_POINTS)]!);
  return {
    scheduled_word_count: rows.length,
    valid_stability_count: validStabilities.length,
    valid_difficulty_count: validDifficulties.length,
    retrievability_count: retrievabilities.length,
    retrievability_below_target_count: retrievabilities.filter((value) => value < 0.9).length,
    retrievability_missing_count: rows.length - retrievabilities.length,
    excluded_count: invalidMemoryValues,
    stability_days: {
      mean: mean(validStabilities),
      median: median(validStabilities),
      histogram: summarizeCounts(validStabilities, ["<1", "1–3", "3–7", "7–30", "30–90", "90–365", "365+"], [1, 3, 7, 30, 90, 365]),
    },
    difficulty: {
      mean: mean(validDifficulties),
      median: median(validDifficulties),
      histogram: summarizeCounts(validDifficulties, ["1–2", "2–3", "3–4", "4–5", "5–6", "6–7", "7–8", "8–9", "9–10"], [2, 3, 4, 5, 6, 7, 8, 9, 10.000001]),
    },
    retrievability: {
      histogram: summarizeCounts(retrievabilities, ["0–10%", "10–20%", "20–30%", "30–40%", "40–50%", "50–60%", "60–70%", "70–80%", "80–90%", "90–100%"], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.000001]),
    },
    scatter: {
      total: scatterCandidates.length,
      visible: visibleScatter.length,
      sampled: scatterCandidates.length > MAX_SCATTER_POINTS,
      points: visibleScatter.map((point) => ({
        user_word_id: point.user_word_id,
        word_id: point.word_id,
        difficulty: point.difficulty,
        stability_days: point.stability_days,
        retrievability: point.retrievability,
      })),
    },
  };
}

async function readDisplayWords(db: SupabaseClient, wordIds: readonly string[]): Promise<Map<string, { display_word: string; ipa_us: string | null; ipa_uk: string | null }>> {
  const result = new Map<string, { display_word: string; ipa_us: string | null; ipa_uk: string | null }>();
  for (let offset = 0; offset < wordIds.length; offset += 500) {
    const chunk = wordIds.slice(offset, offset + 500);
    if (chunk.length === 0) continue;
    const query = await db.from("words").select("id,display_word,ipa_us,ipa_uk").in("id", chunk);
    assertDb(query.error);
    for (const row of (query.data ?? []) as Array<{ id: string; display_word: string; ipa_us: string | null; ipa_uk: string | null }>) {
      result.set(row.id, { display_word: row.display_word, ipa_us: row.ipa_us, ipa_uk: row.ipa_uk });
    }
  }
  return result;
}

function rateValue(passes: number, samples: number): number | null {
  return samples === 0 ? null : passes / samples;
}

export function reviewSummaryAndTrend(rows: readonly ReviewDay[], asOf: Date, timeZone: string, days: number) {
  const today = dateInTimeZone(timeZone, asOf);
  const firstDate = addCalendarDays(today, -(days - 1));
  const selected = rows.filter((row) => row.local_date >= firstDate && row.local_date <= today);
  const totals = selected.reduce((sum, row) => ({
    samples: sum.samples + row.eligible_count,
    passes: sum.passes + row.successes,
    failures: sum.failures + row.failures,
    invalid: sum.invalid + row.invalid_rating_count,
    belowInterval: sum.belowInterval + row.below_interval_count,
    firstReviews: sum.firstReviews + row.first_review_count,
  }), { samples: 0, passes: 0, failures: 0, invalid: 0, belowInterval: 0, firstReviews: 0 });
  const byDate = new Map(rows.map((row) => [row.local_date, row]));
  const trend = selected.map((row) => {
    const rollup = (windowDays: number) => {
      const minDate = addCalendarDays(row.local_date, -(windowDays - 1));
      const subset = rows.filter((item) => item.local_date >= minDate && item.local_date <= row.local_date);
      const samples = subset.reduce((sum, item) => sum + item.eligible_count, 0);
      const passes = subset.reduce((sum, item) => sum + item.successes, 0);
      return { samples, passes, rate: rateValue(passes, samples) };
    };
    return {
      date: row.local_date,
      rolling_7d: rollup(7),
      rolling_30d: rollup(30),
      is_partial_today: row.local_date === today,
    };
  });
  return {
    summary: {
      samples: totals.samples,
      passes: totals.passes,
      failures: totals.failures,
      invalid_ratings: totals.invalid,
      below_interval_first_reviews: totals.belowInterval,
      first_formal_reviews: totals.firstReviews,
      success_rate: rateValue(totals.passes, totals.samples),
      small_sample: totals.samples < 30,
      as_of_note: selected.some((row) => row.local_date === today) ? "今日截至当前" : null,
    },
    trend,
  };
}

function activeErrorLayers(row: UserWordRow): string[] {
  const layers: string[] = [];
  if (row.meaning_error) layers.push("meaning");
  if (row.collocation_error) layers.push("collocation");
  if (row.grammar_error) layers.push("grammar");
  if (row.pronunciation_error) layers.push("pronunciation");
  if (row.spelling_error) layers.push("spelling");
  return layers;
}

function buildFocusCandidates(
  rows: readonly UserWordRow[],
  activeIds: ReadonlySet<string>,
  asOf: Date,
): FocusCandidate[] {
  const scheduler = createFsrsScheduler();
  const focus: FocusCandidate[] = [];
  for (const row of rows) {
    const layers = activeErrorLayers(row);
    const hasActiveError = activeIds.has(row.id) || layers.length > 0;
    const dueTime = row.next_review_at ? Date.parse(row.next_review_at) : Number.POSITIVE_INFINITY;
    const isOverdue = row.fsrs_reps > 0 && finite(dueTime) && dueTime < asOf.getTime();
    const retrievability = getRetrievability(row, asOf, scheduler);
    const hasValidMemory = finite(row.fsrs_stability) && row.fsrs_stability > 0
      && finite(row.fsrs_difficulty) && row.fsrs_difficulty >= 1 && row.fsrs_difficulty <= 10;
    const isHighDifficultyLowStability = hasValidMemory && row.fsrs_difficulty >= 7 && row.fsrs_stability <= 2;
    const reasons = [
      ...(hasActiveError ? ["active_error"] : []),
      ...(isOverdue ? ["overdue"] : []),
      ...(retrievability !== null && retrievability < 0.9 ? ["r_below_target"] : []),
      ...(isHighDifficultyLowStability ? ["high_d_low_s"] : []),
    ];
    if (reasons.length === 0) continue;
    focus.push({
      user_word_id: row.id,
      word_id: row.word_id,
      difficulty: hasValidMemory ? row.fsrs_difficulty : Number.NaN,
      stability_days: hasValidMemory ? row.fsrs_stability : Number.NaN,
      retrievability,
      lapses: row.fsrs_lapses,
      next_review_at: row.next_review_at,
      active_error_layers: layers,
      reasons,
      is_overdue: isOverdue,
    });
  }
  return focus.sort((left, right) => {
    const activeOrder = Number(right.reasons.includes("active_error")) - Number(left.reasons.includes("active_error"));
    if (activeOrder) return activeOrder;
    const overdueOrder = Number(right.is_overdue) - Number(left.is_overdue);
    if (overdueOrder) return overdueOrder;
    const leftR = left.retrievability ?? Number.POSITIVE_INFINITY;
    const rightR = right.retrievability ?? Number.POSITIVE_INFINITY;
    if (leftR !== rightR) return leftR - rightR;
    if (left.lapses !== right.lapses) return right.lapses - left.lapses;
    return left.word_id.localeCompare(right.word_id);
  });
}

function pageOffset(cursor: string): number {
  if (!cursor) return 0;
  if (!/^\d{1,8}$/u.test(cursor)) throw new AnalyticsServiceError(400, "INVALID_CURSOR", "学习洞察分页游标无效。");
  return Number(cursor);
}

async function readErrorMatrix(db: SupabaseClient, userId: string, asOf: Date, timeZone: string, days: number) {
  const result = await db.rpc("get_analytics_error_matrix_v1", {
    p_user_id: userId,
    p_as_of: asOf.toISOString(),
    p_timezone: timeZone,
    p_days: days,
  });
  assertDb(result.error);
  return (result.data ?? []) as Array<{
    activity_type: string;
    error_layer: string;
    error_events: number;
    distinct_words: number;
    activity_attempts: number;
    determinable_attempts: number;
  }>;
}

export async function getTodayOverview(
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
) {
  const { asOf, timeZone } = await context(db, userId);
  const { start, end } = localDateRange(dateInTimeZone(timeZone, asOf), timeZone);
  const [session, progress, completedLessonWords, inboxCount] = await Promise.all([
    db.from("study_sessions").select("id,state,started_at,updated_at,ended_at")
      .eq("user_id", userId).is("ended_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle(),
    import("./progress.js").then(({ getProgress }) => getProgress(db, userId, asOf)),
    import("./attempts.js").then(({ getTodayCompletedLessonWords }) => getTodayCompletedLessonWords(db, userId, asOf)),
    db.from("captured_notes").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "inbox"),
  ]);
  assertDb(session.error);
  assertDb(inboxCount.error);
  const todaySessions = await db.from("study_sessions").select("state")
    .eq("user_id", userId).gte("started_at", start).lt("started_at", end);
  assertDb(todaySessions.error);
  const relearnWords = new Set<string>();
  for (const rawState of [session.data?.state, ...(todaySessions.data ?? []).map((item: { state: unknown }) => item.state)]) {
    const parsed = studyStateSchema.safeParse(rawState);
    if (!parsed.success) continue;
    for (const word of normalizeStudyStateForRead(parsed.data).flow.relearn_words) {
      const normalized = normalizeWord(word);
      if (normalized) relearnWords.add(normalized);
    }
  }
  const completedRelearnWords = [...completedLessonWords].filter((word) => relearnWords.has(word)).length;
  const activeParsedState = session.data ? studyStateSchema.safeParse(session.data.state) : null;
  const activeState = activeParsedState?.success ? normalizeStudyStateForRead(activeParsedState.data) : null;
  const activeWidget = activeState?.widget === "review" || activeState?.widget === "pretest" || activeState?.widget === "lesson"
    ? activeState.widget
    : null;
  const phase = activeWidget === "review" ? "review" : activeWidget === "pretest" ? "pretest" : activeWidget === "lesson" ? "formal_learning" : "idle";
  return todayOverviewSchema.parse({
    as_of: asOf.toISOString(),
    timezone: timeZone,
    target_retention: Number(createFsrsScheduler().parameters.request_retention),
    active_session: session.data ? {
      active: true,
      phase,
      phase_detail: typeof activeState?.phase === "string" ? activeState.phase : null,
      started_at: session.data.started_at,
      updated_at: session.data.updated_at,
    } : { active: false, phase: "idle", phase_detail: null, started_at: null, updated_at: null },
    progress: {
      review: {
        ...progress.review_today,
        scope: phase === "review" ? "active_session" : "today_recorded_sessions",
      },
      pretest: progress.today,
      formal_learning: {
        completed_words: completedLessonWords.size,
        completed_distinct_words: completedLessonWords.size,
        new_words: Math.max(0, completedLessonWords.size - completedRelearnWords),
        relearn_words: completedRelearnWords,
      },
    },
    captures: { inbox_count: inboxCount.count ?? 0 },
  });
}

export async function getAnalyticsOverview(
  range: AnalyticsRange = "30d",
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<AnalyticsEnvelope<Record<string, unknown>>> {
  const days = daysForRange(range);
  const { asOf, timeZone } = await context(db, userId);
  const [reviewDays, dueDistribution, scheduledRows, activeRows] = await Promise.all([
    readReviewDays(db, userId, asOf, timeZone, days),
    readDueDistribution(db, userId, asOf, timeZone),
    readMemoryRows(db, userId),
    readActiveErrorRows(db, userId),
  ]);
  const review = reviewSummaryAndTrend(reviewDays, asOf, timeZone, days);
  const memory = memorySummary(scheduledRows, asOf);
  const focus = buildFocusCandidates(
    [...scheduledRows, ...activeRows.filter((row) => !scheduledRows.some((scheduled) => scheduled.id === row.id))],
    new Set(activeRows.map((row) => row.id)),
    asOf,
  ).slice(0, 3);
  const words = await readDisplayWords(db, focus.map((item) => item.word_id));
  const data = {
    range_days: days,
    long_term_first_recall: review.summary,
    success_trend: review.trend,
    current_memory: {
      scheduled_word_count: memory.scheduled_word_count,
      average_stability_days: memory.stability_days.mean,
      median_stability_days: memory.stability_days.median,
      average_difficulty: memory.difficulty.mean,
      median_difficulty: memory.difficulty.median,
      retrievability_below_target: memory.retrievability_below_target_count,
    },
    due_distribution: dueDistribution,
    focus_words: focus.map((item) => ({
      user_word_id: item.user_word_id,
      word_id: item.word_id,
      word: words.get(item.word_id)?.display_word ?? "",
      reasons: item.reasons,
      active_error_layers: item.active_error_layers,
      retrievability: item.retrievability,
      next_review_at: item.next_review_at,
    })),
  };
  return envelope(data, asOf, timeZone, {
    ...baseCoverage(asOf, timeZone, days),
    memory_snapshot: "current",
    target_retention: Number(createFsrsScheduler().parameters.request_retention),
  });
}

export async function getAnalyticsMemory(
  range: AnalyticsRange = "30d",
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<AnalyticsEnvelope<Record<string, unknown>>> {
  const days = daysForRange(range);
  const { asOf, timeZone } = await context(db, userId);
  const [reviewDays, dueDistribution, rows] = await Promise.all([
    readReviewDays(db, userId, asOf, timeZone, days),
    readDueDistribution(db, userId, asOf, timeZone),
    readMemoryRows(db, userId),
  ]);
  const memory = memorySummary(rows, asOf);
  const words = await readDisplayWords(db, memory.scatter.points.map((point) => point.word_id));
  const focus = reviewSummaryAndTrend(reviewDays, asOf, timeZone, days);
  const { scatter, ...currentSnapshot } = memory;
  return envelope({
    current_snapshot: currentSnapshot,
    due_distribution: dueDistribution,
    long_term_first_recall: focus.summary,
    success_trend: focus.trend,
    scatter_points: scatter.points.map((point) => ({
      ...point,
      word: words.get(point.word_id)?.display_word ?? "",
    })),
  }, asOf, timeZone, {
    ...baseCoverage(asOf, timeZone, days),
    snapshot: "current",
    retrievability_source: "createFsrsScheduler().get_retrievability",
  });
}

export async function getAnalyticsWeakness(
  range: AnalyticsRange = "30d",
  cursor = "",
  limit = 50,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<AnalyticsEnvelope<Record<string, unknown>>> {
  const days = daysForRange(range);
  const offset = pageOffset(cursor);
  const { asOf, timeZone } = await context(db, userId);
  const [matrix, scheduledRows, activeRows] = await Promise.all([
    readErrorMatrix(db, userId, asOf, timeZone, days),
    readMemoryRows(db, userId),
    readActiveErrorRows(db, userId),
  ]);
  const activeIds = new Set(activeRows.map((row) => row.id));
  const candidates = buildFocusCandidates(
    [...scheduledRows, ...activeRows.filter((row) => !scheduledRows.some((scheduled) => scheduled.id === row.id))],
    activeIds,
    asOf,
  );
  const page = candidates.slice(offset, offset + limit);
  const words = await readDisplayWords(db, page.map((item) => item.word_id));
  const activeFlagCounts = {
    meaning: activeRows.filter((row) => row.meaning_error).length,
    collocation: activeRows.filter((row) => row.collocation_error).length,
    grammar: activeRows.filter((row) => row.grammar_error).length,
    pronunciation: activeRows.filter((row) => row.pronunciation_error).length,
    spelling: activeRows.filter((row) => row.spelling_error).length,
    distinct_words: activeRows.length,
  };
  const next = offset + page.length < candidates.length ? String(offset + page.length) : null;
  return envelope({
    active_error_words: activeFlagCounts,
    historical_error_matrix: matrix,
    focus_words: page.map((item) => ({
      user_word_id: item.user_word_id,
      word_id: item.word_id,
      word: words.get(item.word_id)?.display_word ?? "",
      reasons: item.reasons,
      active_error_layers: item.active_error_layers,
      difficulty: Number.isFinite(item.difficulty) ? item.difficulty : null,
      stability_days: Number.isFinite(item.stability_days) ? item.stability_days : null,
      retrievability: item.retrievability,
      lapses: item.lapses,
      next_review_at: item.next_review_at,
    })),
    focus_total: candidates.length,
  }, asOf, timeZone, {
    ...baseCoverage(asOf, timeZone, days),
    error_events_source: "attempts where is_correct=false",
    active_error_source: "user_words active flags",
    matrix_denominator: "all attempts for the same activity_type",
  }, next);
}

export async function getAnalyticsActivity(
  range: AnalyticsRange = "30d",
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<AnalyticsEnvelope<Record<string, unknown>>> {
  const days = daysForRange(range);
  const { asOf, timeZone } = await context(db, userId);
  const result = await db.rpc("get_analytics_activity_v1", {
    p_user_id: userId,
    p_as_of: asOf.toISOString(),
    p_timezone: timeZone,
    p_days: days,
  });
  assertDb(result.error);
  return envelope({
    days: result.data ?? [],
    series: ["formal_review_count", "distinct_review_words", "pretest_count", "first_introductions", "capture_count", "ordinary_attempt_count"],
    unavailable_series: ["first_formal_learning_completion", "focus_seconds"],
  }, asOf, timeZone, {
    ...baseCoverage(asOf, timeZone, days),
    formal_review_source: "fsrs_review_logs where review_source=review",
    ordinary_practice_source: "attempts",
    first_introduction_source: "earliest pretest log per word",
    capture_source: "captured_note_occurrences",
    first_formal_learning_completion: "unavailable because there is no reliable historical completion event",
    focus_seconds: "unavailable",
  });
}

export async function getAnalytics(
  section: AnalyticsSection,
  range: AnalyticsRange = "30d",
  cursor = "",
  limit = 50,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<AnalyticsEnvelope<Record<string, unknown>>> {
  const parsedRange = analyticsRangeSchema.safeParse(range);
  if (!parsedRange.success) throw new AnalyticsServiceError(400, "INVALID_RANGE", "仅支持 7d、30d 或 90d。");
  switch (section) {
    case "overview": return getAnalyticsOverview(parsedRange.data, db, userId);
    case "memory": return getAnalyticsMemory(parsedRange.data, db, userId);
    case "weakness": return getAnalyticsWeakness(parsedRange.data, cursor, limit, db, userId);
    case "activity": return getAnalyticsActivity(parsedRange.data, db, userId);
  }
}
