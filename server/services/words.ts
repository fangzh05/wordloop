import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { UserWordRow, VocabularyItem, WordStatus } from "../types.js";
import { assertDatabaseResult, dateInTimeZone, errorLayers } from "./shared.js";
import { normalizeWord, prepareWordList } from "./wordNormalization.js";
import { cardToDatabase, reviewLogToDatabase, scheduleReview } from "./fsrsScheduler.js";

interface RpcImportResult {
  date: string;
  source: string;
  total: number;
  new: number;
  existing: number;
}

interface WordEntity {
  normalized_word: string;
  display_word: string;
  ipa_us: string | null;
  ipa_uk: string | null;
  senses: Array<{ pos: string; definition_cn: string }>;
}

interface JoinedUserWord extends UserWordRow {
  word: WordEntity | WordEntity[];
}

export interface RpcVocabularyRow {
  word: string;
  display_word: string;
  status: WordStatus;
  source: string | null;
  consecutive_correct: number;
  wrong_count: number;
  mastered: boolean;
  next_review_at: string | null;
  meaning_error: boolean;
  collocation_error: boolean;
  grammar_error: boolean;
  pronunciation_error: boolean;
  spelling_error: boolean;
  fsrs_stability: number;
  fsrs_difficulty: number;
  fsrs_scheduled_days: number;
  fsrs_state: number;
  ipa_us: string | null;
  ipa_uk: string | null;
  senses: Array<{ pos: string; definition_cn: string }>;
}

interface DailyWordJoin {
  import_id: string;
  position: number;
  word_id: string;
  words: WordEntity | WordEntity[];
}

export type DailyWordOrderRow = Pick<DailyWordJoin, "import_id" | "position" | "word_id">;

export function sortDailyWordRows<T extends DailyWordOrderRow>(
  rows: T[],
  importRank: ReadonlyMap<string, number>,
): T[] {
  return [...rows].sort((left, right) => {
    const leftImportRank = importRank.get(left.import_id) ?? Number.MAX_SAFE_INTEGER;
    const rightImportRank = importRank.get(right.import_id) ?? Number.MAX_SAFE_INTEGER;
    return leftImportRank - rightImportRank
      || left.position - right.position
      || left.word_id.localeCompare(right.word_id);
  });
}

function relationOne<T>(value: T | T[]): T {
  if (Array.isArray(value)) {
    const first = value[0];
    if (!first) throw new Error("Database relation was unexpectedly empty.");
    return first;
  }
  return value;
}

export async function getUserTimeZone(db = getDatabase(), userId = getAuthenticatedUserId()): Promise<string> {
  const { data, error } = await db.from("users").select("timezone").eq("id", userId).maybeSingle();
  assertDatabaseResult(error);
  return (data as { timezone?: string } | null)?.timezone ?? "Asia/Shanghai";
}

export async function getDailyNewWordLimit(
  db = getDatabase(), userId = getAuthenticatedUserId(),
): Promise<number> {
  const { error: ensureError } = await db
    .from("users")
    .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
  assertDatabaseResult(ensureError);
  const { data, error } = await db
    .from("users")
    .select("daily_new_word_limit")
    .eq("id", userId)
    .maybeSingle();
  assertDatabaseResult(error);
  const value = (data as { daily_new_word_limit?: number } | null)?.daily_new_word_limit;
  return typeof value === "number" ? value : 50;
}

export async function importWords(input: {
  words: string[];
  date?: string;
  source: string;
}, db = getDatabase(), userId = getAuthenticatedUserId()): Promise<RpcImportResult> {
  const words = prepareWordList(input.words);
  const date = input.date ?? dateInTimeZone(await getUserTimeZone(db, userId));
  const { data, error } = await db.rpc("import_words_v1", {
    p_user_id: userId,
    p_words: words,
    p_date: date,
    p_source: input.source,
  });
  assertDatabaseResult(error);
  return data as RpcImportResult;
}

export async function recordPretestResult(input: {
  word: string;
  result: Extract<WordStatus, "known" | "uncertain" | "unknown">;
  user_answer?: string;
  activity_type?: "pretest_cn_to_en" | "pretest_en_definition";
}, db = getDatabase(), userId = getAuthenticatedUserId()): Promise<{ word: string; result: string }> {
  const normalizedWord = normalizeWord(input.word);
  const { data: joined, error: lookupError } = await db
    .from("user_words")
    .select("*,word:words!inner(normalized_word)")
    .eq("user_id", userId)
    .eq("word.normalized_word", normalizedWord)
    .single();
  assertDatabaseResult(lookupError);
  const rating = input.result === "known" ? "good" : input.result === "uncertain" ? "hard" : "again";
  const scheduled = scheduleReview(joined as unknown as UserWordRow, rating, new Date());
  const { data, error } = await db.rpc("record_pretest_result_v2", {
    p_user_id: userId,
    p_normalized_word: normalizedWord,
    p_result: input.result,
    p_user_answer: input.user_answer ?? "",
    p_activity_type: input.activity_type ?? "pretest_cn_to_en",
    p_rating: scheduled.log.rating,
    p_card: cardToDatabase(scheduled.card),
    p_log: reviewLogToDatabase(scheduled.log),
  });
  assertDatabaseResult(error);
  return data as { word: string; result: string };
}

export async function getTodayWords(
  date: string,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<VocabularyItem[]> {
  const { data, error } = await db.rpc("get_today_words_v2", {
    p_user_id: userId,
    p_date: date,
  });
  assertDatabaseResult(error);
  return ((data ?? []) as RpcVocabularyRow[]).map(vocabularyItemFromRpc);
}

/** Read only the persisted words needed to resume a session-aware lesson queue. */
export async function getVocabularyItemsByWords(
  words: string[],
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<VocabularyItem[]> {
  const normalizedWords = [...new Set(words.map(normalizeWord).filter(Boolean))];
  if (normalizedWords.length === 0) return [];
  const { data, error } = await db
    .from("user_words")
    .select("*,word:words!inner(normalized_word,display_word,ipa_us,ipa_uk,senses)")
    .eq("user_id", userId)
    .in("word.normalized_word", normalizedWords);
  assertDatabaseResult(error);
  return ((data ?? []) as unknown as JoinedUserWord[]).map((row) => toVocabularyItem(row, relationOne(row.word)));
}

export async function getAllUserWords(
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<VocabularyItem[]> {
  const rows: JoinedUserWord[] = [];
  const pageSize = 1000;
  for (let start = 0; start < 50000; start += pageSize) {
    const { data, error } = await db
      .from("user_words")
      .select("*,word:words!inner(normalized_word,display_word,ipa_us,ipa_uk,senses)")
      .eq("user_id", userId)
      .order("first_seen_at", { ascending: true })
      .order("id", { ascending: true })
      .range(start, start + pageSize - 1);
    assertDatabaseResult(error);
    const page = (data ?? []) as unknown as JoinedUserWord[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map((row) => toVocabularyItem(row, relationOne(row.word)));
}

export function toVocabularyItem(
  state: UserWordRow,
  word: WordEntity,
): VocabularyItem {
  return {
    word: word.normalized_word,
    display_word: word.display_word,
    status: state.status,
    source: state.source,
    consecutive_correct: state.consecutive_correct,
    wrong_count: state.wrong_count,
    mastered: state.mastered,
    next_review_at: state.next_review_at,
    error_layers: errorLayers(state),
    fsrs_stability: state.fsrs_stability ?? 0,
    fsrs_difficulty: state.fsrs_difficulty ?? 0,
    fsrs_scheduled_days: state.fsrs_scheduled_days ?? 0,
    fsrs_state: state.fsrs_state ?? 0,
    ipa_us: word.ipa_us,
    ipa_uk: word.ipa_uk,
    senses: Array.isArray(word.senses) ? word.senses : [],
  };
}

export function vocabularyItemFromRpc(row: RpcVocabularyRow): VocabularyItem {
  return {
    word: row.word,
    display_word: row.display_word,
    status: row.status,
    source: row.source,
    consecutive_correct: row.consecutive_correct,
    wrong_count: row.wrong_count,
    mastered: row.mastered,
    next_review_at: row.next_review_at,
    error_layers: errorLayers(row),
    fsrs_stability: row.fsrs_stability ?? 0,
    fsrs_difficulty: row.fsrs_difficulty ?? 0,
    fsrs_scheduled_days: row.fsrs_scheduled_days ?? 0,
    fsrs_state: row.fsrs_state ?? 0,
    ipa_us: row.ipa_us,
    ipa_uk: row.ipa_uk,
    senses: Array.isArray(row.senses) ? row.senses : [],
  };
}

export async function prepareDailyNewWords(
  db = getDatabase(), userId = getAuthenticatedUserId(), date?: string,
): Promise<{ date: string; prepared: number; added: number; limit: number }> {
  const targetDate = date ?? dateInTimeZone(await getUserTimeZone(db, userId));
  const { data, error } = await db.rpc("prepare_daily_new_words_v1", { p_user_id: userId, p_date: targetDate });
  assertDatabaseResult(error);
  return data as { date: string; prepared: number; added: number; limit: number };
}

export async function setDailyNewWordLimit(
  limit: number,
  db = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<{ daily_new_word_limit: number; date: string; prepared: number; added: number }> {
  const { data, error } = await db.rpc("set_daily_new_word_limit_v1", {
    p_user_id: userId, p_limit: limit,
  });
  assertDatabaseResult(error);
  const date = dateInTimeZone(await getUserTimeZone(db, userId));
  const prepared = await prepareDailyNewWords(db, userId, date);
  return {
    daily_new_word_limit: (data as { daily_new_word_limit: number }).daily_new_word_limit,
    date: prepared.date,
    prepared: prepared.prepared,
    added: prepared.added,
  };
}

export type DbClient = SupabaseClient;
