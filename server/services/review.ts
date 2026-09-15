import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ActiveErrorLayer, ReviewKind, ReviewVocabularyItem, UserWordRow, VocabularyItem } from "../types.js";
import { assertDatabaseResult, dateInTimeZone, errorLayers } from "./shared.js";
import { getAllUserWords, getDailyNewWordLimit, getTodayWords, getUserTimeZone } from "./words.js";
import { normalizeWord } from "./wordNormalization.js";
import { fsrsForecast } from "./progress.js";
import { getActiveStudySession } from "./studySessions.js";

function reviewDueAt(item: VocabularyItem, now: Date): boolean {
  if (!item.next_review_at) return false;
  const timestamp = Date.parse(item.next_review_at);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function reviewKind(item: VocabularyItem, now: Date): ReviewKind {
  const hasActiveError = item.error_layers.length > 0;
  const isDue = reviewDueAt(item, now);
  if (hasActiveError && isDue) return "both";
  if (hasActiveError) return "error_repair";
  return "fsrs_due";
}

export function decorateReviewWord(item: VocabularyItem, now = new Date()): ReviewVocabularyItem {
  return {
    ...item,
    is_due: reviewDueAt(item, now),
    review_kind: reviewKind(item, now),
  };
}

function byReviewPriority(a: ReviewVocabularyItem, b: ReviewVocabularyItem): number {
  const aError = a.error_layers.length > 0 ? 0 : 1;
  const bError = b.error_layers.length > 0 ? 0 : 1;
  if (aError !== bError) return aError - bError;
  const aTime = a.next_review_at ? Date.parse(a.next_review_at) : Number.MAX_SAFE_INTEGER;
  const bTime = b.next_review_at ? Date.parse(b.next_review_at) : Number.MAX_SAFE_INTEGER;
  const aSortableTime = Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER;
  const bSortableTime = Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER;
  return aSortableTime - bSortableTime || a.word.localeCompare(b.word);
}

export function selectReviewWords(all: VocabularyItem[], limit: number, now = new Date()): ReviewVocabularyItem[] {
  return all
    .filter((word) => word.error_layers.length > 0 || reviewDueAt(word, now))
    .map((word) => decorateReviewWord(word, now))
    .sort(byReviewPriority)
    .slice(0, limit);
}

export async function getReviewSelection(limit = 5): Promise<{
  rollingReview: ReviewVocabularyItem[];
  oldRandomReview: VocabularyItem[];
}> {
  const all = await getAllUserWords(getDatabase(), getAuthenticatedUserId());
  const priority = selectReviewWords(all, limit);
  return { rollingReview: priority, oldRandomReview: [] };
}

export async function getLearningContext(): Promise<{
  date: string;
  today_words: VocabularyItem[];
  rolling_review: VocabularyItem[];
  old_random_review: VocabularyItem[];
  recent_activity: Array<{ word: string; activity_type: string; is_correct: boolean; result: string; created_at: string }>;
  stats: { today_total: number; today_completed: number; total_learned: number; error_book: number };
  fsrs: { due_now: number; due_today: number; due_next_7_days: number };
  settings: { daily_new_word_limit: number };
  session_rules: { initial_review_count: number; round_size_min: number; round_size_max: number; error_clear_after_consecutive_correct: number };
}> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const timeZone = await getUserTimeZone(db, userId);
  const date = dateInTimeZone(timeZone);
  const [todayWords, all, recentActivity, dailyNewWordLimit] = await Promise.all([
    getTodayWords(date, db, userId),
    getAllUserWords(db, userId),
    getRecentActivity(db, userId),
    getDailyNewWordLimit(db, userId),
  ]);
  const reviews = { rollingReview: selectReviewWords(all, 5), oldRandomReview: [] as VocabularyItem[] };
  const forecast = fsrsForecast(all, timeZone);
  return {
    date,
    today_words: todayWords,
    rolling_review: reviews.rollingReview,
    old_random_review: reviews.oldRandomReview,
    recent_activity: recentActivity,
    fsrs: {
      due_now: forecast.due_now,
      due_today: forecast.due_today,
      due_next_7_days: forecast.due_next_7_days,
    },
    stats: {
      today_total: todayWords.length,
      today_completed: todayWords.filter((word) => word.status !== "new").length,
      total_learned: all.filter((word) => word.status !== "new").length,
      error_book: all.filter((word) => word.error_layers.length > 0).length,
    },
    settings: { daily_new_word_limit: dailyNewWordLimit },
    session_rules: {
      initial_review_count: 5,
      round_size_min: 5,
      round_size_max: 7,
      error_clear_after_consecutive_correct: 2,
    },
  };
}

async function getRecentActivity(db = getDatabase(), userId = getAuthenticatedUserId()): Promise<Array<{
  word: string;
  activity_type: string;
  is_correct: boolean;
  result: string;
  created_at: string;
}>> {
  type AttemptJoin = {
    activity_type: string;
    is_correct: boolean;
    user_answer: string;
    created_at: string;
    word: { normalized_word: string } | Array<{ normalized_word: string }>;
  };
  const { data, error } = await db
    .from("attempts")
    .select("activity_type,is_correct,user_answer,created_at,word:words!inner(normalized_word)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  assertDatabaseResult(error);
  return ((data ?? []) as unknown as AttemptJoin[]).map((entry) => ({
    word: (Array.isArray(entry.word) ? entry.word[0]?.normalized_word : entry.word.normalized_word) ?? "",
    activity_type: entry.activity_type,
    is_correct: entry.is_correct,
    result: entry.is_correct ? "correct" : "incorrect",
    created_at: entry.created_at,
  }));
}

export async function getNextRound(limit: number): Promise<{ words: VocabularyItem[] }> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = dateInTimeZone(await getUserTimeZone(db, userId));
  const words = (await getTodayWords(date, db, userId))
    .filter((word) => !word.mastered && word.status === "new")
    .slice(0, limit);
  return { words };
}

const learningStatuses = new Set(["unknown", "uncertain", "new"]);

export function findFirstLearningWord(todayWords: VocabularyItem[]): VocabularyItem | null {
  return todayWords.find((word) => !word.mastered && learningStatuses.has(word.status)) ?? null;
}

export function findNextLearningWord(todayWords: VocabularyItem[], currentWord: string): {
  next_word: VocabularyItem | null;
  round_complete: boolean;
} {
  const currentIndex = todayWords.findIndex((word) => normalizeWord(word.word) === normalizeWord(currentWord));
  if (currentIndex < 0) return { next_word: null, round_complete: true };
  const nextWord = todayWords
    .slice(currentIndex + 1)
    .find((word) => !word.mastered && learningStatuses.has(word.status)) ?? null;
  return { next_word: nextWord, round_complete: nextWord === null };
}

export async function getNextLearningWord(currentWord: string): Promise<ReturnType<typeof findNextLearningWord>> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = await resolveLearningQueueDate(currentWord, db, userId);
  const todayWords = await getTodayWords(date, db, userId);
  return findNextLearningWord(todayWords, currentWord);
}

export async function resolveLearningQueueDate(
  currentWord?: string,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<string> {
  if (currentWord) {
    const active = await getActiveStudySession(db, userId);
    if (active?.state?.widget === "lesson"
      && active.state.current_word
      && normalizeWord(active.state.current_word) === normalizeWord(currentWord)) {
      return active.state.date;
    }
  }
  return dateInTimeZone(await getUserTimeZone(db, userId));
}

export async function getFirstLearningWord(
  date?: string,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<VocabularyItem | null> {
  const targetDate = date ?? dateInTimeZone(await getUserTimeZone(db, userId));
  return findFirstLearningWord(await getTodayWords(targetDate, db, userId));
}

export async function getErrorBook(): Promise<{
  words: Array<{
    word: string;
    errors: VocabularyItem["error_layers"];
    consecutive_correct: number;
    wrong_count: number;
    layer_progress: Partial<Record<ActiveErrorLayer, number>>;
  }>;
}> {
  type ErrorRow = UserWordRow & {
    word: { normalized_word: string } | Array<{ normalized_word: string }>;
    user_word_error_progress: Array<{ error_layer: ActiveErrorLayer; consecutive_correct: number }>;
  };
  const { data, error } = await getDatabase()
    .from("user_words")
    .select("*,word:words!inner(normalized_word),user_word_error_progress(error_layer,consecutive_correct)")
    .eq("user_id", getAuthenticatedUserId())
    .or("meaning_error.eq.true,collocation_error.eq.true,grammar_error.eq.true,pronunciation_error.eq.true,spelling_error.eq.true")
    .order("wrong_count", { ascending: false });
  assertDatabaseResult(error);
  const words = ((data ?? []) as unknown as ErrorRow[]).map((row) => {
    const errors = errorLayers(row);
    const layerProgress = Object.fromEntries(row.user_word_error_progress
      .filter((progress) => errors.includes(progress.error_layer))
      .map((progress) => [progress.error_layer, progress.consecutive_correct])) as Partial<Record<ActiveErrorLayer, number>>;
    const streaks = errors.map((layer) => layerProgress[layer] ?? 0);
    const wordRelation = Array.isArray(row.word) ? row.word[0] : row.word;
    return {
      word: wordRelation?.normalized_word ?? "",
      errors,
      consecutive_correct: streaks.length > 0 ? Math.min(...streaks) : 0,
      wrong_count: row.wrong_count,
      layer_progress: layerProgress,
    };
  });
  return { words };
}
