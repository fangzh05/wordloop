import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ProgressResult } from "../types.js";
import { dateInTimeZone } from "./shared.js";
import { getAllUserWords, getTodayWords, getUserTimeZone } from "./words.js";

export async function getProgress(): Promise<ProgressResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const timeZone = await getUserTimeZone(db, userId);
  const date = dateInTimeZone(timeZone);
  const [today, all] = await Promise.all([
    getTodayWords(date, db, userId),
    getAllUserWords(db, userId),
  ]);
  return calculateProgress(today, all, timeZone);
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function fsrsForecast(all: Awaited<ReturnType<typeof getAllUserWords>>, timeZone = "Asia/Shanghai", now = new Date()) {
  const today = dateInTimeZone(timeZone, now);
  const tomorrow = addCalendarDays(today, 1);
  const day7 = addCalendarDays(today, 7);
  const due = all.map((word) => word.next_review_at ? new Date(word.next_review_at) : null).filter((date): date is Date => date !== null);
  return {
    due_now: due.filter((date) => date <= now).length,
    due_today: due.filter((date) => dateInTimeZone(timeZone, date) <= today).length,
    tomorrow: due.filter((date) => dateInTimeZone(timeZone, date) === tomorrow).length,
    due_next_7_days: due.filter((date) => dateInTimeZone(timeZone, date) <= day7).length,
    average_stability: all.length === 0 ? 0 : Number((all.reduce((sum, word) => sum + (word.fsrs_stability ?? 0), 0) / all.length).toFixed(1)),
  };
}

export function calculateProgress(today: Awaited<ReturnType<typeof getTodayWords>>, all: Awaited<ReturnType<typeof getAllUserWords>>, timeZone = "Asia/Shanghai"): ProgressResult {
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
    all_time: {
      total_words: all.length,
      mastered,
      learning: all.length - mastered - errorBook,
      error_book: errorBook,
    },
    fsrs: fsrsForecast(all, timeZone),
  };
}
