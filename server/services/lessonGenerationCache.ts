import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LessonExercisePlan } from "../../shared/toolContracts.js";
import type { LessonErrorFocus, LessonProfile } from "./lessonProfile.js";
import {
  lessonGenerationSchema,
  safeParseLessonGenerationForPlan,
  type LessonGeneration,
} from "./deepseek.js";

export const PERSONAL_KAOYAN_SET_ID = "kaoyan-personal-union-v1";
export const LESSON_CACHE_CONTENT_VERSION = "lesson-generation-v4";
export const LESSON_CACHE_PROMPT_VERSION = "lesson-generation-prompt-v4";
export const ANKI_SOURCE_VERSION = "anki-pipeline:2027-redbook:20261015";
export const PRIVATE_UNION_SOURCE_VERSION = "wordloop-private-kaoyan-union-v1";

export const ankiLessonMaterialSchema = z.object({
  word: z.string().trim().min(1).max(120),
  meaning_zh: z.string().trim().min(1).max(240).optional(),
  part_of_speech: z.string().trim().min(1).max(120).optional(),
  ipa: z.string().trim().min(1).max(120).optional(),
  ipa_uk: z.string().trim().min(1).max(120).optional(),
  collocations: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  derivations: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  example_en: z.string().trim().min(1).max(1000).optional(),
  example_zh: z.string().trim().min(1).max(1000).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
  source_fields: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
}).strict();
export type AnkiLessonMaterial = z.output<typeof ankiLessonMaterialSchema>;

export interface PrivateLessonCacheContext {
  userId: string;
  wordId: string;
  word: string;
  meaningZh: string;
  partOfSpeech: string;
  ipa?: string;
  lessonProfile: LessonProfile;
  errorFocus: LessonErrorFocus;
  plan: LessonExercisePlan;
}

export interface LessonCacheLookup {
  privateSetId: string | null;
  material: AnkiLessonMaterial | null;
  materialSourceVersion: string | null;
  materialPayloadHash: string | null;
  lesson: LessonGeneration | null;
}

export class PrivateLessonCacheReadError extends Error {
  readonly retryable: boolean;

  constructor(error: unknown) {
    super("PRIVATE_LESSON_CACHE_READ_FAILED");
    this.name = "PrivateLessonCacheReadError";
    this.retryable = isRetryableCacheReadFailure(error);
  }
}

function isRetryableCacheReadFailure(error: unknown): boolean {
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = String(details.message ?? error ?? "").toLocaleLowerCase();
  const status = Number(details.status);
  if (status === 408 || status === 429 || status >= 500) return true;
  if (/fetch failed|econnreset|network|connection|timeout|temporarily unavailable/u.test(message)) return true;
  if (/unauthori[sz]ed|forbidden|jwt|signature|issuer|audience|permission|rls/u.test(message)) return false;
  return false;
}

async function readPrivateCacheQuery<T>(
  query: PromiseLike<{ data: T | null; error: unknown | null }>,
): Promise<T | null> {
  let result: { data: T | null; error: unknown | null };
  try {
    result = await query;
  } catch (error) {
    throw new PrivateLessonCacheReadError(error);
  }
  if (result.error) throw new PrivateLessonCacheReadError(result.error);
  return result.data;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function lessonCacheHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stablePlan(plan: LessonExercisePlan): Record<string, unknown> {
  return {
    plan_version: plan.plan_version,
    scope: plan.scope,
    word_id: plan.word_id,
    target_word_ids: plan.target_word_ids,
    target_sense: plan.target_sense,
    ...(plan.private_source_book_id ? { private_source_book_id: plan.private_source_book_id } : {}),
    planned_activity_type: plan.planned_activity_type,
    skill_goal: plan.skill_goal,
    error_focus: plan.error_focus,
    skill_ids: plan.skill_ids,
    ...(plan.skill_signals ? { skill_signals: plan.skill_signals } : {}),
    hint_level: plan.hint_level,
  };
}

function isCacheablePrivatePlan(plan: LessonExercisePlan): boolean {
  return !plan.private_source_book_id;
}

export async function lessonGenerationCacheKey(
  input: PrivateLessonCacheContext,
  materialPayloadHash: string | null,
  sourceVersion = ANKI_SOURCE_VERSION,
) {
  const senseFingerprint = await lessonCacheHash(input.plan.target_sense.trim().normalize("NFC"));
  const planFingerprint = await lessonCacheHash(stablePlan(input.plan));
  const cacheKey = await lessonCacheHash({
    user_id: input.userId,
    private_set_id: PERSONAL_KAOYAN_SET_ID,
    word_id: input.wordId,
    word: input.word.trim().toLocaleLowerCase(),
    target_sense: input.plan.target_sense.trim().normalize("NFC"),
    lesson_profile: input.lessonProfile,
    error_focus: input.errorFocus,
    plan: stablePlan(input.plan),
    meaning_zh: input.meaningZh,
    part_of_speech: input.partOfSpeech,
    ipa: input.ipa ?? "",
    material_payload_hash: materialPayloadHash,
    content_version: LESSON_CACHE_CONTENT_VERSION,
    prompt_version: LESSON_CACHE_PROMPT_VERSION,
    source_version: sourceVersion,
  });
  return { cacheKey, planFingerprint, senseFingerprint };
}

/** Both offline seeding and runtime lookup identify the same trusted material. */
export function cacheContextWithAnkiMaterial(input: PrivateLessonCacheContext, material: AnkiLessonMaterial | null): PrivateLessonCacheContext {
  return { ...input, ...(material?.ipa ? { ipa: material.ipa } : {}),
    ...(material?.part_of_speech ? { partOfSpeech: material.part_of_speech } : {}) };
}

async function belongsToPersonalUnion(db: SupabaseClient, userId: string, wordId: string): Promise<boolean> {
  const { data, error } = await db.rpc("can_access_personal_kaoyan_union_v1", { p_word_id: wordId });
  if (error) throw new Error("PRIVATE_LESSON_CACHE_SCOPE_CHECK_FAILED");
  return data === true;
}

function planValidationContext(input: PrivateLessonCacheContext) {
  return {
    word: input.word,
    lesson_profile: input.lessonProfile,
    error_focus: input.errorFocus,
    plan: input.plan,
  };
}

export async function findCachedLesson(
  db: SupabaseClient,
  input: PrivateLessonCacheContext,
): Promise<LessonCacheLookup> {
  if (!isCacheablePrivatePlan(input.plan) || !await belongsToPersonalUnion(db, input.userId, input.wordId)) {
    return { privateSetId: null, material: null, materialSourceVersion: null, materialPayloadHash: null, lesson: null };
  }

  const materialRow = await readPrivateCacheQuery<{
    material_payload?: unknown;
    source_version?: string;
    payload_hash?: string;
  }>(db.from("lesson_generation_cache")
    .select("material_payload,source_version,payload_hash")
    .eq("user_id", input.userId)
    .eq("private_set_id", PERSONAL_KAOYAN_SET_ID)
    .eq("word_id", input.wordId)
    .eq("cache_kind", "materials")
    .eq("target_sense", input.plan.target_sense)
    .eq("source_version", ANKI_SOURCE_VERSION)
    .eq("content_version", LESSON_CACHE_CONTENT_VERSION)
    .eq("prompt_version", LESSON_CACHE_PROMPT_VERSION)
    .in("quality_status", ["valid", "partial"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle());

  const materialResult = ankiLessonMaterialSchema.safeParse(materialRow?.material_payload);
  const material = materialResult.success ? materialResult.data : null;
  const materialSourceVersion = material && typeof materialRow?.source_version === "string" ? materialRow.source_version : null;
  const materialPayloadHash = material && typeof materialRow?.payload_hash === "string"
    ? String(materialRow.payload_hash).trim() : null;
  let lessonRow: { id?: string; lesson_payload?: unknown } | null = null;
  for (const sourceVersion of material
    ? [ANKI_SOURCE_VERSION]
    : [ANKI_SOURCE_VERSION, PRIVATE_UNION_SOURCE_VERSION]) {
    const keys = await lessonGenerationCacheKey(cacheContextWithAnkiMaterial(input, material), materialPayloadHash, sourceVersion);
    const data = await readPrivateCacheQuery<{ id?: string; lesson_payload?: unknown }>(db.from("lesson_generation_cache")
      .select("id,lesson_payload")
      .eq("user_id", input.userId)
      .eq("private_set_id", PERSONAL_KAOYAN_SET_ID)
      .eq("word_id", input.wordId)
      .eq("cache_kind", "lesson")
      .eq("cache_key", keys.cacheKey)
      .eq("content_version", LESSON_CACHE_CONTENT_VERSION)
      .eq("prompt_version", LESSON_CACHE_PROMPT_VERSION)
      .eq("is_valid", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle());
    if (data) {
      lessonRow = data;
      break;
    }
  }
  if (!lessonRow?.lesson_payload) {
    return { privateSetId: PERSONAL_KAOYAN_SET_ID, material, materialSourceVersion, materialPayloadHash, lesson: null };
  }

  const validated = safeParseLessonGenerationForPlan(planValidationContext(input), lessonRow.lesson_payload);
  if (!validated.success) {
    await db.from("lesson_generation_cache").update({
      quality_status: "needs_review",
      is_valid: false,
      error_code: "CACHE_PLAN_VALIDATION_FAILED",
      error_summary: "Saved Lesson payload no longer passes the current frozen-plan validator.",
      updated_at: new Date().toISOString(),
    }).eq("id", lessonRow.id).eq("user_id", input.userId).eq("private_set_id", PERSONAL_KAOYAN_SET_ID);
    return { privateSetId: PERSONAL_KAOYAN_SET_ID, material, materialSourceVersion, materialPayloadHash, lesson: null };
  }
  return { privateSetId: PERSONAL_KAOYAN_SET_ID, material, materialSourceVersion, materialPayloadHash, lesson: validated.data };
}

export function mergeAnkiMaterial(
  generated: LessonGeneration,
  material: AnkiLessonMaterial | null,
  targetSense: string,
): { lesson: LessonGeneration; usedAnki: boolean } {
  if (!material) return { lesson: generated, usedAnki: false };
  const sameSense = material.meaning_zh?.trim().normalize("NFC") === targetSense.trim().normalize("NFC");
  const merged = lessonGenerationSchema.parse({
    ...generated,
    ...(material.ipa ? { ipa: material.ipa } : {}),
    ...(material.part_of_speech ? { part_of_speech: material.part_of_speech } : {}),
    ...(sameSense ? { meaning_zh: material.meaning_zh } : {}),
    ...(sameSense && material.collocations?.length ? { collocations: material.collocations } : {}),
    ...(sameSense && material.derivations?.length ? { derivations: material.derivations } : {}),
    ...(sameSense && material.example_en && material.example_zh ? { example_en: material.example_en, example_zh: material.example_zh } : {}),
    ...(sameSense && material.note ? { note: material.note } : {}),
  });
  return {
    lesson: merged,
    usedAnki: Boolean(material.ipa || material.part_of_speech || (sameSense && (
      material.meaning_zh || material.collocations?.length || material.derivations?.length
      || (material.example_en && material.example_zh) || material.note
    ))),
  };
}

export async function buildPrivateLessonCacheRow(input: {
  db: SupabaseClient;
  context: PrivateLessonCacheContext;
  lesson: LessonGeneration;
  sourceKind: "codebuddy_deepseek" | "mixed" | "runtime_deepseek";
  generationMethod: "codebuddy_cli" | "existing_runtime_fallback";
  sourceVersion?: string;
  modelName?: string;
  modelEffort?: "low";
  codebuddyRequestId?: string;
  materialPayloadHash?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  retryCount?: number;
}) {
  if (!isCacheablePrivatePlan(input.context.plan)) return null;
  const lesson = safeParseLessonGenerationForPlan(planValidationContext(input.context), input.lesson);
  if (!lesson.success) throw new Error("PRIVATE_LESSON_CACHE_VALIDATION_FAILED");
  const sourceVersion = input.sourceVersion ?? "wordloop-runtime-v1";
  const keys = await lessonGenerationCacheKey(
    input.context,
    input.materialPayloadHash ?? null,
    sourceVersion === "wordloop-runtime-v1" ? ANKI_SOURCE_VERSION : sourceVersion,
  );
  const payloadHash = await lessonCacheHash(lesson.data);
  return {
    user_id: input.context.userId,
    private_set_id: PERSONAL_KAOYAN_SET_ID,
    word_id: input.context.wordId,
    cache_kind: "lesson",
    cache_key: keys.cacheKey,
    payload_hash: payloadHash,
    sense_fingerprint: keys.senseFingerprint,
    plan_fingerprint: keys.planFingerprint,
    target_sense: input.context.plan.target_sense,
    lesson_profile: input.context.lessonProfile,
    planned_activity_type: input.context.plan.planned_activity_type,
    error_focus: input.context.errorFocus,
    plan_context: stablePlan(input.context.plan),
    content_version: LESSON_CACHE_CONTENT_VERSION,
    prompt_version: LESSON_CACHE_PROMPT_VERSION,
    source_version: sourceVersion,
    source_kind: input.sourceKind,
    generation_method: input.generationMethod,
    material_payload: {},
    lesson_payload: lesson.data,
    missing_fields: [],
    quality_status: "valid",
    is_valid: true,
    model_name: input.modelName ?? null,
    model_effort: input.modelEffort ?? null,
    codebuddy_request_id: input.codebuddyRequestId ?? null,
    input_tokens: input.inputTokens ?? null,
    output_tokens: input.outputTokens ?? null,
    token_usage_status: input.inputTokens !== undefined && input.outputTokens !== undefined ? "available" : "unavailable",
    retry_count: input.retryCount ?? 0,
    error_code: null,
    error_summary: null,
    updated_at: new Date().toISOString(),
  };
}

export async function savePrivateLessonCache(input: Parameters<typeof buildPrivateLessonCacheRow>[0]): Promise<void> {
  const row=await buildPrivateLessonCacheRow(input);
  if(!row)return;
  const {error}=await input.db.from("lesson_generation_cache").upsert(row,{
    onConflict: "user_id,private_set_id,word_id,cache_kind,content_version,prompt_version,cache_key,payload_hash",
    ignoreDuplicates:true,
  });
  if(error)throw new Error("PRIVATE_LESSON_CACHE_WRITE_FAILED");
}

export async function savePrivateLessonCacheBatch(inputs: Parameters<typeof buildPrivateLessonCacheRow>[0][]): Promise<void> {
  if(!inputs.length)return;
  if(inputs.length>32||inputs.some(i=>i.db!==inputs[0]!.db||i.context.userId!==inputs[0]!.context.userId))throw new Error("PRIVATE_CACHE_BATCH_SCOPE_INVALID");
  const rows=(await Promise.all(inputs.map(buildPrivateLessonCacheRow))).filter((r):r is NonNullable<typeof r>=>r!==null);
  const {error}=await inputs[0]!.db.from("lesson_generation_cache").upsert(rows,{
    onConflict: "user_id,private_set_id,word_id,cache_kind,content_version,prompt_version,cache_key,payload_hash",
    ignoreDuplicates:true,
  });
  if(error)throw new Error("PRIVATE_LESSON_CACHE_WRITE_FAILED");
}

export interface AnkiMaterialsCacheInput {
  wordId: string;
  targetSense: string;
  material: AnkiLessonMaterial;
  missingFields: string[];
  qualityStatus: "partial" | "needs_review";
  retryCount?: number;
  errorCode?: string;
  errorSummary?: string;
}

export async function saveAnkiMaterialsCacheBatch(input: {
  db: SupabaseClient;
  userId: string;
  entries: readonly AnkiMaterialsCacheInput[];
}): Promise<number> {
  const rows = await Promise.all(input.entries.map(async (entry) => {
    const parsed = ankiLessonMaterialSchema.parse(entry.material);
    const senseFingerprint = await lessonCacheHash(entry.targetSense.trim().normalize("NFC"));
    const payloadHash = await lessonCacheHash(parsed);
    const cacheKey = await lessonCacheHash({
      user_id: input.userId,
      private_set_id: PERSONAL_KAOYAN_SET_ID,
      word_id: entry.wordId,
      target_sense: entry.targetSense,
      source_version: ANKI_SOURCE_VERSION,
      payload_hash: payloadHash,
    });
    return {
      user_id: input.userId,
      private_set_id: PERSONAL_KAOYAN_SET_ID,
      word_id: entry.wordId,
      cache_kind: "materials",
      cache_key: cacheKey,
      payload_hash: payloadHash,
      sense_fingerprint: senseFingerprint,
      plan_fingerprint: null,
      target_sense: entry.targetSense,
      lesson_profile: null,
      planned_activity_type: null,
      error_focus: null,
      plan_context: {},
      content_version: LESSON_CACHE_CONTENT_VERSION,
      prompt_version: LESSON_CACHE_PROMPT_VERSION,
      source_version: ANKI_SOURCE_VERSION,
      source_kind: "anki",
      generation_method: "apkg_import",
      material_payload: parsed,
      lesson_payload: null,
      missing_fields: entry.missingFields,
      quality_status: entry.qualityStatus,
      is_valid: false,
      token_usage_status: "unavailable",
      retry_count: entry.retryCount ?? 0,
      error_code: entry.errorCode ?? null,
      error_summary: entry.errorSummary ?? null,
      updated_at: new Date().toISOString(),
    };
  }));
  if (rows.length === 0) return 0;
  const { data, error } = await input.db.from("lesson_generation_cache").upsert(rows, {
    onConflict: "user_id,private_set_id,word_id,cache_kind,content_version,prompt_version,cache_key,payload_hash",
    ignoreDuplicates: true,
  }).select("id");
  if (error) throw new Error("PRIVATE_LESSON_CACHE_WRITE_FAILED");
  return data?.length ?? 0;
}

export async function saveAnkiMaterialsCache(input: {
  db: SupabaseClient;
  userId: string;
} & AnkiMaterialsCacheInput): Promise<void> {
  await saveAnkiMaterialsCacheBatch({ db: input.db, userId: input.userId, entries: [input] });
}

export async function savePrivateLessonCacheFailure(input: {
  db: SupabaseClient;
  context: PrivateLessonCacheContext;
  materialPayloadHash: string | null;
  missingFields: string[];
  retryCount: number;
  sourceVersion?: string;
  errorCode: string;
}): Promise<void> {
  if (!isCacheablePrivatePlan(input.context.plan)) return;
  const sourceVersion = input.sourceVersion ?? ANKI_SOURCE_VERSION;
  const keys = await lessonGenerationCacheKey(input.context, input.materialPayloadHash, sourceVersion);
  const payloadHash = await lessonCacheHash({ error_code: input.errorCode, retry_count: input.retryCount });
  const { error } = await input.db.from("lesson_generation_cache").upsert({
    user_id: input.context.userId,
    private_set_id: PERSONAL_KAOYAN_SET_ID,
    word_id: input.context.wordId,
    cache_kind: "lesson",
    cache_key: keys.cacheKey,
    payload_hash: payloadHash,
    sense_fingerprint: keys.senseFingerprint,
    plan_fingerprint: keys.planFingerprint,
    target_sense: input.context.plan.target_sense,
    lesson_profile: input.context.lessonProfile,
    planned_activity_type: input.context.plan.planned_activity_type,
    error_focus: input.context.errorFocus,
    plan_context: stablePlan(input.context.plan),
    content_version: LESSON_CACHE_CONTENT_VERSION,
    prompt_version: LESSON_CACHE_PROMPT_VERSION,
    source_version: sourceVersion,
    source_kind: "codebuddy_deepseek",
    generation_method: "codebuddy_cli",
    material_payload: {},
    lesson_payload: null,
    missing_fields: input.missingFields,
    quality_status: "failed",
    is_valid: false,
    model_name: "deepseek-v4.1-flash",
    model_effort: "low",
    token_usage_status: "unavailable",
    retry_count: input.retryCount,
    error_code: input.errorCode,
    error_summary: "Offline CodeBuddy generation or current Lesson validator failed; see the private local checkpoint for sanitized status.",
    updated_at: new Date().toISOString(),
  }, {
    onConflict: "user_id,private_set_id,word_id,cache_kind,content_version,prompt_version,cache_key,payload_hash",
    ignoreDuplicates: true,
  });
  if (error) throw new Error("PRIVATE_LESSON_CACHE_WRITE_FAILED");
}
