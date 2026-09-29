import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { analyticsEnvelopeSchema, vocabularyFilterSchema, vocabularyQuerySchema, type VocabularyFilter } from "../../shared/analyticsContracts.js";
import type { AnalyticsEnvelope } from "../../shared/analyticsContracts.js";
import type { UserWordRow } from "../types.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { getRetrievability } from "./analytics.js";
import { getPronunciationAudio } from "../tools/getPronunciationAudio.js";
import { getUserTimeZone } from "./words.js";

const PAGE_SIZE_MAX = 100;
const userWordColumns = "id,user_id,word_id,status,source,first_seen_at,last_seen_at,last_reviewed_at,correct_count,wrong_count,consecutive_correct,meaning_error,collocation_error,grammar_error,pronunciation_error,spelling_error,mastered,next_review_at,fsrs_stability,fsrs_difficulty,fsrs_elapsed_days,fsrs_scheduled_days,fsrs_learning_steps,fsrs_reps,fsrs_lapses,fsrs_state,word:words!inner(id,normalized_word,display_word,ipa_us,ipa_uk,senses)";

type WordEntity = { id: string; normalized_word: string; display_word: string; ipa_us: string | null; ipa_uk: string | null; senses: unknown };
type JoinedUserWord = UserWordRow & { word: WordEntity | WordEntity[] };

export class VocabularyServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "VocabularyServiceError";
  }
}

function fail(error: { message?: string } | null): void {
  if (error) throw new VocabularyServiceError(500, "VOCABULARY_QUERY_FAILED", "词库暂时不可用，请稍后重试。");
}

function wordEntity(value: WordEntity | WordEntity[]): WordEntity {
  return Array.isArray(value) ? value[0]! : value;
}

function cursorEncode(firstSeenAt: string, id: string): string {
  return encodeURIComponent(`${firstSeenAt}~${id}`);
}

function cursorDecode(value: string): { first_seen_at: string; id: string } | null {
  if (!value) return null;
  let decoded = "";
  try { decoded = decodeURIComponent(value); } catch {
    throw new VocabularyServiceError(400, "INVALID_CURSOR", "词库分页游标无效。");
  }
  const splitAt = decoded.lastIndexOf("~");
  const firstSeenAt = decoded.slice(0, splitAt);
  const id = decoded.slice(splitAt + 1);
  if (splitAt < 1 || !Number.isFinite(Date.parse(firstSeenAt)) || !z.string().uuid().safeParse(id).success) {
    throw new VocabularyServiceError(400, "INVALID_CURSOR", "词库分页游标无效。");
  }
  return { first_seen_at: new Date(firstSeenAt).toISOString(), id };
}

function activeLayers(row: UserWordRow): string[] {
  return [
    ...(row.meaning_error ? ["meaning"] : []),
    ...(row.collocation_error ? ["collocation"] : []),
    ...(row.grammar_error ? ["grammar"] : []),
    ...(row.pronunciation_error ? ["pronunciation"] : []),
    ...(row.spelling_error ? ["spelling"] : []),
  ];
}

function filtersFrom(value: unknown): VocabularyFilter[] {
  const parsed = z.array(vocabularyFilterSchema).max(4).safeParse(value);
  if (!parsed.success) throw new VocabularyServiceError(400, "INVALID_FILTER", "词库筛选条件无效。");
  return [...new Set(parsed.data)];
}

export async function listVocabulary(
  input: unknown = {},
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
  asOf = new Date(),
): Promise<AnalyticsEnvelope<{ items: Array<Record<string, unknown>> }>> {
  const parsed = vocabularyQuerySchema.safeParse(input);
  if (!parsed.success) throw new VocabularyServiceError(400, "INVALID_QUERY", "词库搜索条件无效。");
  const filters = filtersFrom(parsed.data.filters);
  const cursor = cursorDecode(parsed.data.cursor);
  const timeZone = await getUserTimeZone(db, userId);
  const result = await db.rpc("list_user_vocabulary_v1", {
    p_user_id: userId,
    p_query: parsed.data.q,
    p_filters: filters,
    p_before_first_seen: cursor?.first_seen_at ?? null,
    p_before_id: cursor?.id ?? null,
    p_limit: parsed.data.limit + 1,
    p_as_of: asOf.toISOString(),
  });
  fail(result.error);
  const rows = (result.data ?? []) as Array<UserWordRow & WordEntity>;
  const visible = rows.slice(0, parsed.data.limit);
  const items = visible.map((row) => {
    return {
      user_word_id: row.id,
      word_id: row.word_id,
      word: row.normalized_word,
      display_word: row.display_word,
      ipa_us: row.ipa_us,
      ipa_uk: row.ipa_uk,
      status: row.status,
      source: row.source,
      fsrs_reps: row.fsrs_reps,
      fsrs_difficulty: row.fsrs_reps > 0 && Number.isFinite(row.fsrs_difficulty) ? row.fsrs_difficulty : null,
      fsrs_stability: row.fsrs_reps > 0 && Number.isFinite(row.fsrs_stability) && row.fsrs_stability > 0 ? row.fsrs_stability : null,
      next_review_at: row.next_review_at,
      active_error_layers: activeLayers(row),
    };
  });
  const last = visible.at(-1);
  const envelope = analyticsEnvelopeSchema.parse({
    data: { items },
    as_of: asOf.toISOString(),
    timezone: timeZone,
    definition_version: "wordloop-analytics-v1",
    coverage: { source: "user_words + words", search: "server-side", filters: "all selected filters use AND semantics" },
    ...(rows.length > parsed.data.limit && last ? { next_cursor: cursorEncode(last.first_seen_at, last.id) } : {}),
  }) as AnalyticsEnvelope<{ items: Array<Record<string, unknown>> }>;
  return envelope;
}

export async function getVocabularyDetail(
  userWordId: string,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
  asOf = new Date(),
): Promise<AnalyticsEnvelope<Record<string, unknown>>> {
  if (!z.string().uuid().safeParse(userWordId).success) {
    throw new VocabularyServiceError(404, "VOCABULARY_NOT_FOUND", "这个词条不存在或已不可用。");
  }
  const timeZone = await getUserTimeZone(db, userId);
  const wordResult = await db.from("user_words").select(userWordColumns).eq("user_id", userId).eq("id", userWordId).maybeSingle();
  fail(wordResult.error);
  if (!wordResult.data) throw new VocabularyServiceError(404, "VOCABULARY_NOT_FOUND", "这个词条不存在或已不可用。");
  const row = wordResult.data as unknown as JoinedUserWord;
  const word = wordEntity(row.word);
  const [reviews, errors, captures, pronunciation] = await Promise.all([
    db.from("fsrs_review_logs").select("id,rating,scheduled_days,elapsed_days,reviewed_at,state,due")
      .eq("user_id", userId).eq("word_id", row.word_id).eq("review_source", "review")
      .lte("reviewed_at", asOf.toISOString()).order("reviewed_at", { ascending: false }).order("id", { ascending: false }).limit(10),
    db.from("attempts").select("id,activity_type,error_layer,user_answer,created_at")
      .eq("user_id", userId).eq("word_id", row.word_id).eq("is_correct", false)
      .lte("created_at", asOf.toISOString()).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(10),
    db.from("captured_notes").select("id,selected_text,note,status,updated_at")
      .eq("user_id", userId).eq("converted_user_word_id", userWordId).order("updated_at", { ascending: false }).limit(20),
    getPronunciationAudio([word.display_word]),
  ]);
  fail(reviews.error); fail(errors.error); fail(captures.error);
  const noteRows = captures.data ?? [];
  const noteIds = noteRows.map((note: { id: string }) => note.id);
  let occurrences: unknown[] = [];
  if (noteIds.length) {
    const occurrenceResult = await db.from("captured_note_occurrences")
      .select("captured_note_id,context_text,source_type,source_title,source_url,captured_at")
      .eq("user_id", userId).in("captured_note_id", noteIds)
      .order("captured_at", { ascending: false }).limit(50);
    fail(occurrenceResult.error);
    occurrences = occurrenceResult.data ?? [];
  }
  const retrievability = getRetrievability(row, asOf);
  const layers = activeLayers(row);
  const dueTime = row.next_review_at ? Date.parse(row.next_review_at) : Number.POSITIVE_INFINITY;
  const reasons = [
    ...(layers.length ? ["active_error"] : []),
    ...(row.fsrs_reps > 0 && Number.isFinite(dueTime) && dueTime < asOf.getTime() ? ["overdue"] : []),
    ...(retrievability !== null && retrievability < 0.9 ? ["r_below_target"] : []),
    ...(row.fsrs_reps > 0 && Number.isFinite(row.fsrs_difficulty) && row.fsrs_difficulty >= 7
      && Number.isFinite(row.fsrs_stability) && row.fsrs_stability > 0 && row.fsrs_stability <= 2 ? ["high_d_low_s"] : []),
  ];
  return analyticsEnvelopeSchema.parse({
    data: {
      user_word_id: row.id,
      word_id: row.word_id,
      word: word.normalized_word,
      display_word: word.display_word,
      ipa_us: word.ipa_us,
      ipa_uk: word.ipa_uk,
      audio_url: pronunciation.words[0]?.audio_url ?? null,
      senses: Array.isArray(word.senses) ? word.senses : [],
      status: row.status,
      source: row.source,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      last_reviewed_at: row.last_reviewed_at,
      active_error_layers: layers,
      focus_reasons: reasons,
      memory: {
        difficulty: row.fsrs_reps > 0 && Number.isFinite(row.fsrs_difficulty) ? row.fsrs_difficulty : null,
        stability_days: row.fsrs_reps > 0 && Number.isFinite(row.fsrs_stability) && row.fsrs_stability > 0 ? row.fsrs_stability : null,
        retrievability,
        lapses: row.fsrs_reps > 0 ? row.fsrs_lapses : null,
        next_review_at: row.next_review_at,
        model_estimate_as_of: asOf.toISOString(),
      },
      recent_formal_reviews: reviews.data ?? [],
      recent_error_attempts: errors.data ?? [],
      captured_notes: noteRows,
      capture_occurrences: occurrences,
    },
    as_of: asOf.toISOString(),
    timezone: timeZone,
    definition_version: "wordloop-analytics-v1",
    coverage: { review_source: "fsrs_review_logs where review_source=review", error_source: "wrong attempts only", captures: "linked captured notes and latest 50 occurrences" },
  }) as AnalyticsEnvelope<Record<string, unknown>>;
}
