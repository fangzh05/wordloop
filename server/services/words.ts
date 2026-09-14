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

interface DailyWordJoin {
  position: number;
  word_id: string;
  words: WordEntity | WordEntity[];
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
  const { data: imports, error: importError } = await db
    .from("daily_imports")
    .select("id")
    .eq("user_id", userId)
    .eq("import_date", date);
  assertDatabaseResult(importError);
  const importIds = (imports ?? []).map((row: { id: string }) => row.id);
  if (importIds.length === 0) return [];

  const { data: joins, error: joinError } = await db
    .from("daily_import_words")
    .select("position,word_id,words!inner(normalized_word,display_word,ipa_us,ipa_uk,senses)")
    .in("import_id", importIds)
    .order("position", { ascending: true });
  assertDatabaseResult(joinError);
  const dailyRows = (joins ?? []) as unknown as DailyWordJoin[];
  const wordIds = [...new Set(dailyRows.map((row) => row.word_id))];
  if (wordIds.length === 0) return [];

  const { data: states, error: stateError } = await db
    .from("user_words")
    .select("*")
    .eq("user_id", userId)
    .in("word_id", wordIds);
  assertDatabaseResult(stateError);
  const stateByWord = new Map((states as UserWordRow[] | null ?? []).map((state) => [state.word_id, state]));
  const emitted = new Set<string>();
  const output: VocabularyItem[] = [];
  for (const row of dailyRows) {
    if (emitted.has(row.word_id)) continue;
    const state = stateByWord.get(row.word_id);
    if (!state) continue;
    const word = relationOne(row.words);
    emitted.add(row.word_id);
    output.push(toVocabularyItem(state, word));
  }
  return output;
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

export async function prepareDailyNewWords(
  db = getDatabase(), userId = getAuthenticatedUserId(), date?: string,
): Promise<{ date: string; prepared: number; added: number; limit: number }> {
  const targetDate = date ?? dateInTimeZone(await getUserTimeZone(db, userId));
  const { data, error } = await db.rpc("prepare_daily_new_words_v1", { p_user_id: userId, p_date: targetDate });
  assertDatabaseResult(error);
  return data as { date: string; prepared: number; added: number; limit: number };
}

export async function setDailyNewWordLimit(limit: number): Promise<{ daily_new_word_limit: number }> {
  const { data, error } = await getDatabase().rpc("set_daily_new_word_limit_v1", {
    p_user_id: getAuthenticatedUserId(), p_limit: limit,
  });
  assertDatabaseResult(error);
  return data as { daily_new_word_limit: number };
}

export type DbClient = SupabaseClient;
