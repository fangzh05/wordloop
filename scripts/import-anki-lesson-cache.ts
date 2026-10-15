import {assertLessonTextQuality} from '../server/services/lessonContentQuality.js';
import "dotenv/config";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { configureRuntimeEnv, getDatabase, withUserIdentity } from "../server/db.js";
import {
  lessonGenerationSchema,
  parseLessonGenerationForPlan,
  safeParseLessonGenerationForPlan,
  type LessonGeneration,
} from "../server/services/deepseek.js";
import {
  ankiLessonMaterialSchema,
  findCachedLesson,
  lessonCacheHash,
  lessonGenerationCacheKey,
  saveAnkiMaterialsCacheBatch,
  savePrivateLessonCache,
  savePrivateLessonCacheFailure,
  PrivateLessonCacheReadError,
  type AnkiLessonMaterial,
  type AnkiMaterialsCacheInput,
  type PrivateLessonCacheContext,
  ANKI_SOURCE_VERSION,
  PRIVATE_UNION_SOURCE_VERSION,
  LESSON_CACHE_CONTENT_VERSION,
  LESSON_CACHE_PROMPT_VERSION,
} from "../server/services/lessonGenerationCache.js";
import { LESSON_GENERATION_PROMPT } from "../server/services/deepseekPrompts.js";
import { isOutsideCheckout, privateDataRoot } from "./lib/privateDataPath.js";
import {
  lessonExercisePlanSchema,
  plannedActivityTypeSchema,
  type LessonExercisePlan,
} from "../shared/toolContracts.js";
import { formatMeaningByPartOfSpeech, formatPartOfSpeech } from "../shared/lexicalDisplay.js";

const CHECKOUT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const MAX_INPUT_TOKENS_PER_CALL = 50_000;
const MAX_OUTPUT_TOKENS_PER_CALL = 5_000;
const SOURCE_VERSION = ANKI_SOURCE_VERSION;
const SOURCE_ROOT = "https://github.com/CHNragdoll/anki-pipeline";
const CACHE_CHECKPOINT_VERSION = 3;
const outputFields = ["ipa", "part_of_speech", "meaning_zh", "collocations", "derivations", "example_en", "example_zh", "note", "exercise"] as const;
const crossSpawn = createRequire(import.meta.url)("cross-spawn") as typeof nodeSpawn & { sync: typeof spawnSync };
type OutputField = (typeof outputFields)[number];
type CacheFailureCode = "CODEBUDDY_TIMEOUT" | "CODEBUDDY_EXIT" | "CODEBUDDY_INVALID_JSON"
  | "LESSON_SCHEMA_INVALID" | "WORD_RECALL_ACCEPTED_ANSWER_NOT_CANONICAL" | "LESSON_ACTIVITY_TYPE_MISMATCH"
  | "CODEBUDDY_TOKEN_OUTLIER";

interface Args {
  apkg?: string;
  materialsJsonl?: string;
  manifest?: string;
  privateDataDir: string;
  userId: string;
  wordList?: string;
  limit?: number;
  dryRun: boolean;
  resume: boolean;
  retryFailed: boolean;
  importOnly: boolean;
  codebuddyCommand: string;
  codebuddyModel: string;
  timeoutMs: number;
  maxRetries: number;
  lessonProfile: "quick_recall" | "reinforce" | "targeted_relearn";
  activityType: string;
  errorFocus: string | null;
  report?: string;
}

interface ExtractedAnkiRecord {
  normalized_word: string;
  display_word: string;
  source_note_id: string;
  source_model_id: string;
  source_fields: string[];
  meaning_zh?: string;
  part_of_speech?: string;
  ipa?: string;
  ipa_uk?: string;
  collocations?: string[];
  derivations?: string[];
  example_en?: string;
  example_zh?: string;
  note?: string;
  alternate_meanings_zh?: string[];
}

export interface WordRow {
  id: string;
  normalized_word: string;
  display_word: string;
  senses: unknown;
  ipa_us: string | null;
  ipa_uk: string | null;
}

interface SenseRow { pos: string; definition_cn: string; }
interface LessonWorkEntry {
  record: ExtractedAnkiRecord;
  row: WordRow;
  targetSense: string;
  meaningZh: string;
  material: AnkiLessonMaterial;
  base: Partial<LessonGeneration>;
  missingFields: OutputField[];
  senseMatched: boolean;
  ankiPresent: boolean;
}

export function buildPrivateUnionWork(
  records: readonly ExtractedAnkiRecord[],
  wordRows: readonly WordRow[],
): { entries: LessonWorkEntry[]; matchedWords: number; unmatchedAnkiRecords: number } {
  const recordsByNormalized = new Map<string, ExtractedAnkiRecord[]>();
  for (const record of records) {
    const key = record.normalized_word.trim().toLocaleLowerCase();
    recordsByNormalized.set(key, [...(recordsByNormalized.get(key) ?? []), record]);
  }
  const wordCounts = new Map<string, number>();
  for (const row of wordRows) {
    const key = row.normalized_word.trim().toLocaleLowerCase();
    wordCounts.set(key, (wordCounts.get(key) ?? 0) + 1);
  }
  const consumed = new Set<ExtractedAnkiRecord>();
  const entries = [...wordRows]
    .sort((left, right) => left.normalized_word.localeCompare(right.normalized_word) || left.id.localeCompare(right.id))
    .map((row): LessonWorkEntry => {
      const normalized = row.normalized_word.trim().toLocaleLowerCase();
      const candidates = recordsByNormalized.get(normalized) ?? [];
      const ankiPresent = wordCounts.get(normalized) === 1 && candidates.length === 1;
      const record: ExtractedAnkiRecord = ankiPresent ? candidates[0]! : {
        normalized_word: row.normalized_word,
        display_word: row.display_word,
        source_note_id: candidates.length > 0 ? "ambiguous-anki-match" : "no-anki-record",
        source_model_id: "none",
        source_fields: [],
      };
      if (ankiPresent) consumed.add(record);
      const senses = parseSenses(row.senses);
      const targetSense = targetSenseForWord(senses) || "—";
      const meaningZh = formatMeaningByPartOfSpeech(senses);
      if (targetSense === "—" || !meaningZh) {
        return {
          record,
          row,
          targetSense,
          meaningZh,
          material: ankiLessonMaterialSchema.parse({ word: row.display_word, source_fields: ankiPresent ? record.source_fields : [] }),
          base: {} as Partial<LessonGeneration>,
          missingFields: [...outputFields],
          senseMatched: false,
          ankiPresent,
        };
      }
      const mapped = collectAnkiMaterial(record, row, targetSense);
      return { record, row, targetSense, meaningZh, ...mapped, ankiPresent };
    });
  return {
    entries,
    matchedWords: entries.filter((entry) => entry.ankiPresent).length,
    unmatchedAnkiRecords: records.filter((record) => !consumed.has(record)).length,
  };
}

function hasReusableAnkiMaterial(entry: LessonWorkEntry): boolean {
  return entry.ankiPresent
    && Object.keys(entry.material).some((field) => field !== "word" && field !== "source_fields");
}
interface CheckpointEntry {
  status: "materials_saved" | "generated_pending_import" | "valid" | "needs_review" | "failed";
  material_status?: "saved" | "failed";
  material_error_code?: "MATERIAL_IMPORT_FAILED";
  word_id: string;
  source_note_id: string;
  retry_count: number;
  error_code?: string;
  input_tokens?: number;
  output_tokens?: number;
  input_fingerprint?: string;
  lesson?: LessonGeneration;
  updated_at: string;
}
interface Checkpoint {
  version: number;
  source_version: string;
  source_sha256: string;
  generation_config: string;
  user_id: string;
  entries: Record<string, CheckpointEntry>;
}

export function readArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error("UNEXPECTED_ARGUMENT");
    if (["--dry-run", "--resume", "--retry-failed", "--import-only"].includes(item)) flags.add(item);
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`MISSING_VALUE:${item}`);
      values.set(item, value);
      index += 1;
    }
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`REQUIRED_ARGUMENT:${key}`);
    return value;
  };
  const positiveInt = (key: string, fallback: number, max: number) => {
    const raw = values.get(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`INVALID_ARGUMENT:${key}`);
    return parsed;
  };
  const profile = values.get("--lesson-profile") ?? "quick_recall";
  if (!(["quick_recall", "reinforce", "targeted_relearn"] as string[]).includes(profile)) throw new Error("INVALID_LESSON_PROFILE");
  const activityType = plannedActivityTypeSchema.parse(values.get("--planned-activity-type") ?? "word_recall");
  const rawErrorFocus = values.get("--error-focus") ?? "none";
  const errorFocus = rawErrorFocus === "none" ? null : rawErrorFocus;
  if (errorFocus && !(["meaning", "collocation", "grammar", "spelling", "pronunciation"] as string[]).includes(errorFocus)) {
    throw new Error("INVALID_ERROR_FOCUS");
  }
  const model = values.get("--codebuddy-model") ?? DEFAULT_MODEL;
  if (!/^deepseek-[a-z0-9.-]+$/i.test(model)) throw new Error("ONLY_CODEBUDDY_DEEPSEEK_MODELS_ALLOWED");
  if (flags.has("--dry-run") && flags.has("--retry-failed")) throw new Error("DRY_RUN_CANNOT_RETRY");
  if (flags.has("--retry-failed") && !flags.has("--resume")) throw new Error("RETRY_FAILED_REQUIRES_RESUME");
  return {
    apkg: values.get("--apkg"),
    materialsJsonl: values.get("--materials-jsonl"),
    manifest: values.get("--manifest"),
    privateDataDir: required("--private-data-dir"),
    userId: z.string().uuid().parse(required("--user-id")),
    ...(values.has("--limit") ? { limit: positiveInt("--limit", 1, 100_000) } : {}),
    ...(values.has("--word-list") ? { wordList: required("--word-list") } : {}),
    dryRun: flags.has("--dry-run"),
    resume: flags.has("--resume"),
    retryFailed: flags.has("--retry-failed"),
    importOnly: flags.has("--import-only"),
    codebuddyCommand: values.get("--codebuddy-command") ?? "codebuddy",
    codebuddyModel: model,
    timeoutMs: positiveInt("--timeout", 120_000, 600_000),
    maxRetries: positiveInt("--max-retries", 2, 5),
    lessonProfile: profile as Args["lessonProfile"],
    activityType,
    errorFocus,
    report: values.get("--report"),
  };
}

export function requireStagingEnvironment(): void {
  const branchId = process.env.WORDLOOP_STAGING_NEON_BRANCH_ID;
  const dataApi = process.env.WORDLOOP_STAGING_NEON_DATA_API_URL;
  const jwk = process.env.WORDLOOP_STAGING_NEON_WORKER_JWT_PRIVATE_JWK;
  const supabaseUrl = process.env.WORDLOOP_STAGING_SUPABASE_URL;
  if (!branchId || !dataApi || !jwk || !supabaseUrl) throw new Error("STAGING_NEON_ENV_REQUIRED");
  if (branchId !== "br-spring-unit-azxctyf3") throw new Error("STAGING_BRANCH_ID_MISMATCH");
  const apiUrl = new URL(dataApi);
  if (apiUrl.protocol !== "https:" || apiUrl.hostname !== "ep-soft-bar-azahdy4w.apirest.c-3.ap-southeast-1.aws.neon.tech"
    || !apiUrl.pathname.endsWith("/neondb/rest/v1")) throw new Error("STAGING_ENDPOINT_MISMATCH");
  configureRuntimeEnv({
    ...process.env,
    SUPABASE_URL: supabaseUrl,
    NEON_DATA_API_URL: dataApi,
    NEON_WORKER_JWT_PRIVATE_JWK: jwk,
    NEON_JWT_AUDIENCE: process.env.WORDLOOP_STAGING_NEON_JWT_AUDIENCE ?? "wordloop-neon-api",
    NEON_JWT_ISSUER: process.env.WORDLOOP_STAGING_NEON_JWT_ISSUER ?? `${new URL(supabaseUrl).origin}/auth/v1`,
    DEV_USER_ID: undefined,
  });
}

export function parseSenses(value: unknown): SenseRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const sense = row as Record<string, unknown>;
    const definition = typeof sense.definition_cn === "string" ? sense.definition_cn.trim() : "";
    const pos = typeof sense.pos === "string" ? sense.pos.trim() : "";
    return definition ? [{ definition_cn: definition, pos }] : [];
  });
}

function targetSenseForWord(senses: SenseRow[]): string {
  // Match planLessonQueue exactly: its frozen target sense is the joined
  // definition list, while the Lesson display meaning remains POS-grouped.
  return senses.map((sense) => sense.definition_cn.trim()).filter(Boolean).join("；").slice(0, 240).trim();
}

export function normalizeSense(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hasChinese(value: string): boolean { return /\p{Script=Han}/u.test(value); }

function ankiMeaningMatchesSenses(ankiMeaning: string | undefined, senses: SenseRow[], targetSense: string): boolean {
  if (!ankiMeaning || !hasChinese(ankiMeaning)) return false;
  const normalized = normalizeSense(ankiMeaning);
  const definitionsOnly = [...new Set(senses.map((sense) => sense.definition_cn.trim()).filter(Boolean))].join("；");
  return [targetSense, definitionsOnly].some((candidate) => normalizeSense(candidate) === normalized);
}

function collectAnkiMaterial(record: ExtractedAnkiRecord, row: WordRow, targetSense: string): {
  material: AnkiLessonMaterial;
  base: Partial<LessonGeneration>;
  missingFields: OutputField[];
  senseMatched: boolean;
} {
  const senses = parseSenses(row.senses);
  const senseMatched = ankiMeaningMatchesSenses(record.meaning_zh, senses, targetSense);
  const sourceCandidate: Record<string, unknown> = {
    ...(record.ipa ? { ipa: record.ipa } : {}),
    ...(record.part_of_speech ? { part_of_speech: record.part_of_speech } : {}),
    // The persisted WordLoop sense is canonical. Anki's translation is used
    // only as an exact mapping check; the cache keeps the runtime spelling.
    ...(senseMatched ? { meaning_zh: targetSense } : {}),
    ...(senseMatched && record.collocations?.length ? { collocations: record.collocations } : {}),
    ...(record.derivations?.length ? { derivations: record.derivations } : {}),
    ...(senseMatched && record.example_en && record.example_zh ? { example_en: record.example_en, example_zh: record.example_zh } : {}),
    ...(senseMatched && record.note ? { note: record.note } : {}),
  };
  const accepted: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(sourceCandidate)) {
    const fieldSchema = lessonGenerationSchema.shape[field as keyof typeof lessonGenerationSchema.shape];
    const result = fieldSchema.safeParse(value);
    if (result.success) accepted[field] = result.data;
  }
  const databasePos = [...new Set(senses.map((sense) => sense.pos).filter(Boolean))].join(" / ");
  const base: Partial<LessonGeneration> = {
    ...accepted,
    ipa: typeof accepted.ipa === "string" ? accepted.ipa : row.ipa_us?.trim() || "—",
    part_of_speech: typeof accepted.part_of_speech === "string" ? accepted.part_of_speech : databasePos || "未标注词性",
    meaning_zh: typeof accepted.meaning_zh === "string" ? accepted.meaning_zh : targetSense,
  };
  const material = ankiLessonMaterialSchema.parse({
    word: record.display_word,
    ...(senseMatched ? { meaning_zh: targetSense } : {}),
    ...(typeof accepted.part_of_speech === "string" ? { part_of_speech: accepted.part_of_speech } : {}),
    ...(typeof accepted.ipa === "string" ? { ipa: accepted.ipa } : {}),
    ...(record.ipa_uk ? { ipa_uk: record.ipa_uk } : {}),
    ...(Array.isArray(accepted.collocations) ? { collocations: accepted.collocations } : {}),
    ...(Array.isArray(accepted.derivations) ? { derivations: accepted.derivations } : {}),
    ...(typeof accepted.example_en === "string" && typeof accepted.example_zh === "string"
      ? { example_en: accepted.example_en, example_zh: accepted.example_zh } : {}),
    ...(typeof accepted.note === "string" ? { note: accepted.note } : {}),
    source_fields: record.source_fields,
  });
  const missingFields: OutputField[] = outputFields.filter((field) => {
    if (field === "exercise") return true;
    if (field === "collocations" || field === "derivations") return !Array.isArray(base[field]);
    return typeof base[field] !== "string" || !base[field]?.trim();
  });
  return { material, base, missingFields, senseMatched };
}

export function buildPlan(input: {
  wordId: string;
  word: string;
  targetSense: string;
  partOfSpeech: string;
  activityType: string;
  profile: Args["lessonProfile"];
  errorFocus: string | null;
}): LessonExercisePlan {
  const pos = input.partOfSpeech.toLocaleLowerCase();
  const collocationSkill = /\b(v|verb)\b/.test(pos) ? "verb_object_collocation"
    : /\b(adj|adjective)\b/.test(pos) ? "adjective_complement_pattern"
      : /\b(n|noun)\b/.test(pos) ? "noun_preposition_collocation" : "lexical_collocation";
  const signalSkill = input.errorFocus === "spelling" ? "target_word_spelling"
    : input.errorFocus === "collocation" ? collocationSkill
      : input.errorFocus === "grammar" ? "syntactic_word_use" : "target_sense_retrieval";
  const skillSignal = {
    skill_id: signalSkill,
    state: input.errorFocus ? "needs_practice" as const : input.profile === "reinforce" ? "developing" as const : "unknown" as const,
    source: "rules" as const,
    word_id: input.wordId,
    confidence: input.errorFocus ? 1 : input.profile === "reinforce" ? 0.7 : 0.5,
    reason: input.errorFocus ? `active_${input.errorFocus}_error` : `lesson_profile_${input.profile}`,
  };
  const skillIds = input.errorFocus === "spelling" ? ["target_word_spelling"]
    : input.errorFocus === "collocation" || input.activityType === "collocation" ? [collocationSkill]
      : input.errorFocus === "grammar" ? ["syntactic_word_use"]
        : input.activityType === "derivation" ? ["morphological_family"]
          : input.activityType === "translation_cn_to_en"
            ? [...new Set(["target_sense_retrieval", collocationSkill, "syntactic_word_use",
              ...(skillSignal.state === "needs_practice" && ["target_sense_retrieval", "syntactic_word_use", collocationSkill].includes(skillSignal.skill_id) ? [skillSignal.skill_id] : [])])]
            : input.activityType === "word_recall" ? ["target_sense_retrieval", "target_word_spelling"] : ["target_sense_retrieval"];
  const skillGoal = input.errorFocus ? `修复 ${input.errorFocus} 错误`
    : input.activityType === "translation_cn_to_en" ? "从指定中文核心义主动提取目标词及其用法"
      : input.activityType === "collocation" ? "在具体语境中提取自然搭配"
        : input.activityType === "derivation" ? "识别目标词的常用派生形式"
          : "无提示提取目标词的指定核心义";
  return lessonExercisePlanSchema.parse({
    plan_version: 1,
    plan_id: crypto.randomUUID(),
    exercise_id: crypto.randomUUID(),
    scope: "lesson",
    word_id: input.wordId,
    target_word_ids: [input.wordId],
    target_sense: input.targetSense,
    planned_activity_type: input.activityType,
    skill_goal: skillGoal,
    error_focus: input.errorFocus,
    skill_ids: skillIds,
    skill_signals: [skillSignal],
    hint_level: input.activityType === "translation_cn_to_en" ? "meaning" : input.activityType === "collocation" ? "context" : "none",
    estimated_seconds: 20,
    selection_reason: "Private Anki cache seed plan; runtime Exercise Planner remains authoritative.",
  });
}

function fieldJsonSchema(field: OutputField, activityType: string): Record<string, unknown> {
  if (field === "ipa" || field === "part_of_speech" || field === "meaning_zh" || field === "example_en" || field === "example_zh" || field === "note") {
    return { type: "string", minLength: 1 };
  }
  if (field === "collocations" || field === "derivations") {
    return { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } };
  }
  const required = ["activity_type", "instruction", "prompt", "multiline"];
  const fixedAnswer = ["cloze", "exact_cloze", "derivation", "recall", "word_recall", "collocation"].includes(activityType);
  const properties: Record<string, unknown> = {
    activity_type: { type: "string", enum: [activityType] },
    instruction: { type: "string", minLength: 1 },
    prompt: { type: "string", minLength: 1 },
    multiline: { type: "boolean", const: false },
  };
  if (fixedAnswer) {
    properties.accepted_answers = { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 } };
    required.push("accepted_answers");
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

export function outputJsonSchema(fields: OutputField[], activityType: string): string {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(fields.map((field) => [field, fieldJsonSchema(field, activityType)])),
    required: fields,
  });
}

function codeBuddySafeEnv(): NodeJS.ProcessEnv {
  const allow = process.platform === "win32"
    ? ["PATH", "PATHEXT", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "ComSpec", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]
    : ["PATH", "HOME", "TMPDIR", "LANG"];
  return Object.fromEntries(allow.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])) as NodeJS.ProcessEnv;
}

export function parseCliResult(stdout: string): {
  payload: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  codebuddyCredits?: number;
  modelCostUsd?: number;
} {
  let decoded: unknown;
  try { decoded = JSON.parse(stdout.trim()) as unknown; }
  catch { throw new Error("CODEBUDDY_INVALID_JSON"); }
  const events = Array.isArray(decoded) ? decoded as Record<string, unknown>[] : [];
  const outer = events.length
    ? [...events].reverse().find((entry) => entry.type === "result")
    : decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : undefined;
  if (!outer) throw new Error("CODEBUDDY_INVALID_JSON");
  const structuredCall = [...events].reverse().find((entry) => entry.type === "function_call" && entry.name === "StructuredOutput");
  const structuredResult = [...events].reverse().find((entry) => entry.type === "function_call_result"
    && entry.name === "StructuredOutput" && entry.status === "completed");
  if (events.length && (!structuredCall || !structuredResult)) throw new Error("CODEBUDDY_INVALID_JSON");
  const usage = outer.usage && typeof outer.usage === "object" ? outer.usage as Record<string, unknown> : {};
  const stats = outer.stats && typeof outer.stats === "object" ? outer.stats as Record<string, unknown> : {};
  const usageValue = Object.keys(usage).length ? usage : stats;
  let candidate: unknown = structuredCall?.arguments ?? outer.result ?? outer.output ?? outer.content;
  if (Array.isArray(candidate)) {
    candidate = candidate.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).text ?? "" : "").join("");
  }
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate.trim()); }
    catch { throw new Error("CODEBUDDY_INVALID_JSON"); }
  }
  // CodeBuddy's StructuredOutput tool wraps the schema object in `data`.
  if (structuredCall && candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && "data" in candidate && (candidate as Record<string, unknown>).data
    && typeof (candidate as Record<string, unknown>).data === "object") {
    candidate = (candidate as Record<string, unknown>).data;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("CODEBUDDY_INVALID_JSON");
  const inputTokens = Number(usageValue.input_tokens ?? usageValue.inputTokens ?? usageValue.prompt_tokens);
  const outputTokens = Number(usageValue.output_tokens ?? usageValue.outputTokens ?? usageValue.completion_tokens);
  const credits = Number(outer.codebuddy_credits ?? outer.credits ?? usageValue.codebuddy_credits ?? usageValue.credits);
  const modelCostUsd = Number(outer.total_cost_usd ?? usageValue.total_cost_usd);
  return {
    payload: candidate as Record<string, unknown>,
    ...(Number.isInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
    ...(Number.isInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
    ...(Number.isFinite(credits) && credits >= 0 ? { codebuddyCredits: credits } : {}),
    ...(Number.isFinite(modelCostUsd) && modelCostUsd >= 0 ? { modelCostUsd } : {}),
  };
}

export function classifyCodeBuddyFailure(stderr:string,stdout:string,stdoutBytes:number,stderrBytes:number):string{
  if(stdoutBytes>2_000_000)return 'CODEBUDDY_OUTPUT_LIMIT';
  if(stderrBytes>64_000)return 'CODEBUDDY_STDERR_LIMIT';
  let messages=stderr;
  try{
    const parsed:unknown=JSON.parse(stdout);
    const events=Array.isArray(parsed)?parsed:[parsed];
    for(const event of events){if(!event||typeof event!=='object')continue;
      const e=event as Record<string,unknown>;
      if(e.type==='error'||e.is_error===true||String(e.subtype??'').startsWith('error')){
        if(/max.?turn/i.test(String(e.subtype??'')))return 'CODEBUDDY_TURN_LIMIT';
        messages+=' '+JSON.stringify({error:e.error,message:e.message,errors:e.errors});
      }
    }
  }catch{messages+=' '+stdout.split('\n').filter(line=>/^\s*(error|错误|失败)[:：]/i.test(line)).join(' ');}
  return /too long|输入行太长|命令行太长|ENAMETOOLONG/i.test(messages)?'CODEBUDDY_COMMAND_TOO_LONG'
    :/quota|insufficient|usage limit|payment required|\b402\b|积分不足|额度不足|余额不足/i.test(messages)?'CODEBUDDY_QUOTA'
    :/rate.?limit|too many requests|\b429\b|concurren.*limit|并发.*(?:限制|上限)|频率限制|请求过于频繁/i.test(messages)?'CODEBUDDY_RATE_LIMIT'
    :/unauthorized|authentication required|permission denied|access denied|\b403\b|please.*login|请.*登录/i.test(messages)?'CODEBUDDY_AUTH'
    :/fetch failed|ECONN|network|TLS|socket|timed out/i.test(messages)?'CODEBUDDY_NETWORK':'CODEBUDDY_EXIT';
}

export function runCodeBuddy(input: {
  command: string;
  model: string;
  prompt: string;
  jsonSchema: string;
  timeoutMs: number;
  workingDirectory?: string;
}): Promise<{
  result: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  codebuddyCredits?: number;
  modelCostUsd?: number;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = crossSpawn(input.command, [
      "--print", "--output-format", "json", "--model", input.model, "--effort", "low",
      "--no-session-persistence", "--tools", "StructuredOutput", "--json-schema", input.jsonSchema,
      "--allowedTools", "StructuredOutput",
    ], {
      cwd: input.workingDirectory ?? process.env.LOCALAPPDATA ?? process.cwd(),
      env: codeBuddySafeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let terminating=false;
    const terminateTree=():Promise<void>=>{
      if(terminating)return Promise.resolve();terminating=true;
      if(process.platform!=='win32'||!child.pid){child.kill();return Promise.resolve();}
      return new Promise(done=>{
        const killer=crossSpawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,env:codeBuddySafeEnv()});
        killer.once('error',()=>{child.kill();done();});killer.once('close',()=>done());
      });
    };
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        void terminateTree().finally(()=>rejectPromise(new Error("CODEBUDDY_TIMEOUT")));
      }
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 2_000_000) void terminateTree();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if(stderrBytes<=64_000)errorChunks.push(chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (!settled) { settled = true; rejectPromise(new Error(error.code === "ENOENT" ? "CODEBUDDY_NOT_FOUND" : error.code === "ENAMETOOLONG" || error.code === "E2BIG" ? "CODEBUDDY_COMMAND_TOO_LONG" : "CODEBUDDY_SPAWN_FAILED")); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (stdoutBytes > 2_000_000 || stderrBytes > 64_000 || code !== 0) {
        const reason=classifyCodeBuddyFailure(Buffer.concat(errorChunks).toString('utf8'),Buffer.concat(chunks).toString('utf8'),stdoutBytes,stderrBytes);
        rejectPromise(new Error(reason));
        return;
      }
      try {
        const parsed = parseCliResult(Buffer.concat(chunks).toString("utf8"));
        resolvePromise({
          result: parsed.payload,
          ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
          ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
          ...(parsed.codebuddyCredits !== undefined ? { codebuddyCredits: parsed.codebuddyCredits } : {}),
          ...(parsed.modelCostUsd !== undefined ? { modelCostUsd: parsed.modelCostUsd } : {}),
        });
      } catch {
        rejectPromise(new Error("CODEBUDDY_INVALID_JSON"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.prompt, "utf8");
  });
}

export function buildPrompt(input: {
  record: ExtractedAnkiRecord;
  material: AnkiLessonMaterial;
  base: Partial<LessonGeneration>;
  missingFields: OutputField[];
  plan: LessonExercisePlan;
  profile: Args["lessonProfile"];
  errorFocus: string | null;
  repairIssues?: string[];
  jsonSchema: string;
}): string {
  const trustedExisting: Record<string, unknown> = {};
  for (const field of outputFields) {
    if (field === "exercise" || input.missingFields.includes(field)) continue;
    if (input.base[field] !== undefined) trustedExisting[field] = input.base[field];
  }
  return [
    LESSON_GENERATION_PROMPT,
    "你正在为 WordLoop 的私有 Anki Lesson 缓存补齐缺失字段。只生成 required_missing_fields 中列出的字段；不得生成、修改或复述 existing_valid_fields 中的字段。",
    "最终只返回 JSON 对象，不要 Markdown、解释、前言或代码围栏。例句必须为自然原创双语句，不声称来自真题。不得编造 IPA、词性或派生词；没有可靠内容时返回空数组或占位符。",
    "遵守当前 LessonGeneration 练习校验：exercise.activity_type 必须与计划完全一致；word_recall 题目隐藏目标英文词，accepted_answers 只能有目标词的规范拼写，不得加入冠词、词形变化、同义词或其他答案；translation_cn_to_en 不返回 accepted_answers；普通题 multiline=false。",
    "现有 LessonGeneration 渲染结构：ipa, part_of_speech, meaning_zh, collocations, derivations, example_en, example_zh, note, exercise。final combined object is validated locally against the current TypeScript/Zod schema and frozen plan.",
    `本次只返回这些缺失字段的 JSON Schema 子集：${input.jsonSchema}`,
    "已验证的 Anki 内容优先保留，不能覆盖或改写。下列字段只供辨认目标义项；不要在输出中复制它们，除非字段列在 required_missing_fields。",
    JSON.stringify({
      word: input.record.display_word,
      target_sense: input.plan.target_sense,
      existing_valid_fields: trustedExisting,
      anki_source_fields: input.material.source_fields,
      required_missing_fields: input.missingFields,
      lesson_profile: input.profile,
      planned_activity_type: input.plan.planned_activity_type,
      error_focus: input.errorFocus,
      skill_goal: input.plan.skill_goal,
      plan: {
        target_sense: input.plan.target_sense,
        planned_activity_type: input.plan.planned_activity_type,
        skill_ids: input.plan.skill_ids,
        hint_level: input.plan.hint_level,
      },
      ...(input.repairIssues?.length ? { validation_feedback: input.repairIssues } : {}),
    }),
  ].join("\n\n");
}

function buildPartialLesson(base: Partial<LessonGeneration>, generatedFields: Record<string, unknown>): unknown {
  return { ...base, ...generatedFields };
}

export function assertOfflineLessonQuality(lesson: LessonGeneration, word: string, activityType: string): void {
  assertLessonTextQuality(lesson);
  if (lesson.exercise.activity_type !== activityType) throw new Error("LESSON_ACTIVITY_TYPE_MISMATCH");
  if (activityType !== "word_recall") return;
  const expected = word.normalize("NFKC").trim().toLocaleLowerCase();
  const answers = lesson.exercise.accepted_answers ?? [];
  if (answers.length !== 1 || answers[0]!.normalize("NFKC").trim().toLocaleLowerCase() !== expected) {
    throw new Error("WORD_RECALL_ACCEPTED_ANSWER_NOT_CANONICAL");
  }
}

export async function readJsonl(path: string): Promise<ExtractedAnkiRecord[]> {
  const records: ExtractedAnkiRecord[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as ExtractedAnkiRecord;
    if (!parsed.normalized_word || !parsed.display_word) continue;
    records.push(parsed);
  }
  return records;
}

export function safeReportPath(path: string | undefined, privateDir: string): string | null {
  if (!path) return null;
  const fullPath = resolve(privateDir, path);
  if (!isOutsideCheckout(CHECKOUT_ROOT, fullPath)) throw new Error("REPORT_MUST_STAY_OUTSIDE_CHECKOUT");
  return fullPath;
}

async function readWordList(path: string | undefined, privateDir: string): Promise<string[] | null> {
  if (!path) return null;
  const fullPath = resolve(privateDir, path);
  if (!isOutsideCheckout(CHECKOUT_ROOT, fullPath)) throw new Error("WORD_LIST_MUST_STAY_OUTSIDE_CHECKOUT");
  const values = (await readFile(fullPath, "utf8")).split(/\r?\n/u)
    .map((line) => line.trim().normalize("NFKC").toLocaleLowerCase())
    .filter((line) => line && !line.startsWith("#"));
  if (new Set(values).size !== values.length) throw new Error("WORD_LIST_HAS_DUPLICATES");
  return values;
}

function selectWordListEntries(entries: readonly LessonWorkEntry[], words: readonly string[] | null): LessonWorkEntry[] {
  if (!words) return [...entries];
  const byWord = new Map<string, LessonWorkEntry[]>();
  for (const entry of entries) {
    const key = entry.row.normalized_word.trim().normalize("NFKC").toLocaleLowerCase();
    byWord.set(key, [...(byWord.get(key) ?? []), entry]);
  }
  return words.map((word) => {
    const matches = byWord.get(word);
    if (!matches?.length) throw new Error("WORD_LIST_WORD_NOT_IN_PRIVATE_UNION");
    if (matches.length !== 1) throw new Error("WORD_LIST_WORD_AMBIGUOUS_IN_PRIVATE_UNION");
    return matches[0]!;
  });
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return lessonCacheHash(bytes.toString("base64"));
}

async function saveCheckpoint(path: string, checkpoint: Checkpoint): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(checkpoint), { encoding: "utf8" });
  await rename(temporary, path);
}

function checkpointEntry(checkpoint: Checkpoint, key: string): CheckpointEntry | undefined {
  return checkpoint.entries[key];
}

export function shouldSkipCheckpoint(entry: CheckpointEntry | undefined, retryFailed: boolean): boolean {
  if (!entry) return false;
  if (entry.status === "valid") return true;
  if (entry.material_status === "failed") return !retryFailed;
  if (entry.status === "failed") return !retryFailed;
  return entry.status === "needs_review";
}

function makeSafeErrorCode(error: unknown): CacheFailureCode {
  const code = error instanceof Error ? error.message : "";
  if (code === "CODEBUDDY_TIMEOUT") return code;
  if (code === "CODEBUDDY_INVALID_JSON") return code;
  if (code === "LESSON_SCHEMA_INVALID") return code;
  if (code === "WORD_RECALL_ACCEPTED_ANSWER_NOT_CANONICAL") return code;
  if (code === "LESSON_ACTIVITY_TYPE_MISMATCH") return code;
  if (code === "CODEBUDDY_TOKEN_OUTLIER") return code;
  return "CODEBUDDY_EXIT";
}

function classifyDataApiReadError(error: unknown): { code: string; retryable: boolean } {
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = String(details.message ?? "").toLocaleLowerCase();
  const status = Number(details.status);
  if (message.includes("jwk not found")) return { code: "JWKS_KEY_NOT_FOUND", retryable: true };
  if (status === 408 || status === 429 || status >= 500) return { code: `HTTP_${status}`, retryable: true };
  if (/fetch failed|econnreset|network|connection|timeout|temporarily unavailable/u.test(message)) {
    return { code: "NETWORK", retryable: true };
  }
  if (message.includes("zoderror") || String(details.name ?? "").toLocaleLowerCase().includes("schema")) {
    return { code: "RESPONSE_SCHEMA", retryable: true };
  }
  const code = String(details.code ?? "").trim();
  if (/^(?:PGRST\d{3}|\d{5})$/u.test(code)) return { code, retryable: false };
  if (/unauthori[sz]ed|forbidden|jwt|signature|issuer|audience/u.test(message)) return { code: "AUTH", retryable: false };
  if (/permission|rls/u.test(message)) return { code: "PERMISSION", retryable: false };
  if (/does not exist|not found/u.test(message)) return { code: "NOT_FOUND", retryable: false };
  return { code: "DATA_API_ERROR", retryable: false };
}

async function readDataApiWithRetry<T>(
  operation: () => PromiseLike<{ data: T | null; error: unknown | null }>,
  failurePrefix: string,
): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await operation();
    if (!result.error) return result.data;
    lastError = result.error;
    const failure = classifyDataApiReadError(lastError);
    if (!failure.retryable || attempt === 2) throw new Error(`${failurePrefix}_${failure.code}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(750 * 2 ** attempt, 3000)));
  }
  throw new Error(`${failurePrefix}_${classifyDataApiReadError(lastError).code}`);
}

async function findCachedLessonWithRetry(
  db: ReturnType<typeof getDatabase>,
  context: PrivateLessonCacheContext,
  onRetry: () => void,
): Promise<Awaited<ReturnType<typeof findCachedLesson>>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await findCachedLesson(db, context);
    } catch (error) {
      if (!(error instanceof PrivateLessonCacheReadError) || !error.retryable || attempt === 2) throw error;
      onRetry();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(500 * 2 ** attempt, 2000)));
    }
  }
  throw new Error("PRIVATE_LESSON_CACHE_READ_FAILED");
}

export async function loadWordsAndMembership(
  db: ReturnType<typeof getDatabase>,
  userId: string,
): Promise<{ wordRows: WordRow[]; hasFullUnion: boolean }> {
  const identity = await readDataApiWithRetry(() => db.rpc("wordloop_authenticated_user_id"), "PRIVATE_IDENTITY_READ_FAILED");
  if (identity !== userId) throw new Error("PRIVATE_IDENTITY_MISMATCH");
  let hasFullUnion = false;
  for (let attempt = 0; attempt < 3 && !hasFullUnion; attempt += 1) {
    const books = await Promise.all(["ougkp", "athgc"].map((book) =>
      readDataApiWithRetry(() => db.from("word_sources").select("source_book_id").eq("user_id", userId)
        .eq("source_book_id", book).limit(1), "PRIVATE_UNION_MEMBERSHIP_READ_FAILED")));
    hasFullUnion = books.every((rows) => Array.isArray(rows) && rows.length > 0);
    if (!hasFullUnion && attempt < 2) await new Promise((done) => setTimeout(done, 750 * 2 ** attempt));
  }
  if (!hasFullUnion) return { wordRows: [], hasFullUnion };
  const joinedWords = new Map<string, WordRow>();
  for(let scan=0;scan<3;scan++){
  joinedWords.clear();
  for (let offset = 0; ; offset += 500) {
    const data = await readDataApiWithRetry(() => db.from("word_sources").select("word_id,source_book_id,words(id,normalized_word,display_word,senses,ipa_us,ipa_uk)")
      .eq("user_id", userId).in("source_book_id", ["ougkp", "athgc"])
      .order("word_id", { ascending: true }).order("source_book_id", { ascending: true })
      .range(offset, offset + 499), "PRIVATE_UNION_WORDS_READ_FAILED");
    for (const source of data ?? []) {
      const joined = source.words as unknown as WordRow | WordRow[] | null;
      const word = Array.isArray(joined) ? joined[0] : joined;
      if (!word || word.id !== source.word_id) throw new Error("PRIVATE_UNION_WORD_JOIN_MISSING");
      joinedWords.set(word.id, word);
    }
    if ((data ?? []).length < 500) break;
  }
    if(joinedWords.size===7048)break;
    if(scan<2)await new Promise(done=>setTimeout(done,750*2**scan));
  }
  if(joinedWords.size!==7048)throw new Error('PRIVATE_UNION_WORDS_INCOMPLETE');
  return { wordRows: [...joinedWords.values()], hasFullUnion };
}

async function ensureExtracted(args: Args, privateDir: string): Promise<{ jsonlPath: string; manifestPath: string }> {
  if (args.materialsJsonl) {
    const jsonl = resolve(args.materialsJsonl);
    const manifest = resolve(args.manifest ?? args.materialsJsonl.replace(/\.jsonl$/i, ".manifest.json"));
    if (!existsSync(jsonl) || !existsSync(manifest)) throw new Error("EXTRACTED_APKG_INPUT_MISSING");
    return { jsonlPath: jsonl, manifestPath: manifest };
  }
  if (!args.apkg) throw new Error("APKG_OR_MATERIALS_JSONL_REQUIRED");
  const apkg = resolve(args.apkg);
  if (!existsSync(apkg)) throw new Error("APKG_INPUT_MISSING");
  const script = resolve(CHECKOUT_ROOT, "scripts/extract-anki-lesson-materials.py");
  const pythonCommand = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(pythonCommand, [script, "--apkg", apkg, "--private-data-dir", privateDir, "--source-version", SOURCE_VERSION], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64_000,
  });
  if (result.error || result.status !== 0) throw new Error("APKG_EXTRACTION_FAILED");
  const jsonlPath = resolve(privateDir, "anki-lesson-materials.jsonl");
  const manifestPath = resolve(privateDir, "anki-lesson-materials.manifest.json");
  return { jsonlPath, manifestPath };
}

export function getCodeBuddyVersion(command: string): string {
  const result = crossSpawn.sync(command, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    env: codeBuddySafeEnv(),
    maxBuffer: 2000,
  });
  if (result.error || result.status !== 0) throw new Error("CODEBUDDY_CLI_UNAVAILABLE");
  return result.stdout.trim().slice(0, 80);
}

async function writeReport(path: string | null, report: Record<string, unknown>): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const privateDir = privateDataRoot(args.privateDataDir);
  const reportPath = safeReportPath(args.report, privateDir);
  const sampleWordList = await readWordList(args.wordList, privateDir);
  const extracted = await ensureExtracted(args, privateDir);
  const manifest = JSON.parse(await readFile(extracted.manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.source_version !== SOURCE_VERSION) throw new Error("ANKI_SOURCE_VERSION_MISMATCH");
  const sourceSha = typeof manifest.apkg_sha256 === "string" ? manifest.apkg_sha256 : await sha256File(extracted.jsonlPath);
  const records = await readJsonl(extracted.jsonlPath);
  if (args.dryRun) {
    requireStagingEnvironment();
    const lookup = await withUserIdentity(args.userId, async () => loadWordsAndMembership(getDatabase(), args.userId));
    if (!lookup.hasFullUnion) throw new Error("PRIVATE_KAOYAN_UNION_NOT_AVAILABLE");
    const built = buildPrivateUnionWork(records, lookup.wordRows);
    const eligible = selectWordListEntries(built.entries, sampleWordList);
    const selected = args.limit ? eligible.slice(0, args.limit) : eligible;
    console.log(JSON.stringify({
      mode: "dry-run", source_version: SOURCE_VERSION, source_sha256: sourceSha,
      private_union_words: lookup.wordRows.length, anki_matched_words: built.matchedWords,
      missing_anki_words: lookup.wordRows.length - built.matchedWords,
      unmatched_anki_records: built.unmatchedAnkiRecords,
      eligible_words: eligible.length, selected_words: selected.length,
      selection: sampleWordList ? "private-word-list" : "normalized-word-order",
      database_writes: 0, codebuddy_calls: 0,
    }));
    return;
  }
  requireStagingEnvironment();
  const codebuddyVersion = args.importOnly ? "not-used" : getCodeBuddyVersion(args.codebuddyCommand);
  const checkpointPath = resolve(privateDir, "anki-lesson-cache.checkpoint.json");
  const generationConfig = [LESSON_CACHE_CONTENT_VERSION, LESSON_CACHE_PROMPT_VERSION, args.codebuddyModel,
    args.lessonProfile, args.activityType, args.errorFocus ?? "none"].join("|");
  let checkpoint: Checkpoint = {
    version: CACHE_CHECKPOINT_VERSION,
    source_version: SOURCE_VERSION,
    source_sha256: sourceSha,
    generation_config: generationConfig,
    user_id: args.userId,
    entries: {},
  };
  if (args.resume && existsSync(checkpointPath)) {
    const saved = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
    if (saved.version !== CACHE_CHECKPOINT_VERSION || saved.source_version !== SOURCE_VERSION
      || saved.source_sha256 !== sourceSha || saved.user_id !== args.userId
      || saved.generation_config !== generationConfig) throw new Error("CHECKPOINT_SOURCE_OR_USER_MISMATCH");
    checkpoint = saved;
  }

  const totals = {
    source_records: records.length,
    private_union_words: 0,
    anki_matched_words: 0,
    missing_anki_words: 0,
    unmatched_anki_records: 0,
    eligible_words: 0,
    processed_words: 0,
    materials_upsert_attempted: 0,
    materials_saved: 0,
    materials_skipped_idempotent: 0,
    generated_valid: 0,
    needs_review: 0,
    failed: 0,
    skipped_checkpoint: 0,
    skipped_existing_cache: 0,
    private_cache_read_retries: 0,
    batch_stopped_for_token_outlier: false,
    codebuddy_calls: 0,
    codebuddy_retries: 0,
    all_calls_have_token_usage: true,
    input_tokens: 0,
    output_tokens: 0,
    token_usage_status: "unavailable" as "available" | "unavailable",
    all_calls_have_credit_usage: true,
    codebuddy_credits_total: 0,
    all_calls_have_model_cost: true,
    model_cost_usd_total: 0,
    retry_codes: {} as Record<string, number>,
  };

  await withUserIdentity(args.userId, async () => {
    const db = getDatabase();
    const lookup = await loadWordsAndMembership(db, args.userId);
    if (!lookup.hasFullUnion) throw new Error("PRIVATE_KAOYAN_UNION_NOT_AVAILABLE");
    const built = buildPrivateUnionWork(records, lookup.wordRows);
    totals.private_union_words = lookup.wordRows.length;
    totals.anki_matched_words = built.matchedWords;
    totals.missing_anki_words = lookup.wordRows.length - built.matchedWords;
    totals.unmatched_anki_records = built.unmatchedAnkiRecords;
    const eligibleWork = selectWordListEntries(built.entries, sampleWordList);
    totals.eligible_words = eligibleWork.length;
    const work = args.limit ? eligibleWork.slice(0, args.limit) : eligibleWork;
    totals.processed_words = work.length;
    if (!work.length) throw new Error("PRIVATE_KAOYAN_UNION_HAS_NO_WORDS");

    const materialEntries: AnkiMaterialsCacheInput[] = work.flatMap((entry) => !entry.ankiPresent || entry.targetSense === "—" ? [] : [{
      wordId: entry.row.id,
      targetSense: entry.targetSense,
      material: entry.material,
      missingFields: entry.missingFields,
      qualityStatus: entry.senseMatched || Boolean(entry.material.ipa || entry.material.part_of_speech || entry.material.derivations?.length)
        ? "partial" as const : "needs_review" as const,
      ...(!entry.senseMatched ? { errorCode: "ANKI_SENSE_MAPPING_NEEDS_REVIEW", errorSummary: "Sense-specific Anki fields were withheld because its meaning did not exactly match the saved WordLoop senses." } : {}),
    }]);
    for (let offset = 0; offset < materialEntries.length; offset += 50) {
      const chunk = materialEntries.slice(offset, offset + 50);
      totals.materials_upsert_attempted += chunk.length;
      try {
        const inserted = await saveAnkiMaterialsCacheBatch({ db, userId: args.userId, entries: chunk });
        totals.materials_saved += inserted;
        totals.materials_skipped_idempotent += chunk.length - inserted;
        for (const entry of chunk) {
          const target = work.find((item) => item.row.id === entry.wordId);
          if (target) {
            const existing = checkpoint.entries[target.record.normalized_word];
            checkpoint.entries[target.record.normalized_word] = {
              ...(existing ?? {} as CheckpointEntry),
              status: existing?.status ?? "materials_saved",
              material_status: "saved",
              material_error_code: undefined,
              word_id: entry.wordId,
              source_note_id: target.record.source_note_id,
              retry_count: existing?.retry_count ?? 0,
              updated_at: new Date().toISOString(),
            };
          }
        }
      } catch {
        // Split a failed transaction until one malformed or unauthorized item
        // is isolated; one card cannot abort the remainder of the APKG import.
        for (const entry of chunk) {
          try {
            const inserted = await saveAnkiMaterialsCacheBatch({ db, userId: args.userId, entries: [entry] });
            totals.materials_saved += inserted;
            totals.materials_skipped_idempotent += 1 - inserted;
            const target = work.find((item) => item.row.id === entry.wordId);
            if (target) {
              const existing = checkpoint.entries[target.record.normalized_word];
              checkpoint.entries[target.record.normalized_word] = {
                ...(existing ?? {} as CheckpointEntry),
                status: existing?.status ?? "materials_saved",
                material_status: "saved",
                material_error_code: undefined,
                word_id: entry.wordId,
                source_note_id: target.record.source_note_id,
                retry_count: existing?.retry_count ?? 0,
                updated_at: new Date().toISOString(),
              };
            }
          } catch {
            totals.failed += 1;
            totals.retry_codes["MATERIAL_IMPORT_FAILED"] = (totals.retry_codes["MATERIAL_IMPORT_FAILED"] ?? 0) + 1;
            const target = work.find((item) => item.row.id === entry.wordId);
            if (target) {
              const existing = checkpoint.entries[target.record.normalized_word];
              checkpoint.entries[target.record.normalized_word] = {
                ...(existing ?? {} as CheckpointEntry),
                status: "failed",
                material_status: "failed",
                material_error_code: "MATERIAL_IMPORT_FAILED",
                word_id: entry.wordId,
                source_note_id: target.record.source_note_id,
                retry_count: (existing?.retry_count ?? 0) + 1,
                updated_at: new Date().toISOString(),
              };
            }
          }
        }
      }
    }

    await saveCheckpoint(checkpointPath, checkpoint);
    if (args.importOnly) return;

    for (const entry of work) {
      const normalized = entry.record.normalized_word;
      const previous = checkpointEntry(checkpoint, normalized);
      if (args.resume && shouldSkipCheckpoint(previous, args.retryFailed)) {
        totals.skipped_checkpoint += 1;
        continue;
      }
      if (entry.targetSense === "—") {
        totals.needs_review += 1;
        checkpoint.entries[normalized] = {
          status: "needs_review", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
          retry_count: previous?.retry_count ?? 0, error_code: "WORDLOOP_SENSE_MISSING", updated_at: new Date().toISOString(),
        };
        await saveCheckpoint(checkpointPath, checkpoint);
        continue;
      }
      const senses = parseSenses(entry.row.senses);
      const sensePos = formatPartOfSpeech(senses) ?? "未标注词性";
      const plannerPos = senses.find((sense) => sense.pos.trim())?.pos ?? "";
      const plan = buildPlan({
        wordId: entry.row.id,
        word: entry.row.normalized_word,
        targetSense: entry.targetSense,
        partOfSpeech: plannerPos,
        activityType: args.activityType,
        profile: args.lessonProfile,
        errorFocus: args.errorFocus,
      });
      const context: PrivateLessonCacheContext = {
        userId: args.userId,
        wordId: entry.row.id,
        word: entry.record.display_word,
        meaningZh: entry.meaningZh,
        partOfSpeech: entry.material.part_of_speech ?? sensePos,
        ...((entry.material.ipa ?? entry.row.ipa_us) ? { ipa: entry.material.ipa ?? entry.row.ipa_us! } : {}),
        lessonProfile: args.lessonProfile,
        errorFocus: args.errorFocus as PrivateLessonCacheContext["errorFocus"],
        plan,
      };
      const usedAnki = hasReusableAnkiMaterial(entry);
      const sourceVersion = usedAnki ? SOURCE_VERSION : PRIVATE_UNION_SOURCE_VERSION;
      const materialPayloadHash = usedAnki ? await lessonCacheHash(entry.material) : null;
      const inputFingerprint = (await lessonGenerationCacheKey(context, materialPayloadHash, sourceVersion)).cacheKey;
      let existingCache;
      try {
        existingCache = await findCachedLessonWithRetry(db, context, () => { totals.private_cache_read_retries += 1; });
      } catch {
        checkpoint.entries[normalized] = {
          status: "failed", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
          retry_count: previous?.retry_count ?? 0, error_code: "PRIVATE_CACHE_READ_FAILED", updated_at: new Date().toISOString(),
        };
        totals.failed += 1;
        totals.retry_codes["PRIVATE_CACHE_READ_FAILED"] = (totals.retry_codes["PRIVATE_CACHE_READ_FAILED"] ?? 0) + 1;
        await saveCheckpoint(checkpointPath, checkpoint);
        continue;
      }
      if (!existingCache.privateSetId) {
        checkpoint.entries[normalized] = {
          status: "failed", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
          retry_count: previous?.retry_count ?? 0, error_code: "PRIVATE_SET_ACCESS_DENIED", updated_at: new Date().toISOString(),
        };
        totals.failed += 1;
        totals.retry_codes["PRIVATE_SET_ACCESS_DENIED"] = (totals.retry_codes["PRIVATE_SET_ACCESS_DENIED"] ?? 0) + 1;
        await saveCheckpoint(checkpointPath, checkpoint);
        continue;
      }
      if (existingCache.lesson) {
        checkpoint.entries[normalized] = {
          status: "valid", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
          ...(previous?.material_status ? { material_status: previous.material_status } : {}),
          retry_count: previous?.retry_count ?? 0, input_fingerprint: inputFingerprint,
          lesson: existingCache.lesson, updated_at: new Date().toISOString(),
        };
        totals.skipped_existing_cache += 1;
        await saveCheckpoint(checkpointPath, checkpoint);
        continue;
      }
      const fixed = { ...entry.base };
      const materialMeaningMatches = Boolean(entry.material.meaning_zh
        && normalizeSense(entry.material.meaning_zh) === normalizeSense(entry.targetSense));
      if (typeof entry.material.ipa === "string") fixed.ipa = entry.material.ipa;
      else if (entry.row.ipa_us) fixed.ipa = entry.row.ipa_us;
      else if (!fixed.ipa) fixed.ipa = "—";
      if (typeof entry.material.part_of_speech === "string") fixed.part_of_speech = entry.material.part_of_speech;
      else if (sensePos) fixed.part_of_speech = sensePos;
      else if (!fixed.part_of_speech) fixed.part_of_speech = "未标注词性";
      if (!materialMeaningMatches) fixed.meaning_zh = entry.targetSense;
      const missingFields = outputFields.filter((field) => {
        if (field === "exercise") return true;
        if (field === "collocations" || field === "derivations") return !Array.isArray(fixed[field]);
        return typeof fixed[field] !== "string" || !fixed[field]?.trim();
      });

      let success: LessonGeneration | null = null;
      let attempts = previous?.retry_count ?? 0;
      let lastError: unknown = null;
      let lastTokens: { inputTokens?: number; outputTokens?: number } = {};
      const requestId = crypto.randomUUID();
      if (args.resume && previous?.lesson && previous.input_fingerprint === inputFingerprint) {
        lastTokens = {
          ...(previous.input_tokens !== undefined ? { inputTokens: previous.input_tokens } : {}),
          ...(previous.output_tokens !== undefined ? { outputTokens: previous.output_tokens } : {}),
        };
        const pending = safeParseLessonGenerationForPlan({
          word: context.word,
          lesson_profile: context.lessonProfile,
          error_focus: context.errorFocus,
          plan,
        }, previous.lesson);
        if (pending.success) {
          try {
            assertOfflineLessonQuality(pending.data, context.word, args.activityType);
            success = pending.data;
          } catch { /* Regenerate records that fail the stricter offline-cache quality gate. */ }
        }
      }
      for (let attempt = 0; !success && attempt <= args.maxRetries; attempt += 1) {
        attempts += 1;
        let responseReceived = false;
        try {
          totals.codebuddy_calls += 1;
          const response = await runCodeBuddy({
            command: args.codebuddyCommand,
            model: args.codebuddyModel,
            prompt: buildPrompt({
              record: entry.record,
              material: entry.material,
              base: fixed,
              missingFields,
              plan,
              profile: args.lessonProfile,
              errorFocus: args.errorFocus,
              jsonSchema: outputJsonSchema(missingFields, args.activityType),
              ...(lastError instanceof Error && lastError.message === "LESSON_SCHEMA_INVALID" ? { repairIssues: ["上次结果未通过 LessonGeneration 及冻结计划校验。请只修复缺失字段，并再次只输出 Schema JSON。"] } : {}),
              ...(lastError instanceof Error && lastError.message === "WORD_RECALL_ACCEPTED_ANSWER_NOT_CANONICAL" ? { repairIssues: ["word_recall 的 accepted_answers 必须仅包含当前目标词的规范拼写；删除冠词、词形变化、同义词和其他答案。"] } : {}),
            }),
            jsonSchema: outputJsonSchema(missingFields, args.activityType),
            timeoutMs: args.timeoutMs,
          });
          responseReceived = true;
          lastTokens = { inputTokens: response.inputTokens, outputTokens: response.outputTokens };
          if (response.inputTokens !== undefined && response.outputTokens !== undefined) {
            totals.input_tokens += response.inputTokens;
            totals.output_tokens += response.outputTokens;
          } else totals.all_calls_have_token_usage = false;
          if (response.codebuddyCredits !== undefined) totals.codebuddy_credits_total += response.codebuddyCredits;
          else totals.all_calls_have_credit_usage = false;
          if (response.modelCostUsd !== undefined) totals.model_cost_usd_total += response.modelCostUsd;
          else totals.all_calls_have_model_cost = false;
          if ((response.inputTokens !== undefined && response.inputTokens > MAX_INPUT_TOKENS_PER_CALL)
            || (response.outputTokens !== undefined && response.outputTokens > MAX_OUTPUT_TOKENS_PER_CALL)) {
            throw new Error("CODEBUDDY_TOKEN_OUTLIER");
          }
          const candidate = buildPartialLesson(fixed, response.result);
          const parsed = safeParseLessonGenerationForPlan({
            word: context.word,
            lesson_profile: context.lessonProfile,
            error_focus: context.errorFocus,
            plan,
          }, candidate);
          if (!parsed.success) throw new Error("LESSON_SCHEMA_INVALID");
          assertOfflineLessonQuality(parsed.data, context.word, args.activityType);
          success = parsed.data;
          break;
        } catch (error) {
          if (!responseReceived) {
            totals.all_calls_have_token_usage = false;
            totals.all_calls_have_credit_usage = false;
            totals.all_calls_have_model_cost = false;
          }
          lastError = error;
          if (error instanceof Error && error.message === "CODEBUDDY_TOKEN_OUTLIER") break;
          if (attempt < args.maxRetries) {
            totals.codebuddy_retries += 1;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(1000 * 2 ** attempt, 8000)));
          }
        }
      }

      if (!success) {
        const code = makeSafeErrorCode(lastError);
        try {
          await savePrivateLessonCacheFailure({
            db,
            context,
            materialPayloadHash,
            missingFields,
            retryCount: attempts,
            sourceVersion,
            errorCode: code,
          });
        } catch { /* Local checkpoint remains the recovery source if staging is unavailable. */ }
        checkpoint.entries[normalized] = {
          status: "failed", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
          retry_count: attempts, error_code: code, updated_at: new Date().toISOString(),
        };
        totals.failed += 1;
        totals.retry_codes[code] = (totals.retry_codes[code] ?? 0) + 1;
        await saveCheckpoint(checkpointPath, checkpoint);
        if (code === "CODEBUDDY_TOKEN_OUTLIER") {
          totals.batch_stopped_for_token_outlier = true;
          break;
        }
        continue;
      }

      checkpoint.entries[normalized] = {
        status: "generated_pending_import", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
        input_fingerprint: inputFingerprint,
        ...(previous?.material_status ? { material_status: previous.material_status } : { material_status: "saved" }),
        ...(previous?.material_error_code ? { material_error_code: previous.material_error_code } : {}),
        retry_count: Math.max(0, attempts - 1),
        ...(lastTokens.inputTokens !== undefined ? { input_tokens: lastTokens.inputTokens } : {}),
        ...(lastTokens.outputTokens !== undefined ? { output_tokens: lastTokens.outputTokens } : {}),
        lesson: success, updated_at: new Date().toISOString(),
      };
      await saveCheckpoint(checkpointPath, checkpoint);

      try {
        await savePrivateLessonCache({
          db,
          context,
          lesson: parseLessonGenerationForPlan({ word: context.word, lesson_profile: context.lessonProfile, error_focus: context.errorFocus, plan }, success),
          sourceKind: usedAnki ? "mixed" : "codebuddy_deepseek",
          generationMethod: "codebuddy_cli",
          sourceVersion,
          modelName: args.codebuddyModel,
          modelEffort: "low",
          codebuddyRequestId: requestId,
          materialPayloadHash,
          ...(lastTokens.inputTokens !== undefined ? { inputTokens: lastTokens.inputTokens } : {}),
          ...(lastTokens.outputTokens !== undefined ? { outputTokens: lastTokens.outputTokens } : {}),
          retryCount: Math.max(0, attempts - 1),
        });
        checkpoint.entries[normalized] = {
          status: "valid", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
          input_fingerprint: inputFingerprint,
          ...(previous?.material_status ? { material_status: previous.material_status } : { material_status: "saved" }),
          ...(previous?.material_error_code ? { material_error_code: previous.material_error_code } : {}),
          retry_count: attempts - 1, lesson: success, updated_at: new Date().toISOString(),
        };
        totals.generated_valid += 1;
      } catch {
        checkpoint.entries[normalized] = {
          status: "failed", word_id: entry.row.id, source_note_id: entry.record.source_note_id,
          input_fingerprint: inputFingerprint,
          retry_count: attempts, error_code: "CACHE_WRITE_FAILED", lesson: success, updated_at: new Date().toISOString(),
        };
        totals.failed += 1;
        totals.retry_codes["CACHE_WRITE_FAILED"] = (totals.retry_codes["CACHE_WRITE_FAILED"] ?? 0) + 1;
      }
      await saveCheckpoint(checkpointPath, checkpoint);
      if (totals.codebuddy_calls > 0 && totals.codebuddy_calls % 25 === 0) {
        console.log(JSON.stringify({ progress: totals.codebuddy_calls, valid: totals.generated_valid, failed: totals.failed, retry_count: totals.codebuddy_retries }));
      }
    }
  });

  totals.token_usage_status = totals.codebuddy_calls > 0 && totals.all_calls_have_token_usage ? "available" : "unavailable";
  const codebuddyCredits = totals.codebuddy_calls > 0 && totals.all_calls_have_credit_usage
    ? totals.codebuddy_credits_total : "unavailable";
  const modelCostUsd = totals.codebuddy_calls > 0 && totals.all_calls_have_model_cost
    ? totals.model_cost_usd_total : "unavailable";
  const report = {
    source: SOURCE_ROOT,
    source_version: SOURCE_VERSION,
    source_sha256: sourceSha,
    private_set_id: "kaoyan-personal-union-v1",
    codebuddy_version: codebuddyVersion,
    model: args.importOnly ? "not-used" : args.codebuddyModel,
    effort: args.importOnly ? "not-used" : "low",
    mode: args.importOnly ? "import-only" : "import-and-complete-missing",
    content_version: LESSON_CACHE_CONTENT_VERSION,
    prompt_version: LESSON_CACHE_PROMPT_VERSION,
    selection: sampleWordList ? "private-word-list" : "normalized-word-order",
    totals,
    input_tokens: totals.token_usage_status === "available" ? totals.input_tokens : "unavailable",
    output_tokens: totals.token_usage_status === "available" ? totals.output_tokens : "unavailable",
    codebuddy_credits: codebuddyCredits,
    model_cost_usd: modelCostUsd,
    checkpoint: basename(checkpointPath),
  };
  await writeReport(reportPath, report);
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error(JSON.stringify({ status: "failed", error_code: /^[A-Z0-9:_-]+$/.test(message) ? message : "IMPORT_FAILED" }));
    process.exitCode = 1;
  });
}
