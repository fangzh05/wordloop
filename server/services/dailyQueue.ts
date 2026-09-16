import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { dateInTimeZone } from "./shared.js";
import { getUserTimeZone, prepareDailyNewWords, type DbClient } from "./words.js";

export interface EnsuredDailyQueue {
  date: string;
  prepared: number;
  added: number;
}

export async function ensureDailyQueueForDate(
  date: string,
  db: DbClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<EnsuredDailyQueue> {
  const result = await prepareDailyNewWords(db, userId, date);
  return {
    date: result.date,
    prepared: result.prepared,
    added: result.added,
  };
}

export async function ensureTodayQueue(
  db: DbClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<EnsuredDailyQueue> {
  const timeZone = await getUserTimeZone(db, userId);
  const date = dateInTimeZone(timeZone);
  return ensureDailyQueueForDate(date, db, userId);
}
