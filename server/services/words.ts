import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { UserWordRow, VocabularyItem, WordStatus } from "../types.js";
import { assertDatabaseResult, dateInTimeZone, errorLayers } from "./shared.js";
import { normalizeWord, prepareWordList } from "./wordNormalization.js";

interface RpcImportResult {
  date: string;
  source: string;
  total: number;
  new: number;
  existing: number;
}

interface JoinedUserWord extends UserWordRow {
  word: { normalized_word: string; display_word: string } | Array<{ normalized_word: string; display_word: string }>;
}

interface DailyWordJoin {
  position: number;
  word_id: string;
  words: { normalized_word: string; display_word: string } | Array<{ normalized_word: string; display_word: string }>;
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
}, db = getDatabase(), userId = getAuthenticatedUserId()): Promise<{ word: string; result: string }> {
  const { data, error } = await db.rpc("record_pretest_result_v1", {
    p_user_id: userId,
    p_normalized_word: normalizeWord(input.word),
    p_result: input.result,
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
    .select("position,word_id,words!inner(normalized_word,display_word)")
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
  const { data, error } = await db
    .from("user_words")
    .select("*,word:words!inner(normalized_word,display_word)")
    .eq("user_id", userId)
    .limit(5000);
  assertDatabaseResult(error);
  return ((data ?? []) as unknown as JoinedUserWord[]).map((row) => toVocabularyItem(row, relationOne(row.word)));
}

export function toVocabularyItem(
  state: UserWordRow,
  word: { normalized_word: string; display_word: string },
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
  };
}

export type DbClient = SupabaseClient;

