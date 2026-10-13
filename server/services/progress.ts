import { getLearningBudget } from "./learningBudget.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { STUDY_PHASES, type ProgressResult, type StudySessionRow, type StudyState, type StudyFlow, type VocabularyItem } from "../types.js";
import { addCalendarDays, assertDatabaseResult, dateInTimeZone, localDateRange } from "./shared.js";
import { perf } from "./perf.js";
import { getActiveStudySession } from "./studySessions.js";
import { getUserTimeZone } from "./words.js";
import { z } from "zod";
import { REVIEW_SESSION_MAX } from "../../shared/toolContracts.js";

type StudyProgressState = Pick<StudyState, "widget" | "phase" | "current_index">
  & { flow: Pick<StudyFlow, "relearn_words">; payload: { items?: unknown[] } };
type ReviewSessionProgressRow = Pick<StudySessionRow, "review_words_count"> & { state: unknown };

// Project only the review cursor, review kinds, and relearn words. Parsing a
// persisted session with the full StudyState schema copies frozen Lesson plans
// and feedback that are irrelevant to these read-only counts.
const studyProgressStateSchema = z.object({
  widget: z.enum(["pretest", "lesson", "review"]),
  phase: z.enum(STUDY_PHASES),
  current_index: z.number().int().min(0),
  relearn_words: z.array(z.string().trim().min(1).max(100)).max(REVIEW_SESSION_MAX).default([]),
  review_items: z.array(z.unknown()).max(REVIEW_SESSION_MAX).optional(),
});

function safeStudyState(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const flow = typeof raw.flow === "object" && raw.flow !== null && !Array.isArray(raw.flow)
    ? raw.flow as Record<string, unknown> : {};
  const payload = typeof raw.payload === "object" && raw.payload !== null && !Array.isArray(raw.payload)
    ? raw.payload as Record<string, unknown> : {};
  const projected = studyProgressStateSchema.safeParse({
    widget: raw.widget,
    phase: raw.phase,
    current_index: raw.current_index,
    relearn_words: raw.relearn_words ?? flow.relearn_words,
    review_items: raw.review_items ?? payload.items,
  });
  if (!projected.success) return null;
  return {
    widget: projected.data.widget,
    phase: projected.data.phase,
    current_index: projected.data.current_index,
    flow: { relearn_words: projected.data.relearn_words },
    payload: projected.data.review_items === undefined ? {} : { items: projected.data.review_items },
  } satisfies StudyProgressState;
}

type NormalizedStudyState = StudyProgressState;

export function parseStudyStateForReviewProgress(value: unknown): NormalizedStudyState | null {
  return safeStudyState(value);
}

function isFormalReviewItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reviewKind = (value as { review_kind?: unknown }).review_kind;
  return reviewKind === "fsrs_due" || reviewKind === "both";
}

function reviewSnapshotTotal(state: NormalizedStudyState | null): number {
  return state?.widget === "review" && Array.isArray(state.payload.items)
    ? state.payload.items.filter(isFormalReviewItem).length
    : 0;
}

function completedReviewSnapshot(state: NormalizedStudyState | null): number {
  if (state?.widget !== "review" || !Array.isArray(state.payload.items)) return 0;
  const completedPrefix = state.phase === "review_complete"
    ? state.payload.items.length
    : Math.min(state.payload.items.length, Math.max(0, state.current_index));
  return state.payload.items.slice(0, completedPrefix).filter(isFormalReviewItem).length;
}

/** Count only formal FSRS Review cards; Lesson re-learning has its own flow. */
export function calculateReviewTodayProgress(
  active: Pick<StudySessionRow, "state"> & Partial<Pick<StudySessionRow, "review_words_count">> | null,
  sessions: readonly ReviewSessionProgressRow[],
): ProgressResult["review_today"] {
  return calculateReviewTodayProgressFromParsed(
    parseStudyStateForReviewProgress(active?.state),
    active?.review_words_count,
    sessions.map(session => ({
      state: parseStudyStateForReviewProgress(session.state),
      review_words_count: session.review_words_count,
    })),
  );
}

export function calculateReviewTodayProgressFromParsed(
  activeState: NormalizedStudyState | null,
  activeReviewWordsCount: number | undefined,
  sessions: readonly { state: NormalizedStudyState | null; review_words_count?: number }[],
): ProgressResult["review_today"] {
  if (activeState?.widget === "review") {
    const reviewTotal = reviewSnapshotTotal(activeState);
    const currentSnapshotCompleted = completedReviewSnapshot(activeState);
    const storedReviewCount = typeof activeReviewWordsCount === "number"
      && Number.isFinite(activeReviewWordsCount)
      ? Math.max(0, activeReviewWordsCount)
      : 0;
    const reviewCompleted = Math.max(
      storedReviewCount,
      currentSnapshotCompleted,
    );
    const previousSnapshotsCompleted = Math.max(0, reviewCompleted - currentSnapshotCompleted);
    const total = previousSnapshotsCompleted + reviewTotal;
    const completed = reviewCompleted;
    return { completed, total, remaining: Math.max(0, total - completed) };
  }

  const saved = sessions.reduce((totals, session) => {
    const count = typeof session.review_words_count === "number" && Number.isFinite(session.review_words_count)
      ? Math.max(0, session.review_words_count)
      : 0;
    const state = session.state;
    if (state?.widget === "review") {
      const currentCompleted = completedReviewSnapshot(state);
      const accumulatedCompleted = Math.max(count, currentCompleted);
      const completedBeforeSnapshot = Math.max(0, accumulatedCompleted - currentCompleted);
      return {
        total: totals.total + completedBeforeSnapshot + reviewSnapshotTotal(state),
        completed: totals.completed + accumulatedCompleted,
      };
    }
    return { total: totals.total + count, completed: totals.completed + count };
  }, { total: 0, completed: 0 });
  return {
    completed: saved.completed,
    total: saved.total,
    remaining: Math.max(0, saved.total - saved.completed),
  };
}

async function getReviewTodayProgress(
  db: ReturnType<typeof getDatabase>,
  userId: string,
  now: Date,
  knownActive?: StudySessionRow | null,
): Promise<ProgressResult["review_today"]> {
  const active = knownActive === undefined ? await getActiveStudySession(db, userId) : knownActive;
  if (active?.state?.widget === "review") return calculateReviewTodayProgress(active, []);

  const timeZone = await getUserTimeZone(db, userId);
  const today = dateInTimeZone(timeZone, now);
  const { start, end } = localDateRange(today, timeZone);
  const sessionResult = await db.from("study_sessions")
    .select("review_words_count,widget:state->widget,phase:state->phase,current_index:state->current_index,relearn_words:state->flow->relearn_words,review_items:state->payload->items")
    .eq("user_id", userId)
    .gte("started_at", start)
    .lt("started_at", end);
  assertDatabaseResult(sessionResult.error);
  const sessions = ((sessionResult.data ?? []) as Array<{
    review_words_count?: number; widget?: unknown; phase?: unknown; current_index?: unknown;
    relearn_words?: unknown; review_items?: unknown;
  }>).map(row => ({
    state: parseStudyStateForReviewProgress(row),
    review_words_count: row.review_words_count,
  }));
  return calculateReviewTodayProgressFromParsed(null, undefined, sessions);
}

export async function getProgress(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  now = new Date(),
  includeBudget = true,
  knownActive?: StudySessionRow | null,
): Promise<ProgressResult> {
  return perf("get_progress", async () => {
    const [{ data, error }, review_today] = await Promise.all([
      db.rpc("get_progress_snapshot_v1", { p_user_id: userId, p_now: now.toISOString() }),
      getReviewTodayProgress(db, userId, now, knownActive),
    ]);
    assertDatabaseResult(error);
    const progress = { ...(data as Omit<ProgressResult, "review_today">), review_today };
    return includeBudget ? { ...progress, budget: await getLearningBudget(db, userId) } : progress;
  });
}

export function fsrsForecast(all: VocabularyItem[], timeZone = "Asia/Shanghai", now = new Date()) {
  const today = dateInTimeZone(timeZone, now);
  const tomorrow = addCalendarDays(today, 1);
  const day7 = addCalendarDays(today, 7);
  const due = all
    .map((word) => word.next_review_at ? new Date(word.next_review_at) : null)
    .filter((date): date is Date => date !== null);
  return {
    due_now: due.filter((date) => date <= now).length,
    due_today: due.filter((date) => dateInTimeZone(timeZone, date) <= today).length,
    tomorrow: due.filter((date) => dateInTimeZone(timeZone, date) === tomorrow).length,
    due_next_7_days: due.filter((date) => dateInTimeZone(timeZone, date) <= day7).length,
    average_stability: (() => {
      const scheduled = all
        .filter((word) => word.fsrs_reps !== undefined && word.fsrs_reps > 0
          && Number.isFinite(word.fsrs_stability) && word.fsrs_stability > 0);
      return scheduled.length === 0
        ? 0
        : Number((scheduled.reduce((sum, word) => sum + word.fsrs_stability, 0) / scheduled.length).toFixed(2));
    })(),
  };
}

/** Kept as a pure compatibility helper; production reads use the snapshot RPC. */
export function calculateProgress(
  today: VocabularyItem[],
  all: VocabularyItem[],
  timeZone = "Asia/Shanghai",
  dailyNewWordLimit = 50,
): ProgressResult {
  const mastered = all.filter((word) => word.mastered).length;
  const errorBook = all.filter((word) => word.error_layers.length > 0).length;
  return {
    today: {
      total: today.length,
      known: today.filter((word) => word.status === "known").length,
      uncertain: today.filter((word) => word.status === "uncertain").length,
      unknown: today.filter((word) => word.status === "unknown").length,
      completed: today.filter((word) => word.status !== "new").length,
    },
    review_today: { completed: 0, total: 0, remaining: 0 },
    all_time: {
      total_words: all.length,
      mastered,
      learning: all.length - mastered - errorBook,
      error_book: errorBook,
    },
    fsrs: fsrsForecast(all, timeZone),
    settings: { daily_new_word_limit: dailyNewWordLimit },
  };
}
