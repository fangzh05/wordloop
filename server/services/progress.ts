import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ProgressResult, StudySessionRow, StudyState, VocabularyItem } from "../types.js";
import { assertDatabaseResult, dateInTimeZone } from "./shared.js";
import { perf } from "./perf.js";
import { getActiveStudySession } from "./studySessions.js";
import { getUserTimeZone } from "./words.js";

type ReviewSessionProgressRow = Pick<StudySessionRow, "review_words_count" | "state">;

function reviewSnapshotTotal(state: StudyState | null | undefined): number {
  return state?.widget === "review" && Array.isArray(state.payload.items) ? state.payload.items.length : 0;
}

/** Review work has its own denominator and never changes the daily new-word queue. */
export function calculateReviewTodayProgress(
  active: Pick<StudySessionRow, "state"> | null,
  sessions: readonly ReviewSessionProgressRow[],
  completedAttempts: number,
): ProgressResult["review_today"] {
  const activeState = active?.state;
  if (activeState?.widget === "review") {
    const total = reviewSnapshotTotal(activeState);
    const completed = activeState.phase === "review_complete"
      ? total
      : Math.min(total, Math.max(0, activeState.current_index));
    return { completed, total, remaining: Math.max(0, total - completed) };
  }

  const savedTotal = sessions.reduce((sum, session) => {
    const count = typeof session.review_words_count === "number" && Number.isFinite(session.review_words_count)
      ? Math.max(0, session.review_words_count)
      : 0;
    return sum + Math.max(count, reviewSnapshotTotal(session.state));
  }, 0);
  const attempts = Number.isFinite(completedAttempts) ? Math.max(0, completedAttempts) : 0;
  // Older completed sessions may not have the snapshot count populated. In
  // that case persisted Review attempts give a safe lower-bound denominator.
  const total = savedTotal > 0 ? savedTotal : attempts;
  const completed = Math.min(total, attempts);
  return { completed, total, remaining: Math.max(0, total - completed) };
}

function localDateStart(date: string, timeZone: string): string {
  const targetWallTime = Date.parse(`${date}T00:00:00.000Z`);
  let candidate = targetWallTime;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Map(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const localWallTime = Date.UTC(
      Number(parts.get("year")),
      Number(parts.get("month")) - 1,
      Number(parts.get("day")),
      Number(parts.get("hour")),
      Number(parts.get("minute")),
      Number(parts.get("second")),
    );
    const correction = targetWallTime - localWallTime;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function getReviewTodayProgress(db: ReturnType<typeof getDatabase>, userId: string, now: Date): Promise<ProgressResult["review_today"]> {
  const active = await getActiveStudySession(db, userId);
  if (active?.state?.widget === "review") return calculateReviewTodayProgress(active, [], 0);

  const timeZone = await getUserTimeZone(db, userId);
  const today = dateInTimeZone(timeZone, now);
  const start = localDateStart(today, timeZone);
  const end = localDateStart(addCalendarDays(today, 1), timeZone);
  const [sessionResult, attemptsResult] = await Promise.all([
    db.from("study_sessions")
      .select("review_words_count,state")
      .eq("user_id", userId)
      .gte("started_at", start)
      .lt("started_at", end),
    db.from("attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("activity_type", "review")
      .gte("created_at", start)
      .lt("created_at", end),
  ]);
  assertDatabaseResult(sessionResult.error);
  assertDatabaseResult(attemptsResult.error);
  return calculateReviewTodayProgress(
    active,
    (sessionResult.data ?? []) as ReviewSessionProgressRow[],
    attemptsResult.count ?? 0,
  );
}

export async function getProgress(): Promise<ProgressResult> {
  return perf("get_progress", async () => {
    const db = getDatabase();
    const userId = getAuthenticatedUserId();
    const now = new Date();
    const [{ data, error }, review_today] = await Promise.all([
      db.rpc("get_progress_snapshot_v1", { p_user_id: userId, p_now: now.toISOString() }),
      getReviewTodayProgress(db, userId, now),
    ]);
    assertDatabaseResult(error);
    return { ...(data as Omit<ProgressResult, "review_today">), review_today };
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
    average_stability: all.length === 0
      ? 0
      : Number((all.reduce((sum, word) => sum + (word.fsrs_stability ?? 0), 0) / all.length).toFixed(1)),
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
