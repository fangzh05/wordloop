import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ProgressResult } from "../types.js";
import { dateInTimeZone } from "./shared.js";
import { getAllUserWords, getTodayWords, getUserTimeZone } from "./words.js";

export async function getProgress(): Promise<ProgressResult> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = dateInTimeZone(await getUserTimeZone(db, userId));
  const [today, all] = await Promise.all([
    getTodayWords(date, db, userId),
    getAllUserWords(db, userId),
  ]);
  return calculateProgress(today, all);
}

export function calculateProgress(today: Awaited<ReturnType<typeof getTodayWords>>, all: Awaited<ReturnType<typeof getAllUserWords>>): ProgressResult {
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
  };
}
