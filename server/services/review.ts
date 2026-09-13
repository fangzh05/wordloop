import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { ActiveErrorLayer, UserWordRow, VocabularyItem } from "../types.js";
import { assertDatabaseResult, dateInTimeZone, errorLayers } from "./shared.js";
import { getAllUserWords, getTodayWords, getUserTimeZone } from "./words.js";

function byReviewPriority(a: VocabularyItem, b: VocabularyItem): number {
  const aError = a.error_layers.length > 0 ? 0 : 1;
  const bError = b.error_layers.length > 0 ? 0 : 1;
  if (aError !== bError) return aError - bError;
  const aTime = a.next_review_at ? Date.parse(a.next_review_at) : Number.MAX_SAFE_INTEGER;
  const bTime = b.next_review_at ? Date.parse(b.next_review_at) : Number.MAX_SAFE_INTEGER;
  return aTime - bTime;
}

export async function getReviewSelection(limit = 5): Promise<{
  rollingReview: VocabularyItem[];
  oldRandomReview: VocabularyItem[];
}> {
  const all = await getAllUserWords(getDatabase(), getAuthenticatedUserId());
  const now = Date.now();
  const eligible = all.filter((word) => !word.mastered && word.status !== "new");
  const priority = eligible
    .filter((word) => word.error_layers.length > 0 || (word.next_review_at !== null && Date.parse(word.next_review_at) <= now))
    .sort(byReviewPriority)
    .slice(0, limit);
  const selected = new Set(priority.map((word) => word.word));
  const remaining = eligible.filter((word) => !selected.has(word.word));
  const oldRandomReview = remaining
    .map((word) => ({ word, random: Math.random() }))
    .sort((a, b) => a.random - b.random)
    .slice(0, Math.max(0, limit - priority.length))
    .map(({ word }) => word);
  return { rollingReview: priority, oldRandomReview };
}

export async function getLearningContext(): Promise<{
  date: string;
  today_words: VocabularyItem[];
  rolling_review: VocabularyItem[];
  old_random_review: VocabularyItem[];
  recent_activity: Array<{ word: string; activity_type: string; is_correct: boolean; result: string; created_at: string }>;
  stats: { today_total: number; today_completed: number; total_learned: number; error_book: number };
  session_rules: { initial_review_count: number; round_size_min: number; round_size_max: number; error_clear_after_consecutive_correct: number };
}> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const date = dateInTimeZone(await getUserTimeZone(db, userId));
  const [todayWords, reviews, all, recentActivity] = await Promise.all([
    getTodayWords(date, db, userId),
    getReviewSelection(5),
    getAllUserWords(db, userId),
    getRecentActivity(db, userId),
  ]);
  return {
    date,
    today_words: todayWords,
    rolling_review: reviews.rollingReview,
    old_random_review: reviews.oldRandomReview,
    recent_activity: recentActivity,
    stats: {
      today_total: todayWords.length,
      today_completed: todayWords.filter((word) => word.status !== "new").length,
      total_learned: all.filter((word) => word.status !== "new").length,
      error_book: all.filter((word) => word.error_layers.length > 0).length,
    },
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
  const priority: Record<string, number> = { unknown: 0, uncertain: 1, new: 2 };
  const words = (await getTodayWords(date, db, userId))
    .filter((word) => !word.mastered && ["unknown", "uncertain", "new"].includes(word.status))
    .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9))
    .slice(0, limit);
  return { words };
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
