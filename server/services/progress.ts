import { getLearningBudget } from "./learningBudget.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ProgressResult, StudySessionRow, VocabularyItem } from "../types.js";
import { addCalendarDays, assertDatabaseResult, dateInTimeZone, localDateRange } from "./shared.js";
import { perf } from "./perf.js";
import { getActiveStudySession, normalizeStudyStateForRead, studyStateSchema } from "./studySessions.js";
import { getUserTimeZone } from "./words.js";

type ReviewSessionProgressRow = Pick<StudySessionRow, "review_words_count"> & { state: unknown };

function safeStudyState(value: unknown) {
  const parsed = studyStateSchema.safeParse(value);
  return parsed.success ? normalizeStudyStateForRead(parsed.data) : null;
}

function isFormalReviewItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reviewKind = (value as { review_kind?: unknown }).review_kind;
  return reviewKind === "fsrs_due" || reviewKind === "both";
}

function reviewSnapshotTotal(value: unknown): number {
  const state = safeStudyState(value);
  return state?.widget === "review" && Array.isArray(state.payload.items)
    ? state.payload.items.filter(isFormalReviewItem).length
    : 0;
}

function completedReviewSnapshot(value: unknown): number {
  const state = safeStudyState(value);
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
  const activeState = safeStudyState(active?.state);
  if (activeState?.widget === "review") {
    const reviewTotal = reviewSnapshotTotal(activeState);
    const currentSnapshotCompleted = completedReviewSnapshot(activeState);
    const storedReviewCount = typeof active?.review_words_count === "number"
      && Number.isFinite(active.review_words_count)
      ? Math.max(0, active.review_words_count)
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
    const state = safeStudyState(session.state);
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

async function getReviewTodayProgress(db: ReturnType<typeof getDatabase>, userId: string, now: Date): Promise<ProgressResult["review_today"]> {
  const active = await getActiveStudySession(db, userId);
  if (active?.state?.widget === "review") return calculateReviewTodayProgress(active, []);

  const timeZone = await getUserTimeZone(db, userId);
  const today = dateInTimeZone(timeZone, now);
  const { start, end } = localDateRange(today, timeZone);
  const sessionResult = await db.from("study_sessions")
    .select("review_words_count,state")
    .eq("user_id", userId)
    .gte("started_at", start)
    .lt("started_at", end);
  assertDatabaseResult(sessionResult.error);
  return calculateReviewTodayProgress(
    active,
    (sessionResult.data ?? []) as ReviewSessionProgressRow[],
  );
}

export async function getProgress(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
  now = new Date(),
): Promise<ProgressResult> {
  return perf("get_progress", async () => {
    const [{ data, error }, review_today] = await Promise.all([
      db.rpc("get_progress_snapshot_v1", { p_user_id: userId, p_now: now.toISOString() }),
      getReviewTodayProgress(db, userId, now),
    ]);
    assertDatabaseResult(error);
    return { ...(data as Omit<ProgressResult, "review_today">), review_today, budget: await getLearningBudget(db, userId) };
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
