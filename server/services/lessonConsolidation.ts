import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { StudyState } from "../types.js";
import { assertDatabaseResult, dateInTimeZone, localDateRange } from "./shared.js";
import { normalizeWord } from "./wordNormalization.js";
import { getUserTimeZone } from "./words.js";

export type ConsolidationKind = "translation" | "sentence";

export interface LessonConsolidationDecision {
  kind: ConsolidationKind;
  trigger_round: number;
  target_words: string[];
}

type CompletedRound = { state: StudyState; ended_at?: string | null };

function completedLessonSummary(value: unknown): value is StudyState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const payload = state.payload;
  return state.widget === "lesson"
    && typeof payload === "object"
    && payload !== null
    && !Array.isArray(payload)
    && (payload as Record<string, unknown>).mode === "completed";
}

function completedRoundQuery(db: SupabaseClient, userId: string) {
  return db.from("study_sessions")
    .select("state,ended_at")
    .eq("user_id", userId)
    .contains("state", { widget: "lesson", payload: { mode: "completed" } });
}

/** Count durable completed Lesson rounds by the user's local completion date. */
export async function countCompletedLessonRoundsToday(
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<number> {
  const timeZone = await getUserTimeZone(db, userId);
  const date = dateInTimeZone(timeZone);
  const { start, end } = localDateRange(date, timeZone);
  const { data, error } = await completedRoundQuery(db, userId)
    .gte("ended_at", start)
    .lt("ended_at", end);
  assertDatabaseResult(error);
  return ((data ?? []) as Array<{ state: unknown }>).filter((row) => completedLessonSummary(row.state)).length;
}

async function recentCompletedLessonRounds(
  db: SupabaseClient,
  userId: string,
): Promise<CompletedRound[]> {
  const { data, error } = await completedRoundQuery(db, userId)
    .not("ended_at", "is", null)
    .order("ended_at", { ascending: false })
    .limit(8);
  assertDatabaseResult(error);
  return ((data ?? []) as Array<{ state: unknown; ended_at?: string | null }>)
    .filter((row): row is { state: StudyState; ended_at?: string | null } => completedLessonSummary(row.state));
}

/** Cadence priority is intentional: round 6 receives one translation task. */
export function consolidationKindForRound(round: number): ConsolidationKind | null {
  if (round <= 0) return null;
  if (round % 2 === 0) return "translation";
  if (round % 3 === 0) return "sentence";
  return null;
}

function targetLimit(kind: ConsolidationKind): { min: number; max: number } {
  return kind === "translation" ? { min: 2, max: 3 } : { min: 1, max: 2 };
}

function targetCandidates(state: StudyState): Array<{ word: string; score: number }> {
  const queue = state.flow.lesson_words ?? [];
  const history = new Map((state.flow.lesson_profile_history ?? []).map((entry) => [normalizeWord(entry.word), entry]));
  const relearn = new Set((state.flow.relearn_words ?? []).map(normalizeWord));
  return [...queue].reverse().map((word) => {
    const profile = history.get(normalizeWord(word));
    const score = relearn.has(normalizeWord(word))
      || profile?.lesson_profile === "targeted_relearn"
      || profile?.error_focus !== null && profile?.error_focus !== undefined
      ? 0
      : profile?.lesson_profile === "reinforce" ? 1 : 2;
    return { word, score };
  });
}

/**
 * Pick from the active round and the latest completed rounds, capped to the
 * most recent 14 Lesson words. Weak/relearn profiles rank ahead of quick recall.
 */
export function selectConsolidationTargetWords(
  recentRounds: readonly CompletedRound[],
  currentState: StudyState,
  kind: ConsolidationKind,
): string[] {
  const candidates = [
    ...targetCandidates(currentState),
    ...recentRounds.flatMap(({ state }) => targetCandidates(state)),
  ];
  const pool: Array<{ word: string; score: number }> = [];
  const pooledWords = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeWord(candidate.word);
    if (!normalized || pooledWords.has(normalized)) continue;
    pooledWords.add(normalized);
    pool.push(candidate);
    if (pool.length === 14) break;
  }
  const usedRecently = new Set<string>();
  for (const round of recentRounds) {
    const payload = round.state.payload as Record<string, unknown>;
    const targets = payload.consolidation_target_words;
    if (Array.isArray(targets)) {
      for (const word of targets) if (typeof word === "string") usedRecently.add(normalizeWord(word));
    }
  }
  const { min, max } = targetLimit(kind);
  const byPriority = [...pool].sort((left, right) => left.score - right.score);
  const fresh = byPriority.filter(({ word }) => !usedRecently.has(normalizeWord(word)));
  const ordered = fresh.length >= min ? fresh : byPriority;
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const normalized = normalizeWord(candidate.word);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    selected.push(candidate.word);
    if (selected.length === max) break;
  }
  return selected;
}

function isFinalAcceptedLessonRound(state: StudyState): boolean {
  if (state.widget !== "lesson" || state.phase !== "lesson_complete" || state.payload.mode !== "feedback") return false;
  const queue = state.flow.lesson_words ?? [];
  const feedback = state.payload.feedback;
  if (queue.length === 0 || state.current_index !== queue.length - 1 || !state.current_word
    || normalizeWord(state.current_word) !== normalizeWord(queue[queue.length - 1] ?? "")
    || typeof feedback !== "object" || feedback === null || Array.isArray(feedback)) return false;
  const verdict = feedback as Record<string, unknown>;
  return verdict.is_correct === true || verdict.reveal_answer === true;
}

/** Attach the server-owned cadence point to the unfinished round's JSON state. */
export async function decideLessonConsolidation(
  state: StudyState,
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<StudyState> {
  if (!isFinalAcceptedLessonRound(state) || state.payload.consolidation === true) return state;
  const triggerRound = (await countCompletedLessonRoundsToday(db, userId)) + 1;
  const kind = consolidationKindForRound(triggerRound);
  if (!kind) return state;
  const recentRounds = await recentCompletedLessonRounds(db, userId);
  const targetWords = selectConsolidationTargetWords(recentRounds, state, kind);
  const { min } = targetLimit(kind);
  if (targetWords.length < min) return state;
  return {
    ...state,
    payload: {
      ...state.payload,
      consolidation: true,
      consolidation_kind: kind,
      consolidation_trigger_round: triggerRound,
      consolidation_target_words: targetWords,
      consolidation_status: "pending",
    },
  };
}
