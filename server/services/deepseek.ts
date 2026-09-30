import { z } from "zod";
import { getDeepSeekApiKey } from "../db.js";
import {
  ENGLISH_DEFINITION_GRADING_PROMPT,
  FULL_CN_TO_EN_CONSOLIDATION_PROMPT,
  LESSON_GENERATION_PROMPT,
  SEMANTIC_GRADING_PROMPT,
  SENTENCE_CONSOLIDATION_GENERATION_PROMPT,
  WRAPUP_GENERATION_PROMPT,
  WRAPUP_GRADING_PROMPT,
} from "./deepseekPrompts.js";
import { canonicalizeRecallForm } from "../../web/src/grading/deterministic.js";
import { plannedActivityTypeSchema } from "../../shared/toolContracts.js";
import type { LessonErrorFocus, LessonProfile } from "./lessonProfile.js";
import type { LessonExercisePlan } from "../../shared/toolContracts.js";

const deepseekBase = "https://api.deepseek.com/chat/completions";
const fixedAnswerActivityTypes = new Set<string>(["cloze", "exact_cloze", "derivation", "recall", "word_recall", "collocation"]);
function hasChineseText(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

const exerciseSchema = z.object({
  // Keep generation output aligned with the server's planner contract. A
  // duplicated list here previously omitted `word_recall`, so valid plans
  // failed schema validation before their exact planned type could be saved.
  activity_type: plannedActivityTypeSchema,
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
  accepted_answers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).superRefine((value, context) => {
  if ((value.activity_type === "cloze" || value.activity_type === "exact_cloze") && !value.prompt.includes("___")) {
    context.addIssue({ code: "custom", message: "A cloze prompt must include a blank.", path: ["prompt"] });
  }
  if (fixedAnswerActivityTypes.has(value.activity_type) && !value.accepted_answers?.length) {
    context.addIssue({ code: "custom", message: "Fixed-answer exercises require accepted_answers.", path: ["accepted_answers"] });
  }
  if (value.activity_type === "translation_cn_to_en" && !/\p{Script=Han}/u.test(value.prompt)) {
    context.addIssue({ code: "custom", message: "A Chinese-to-English prompt must contain Chinese.", path: ["prompt"] });
  }
  if (value.activity_type === "translation_en_to_cn" && !/[A-Za-z]/.test(value.prompt)) {
    context.addIssue({ code: "custom", message: "An English-to-Chinese prompt must contain English.", path: ["prompt"] });
  }
});

function englishWords(value: string): string[] {
  return value.toLocaleLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) ?? [];
}

export const lessonGenerationSchema = z.object({
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(120),
  meaning_zh: z.string().trim().min(1).max(240).refine(hasChineseText, "Use Chinese for the core meaning."),
  collocations: z.array(z.string().trim().min(1).max(200).refine(
    (value) => /[A-Za-z]/.test(value) && hasChineseText(value),
    "Include both the English collocation and its Chinese translation.",
  )).max(8),
  derivations: z.array(z.string().trim().min(1).max(200).refine(
    (value) => /[A-Za-z]/.test(value) && hasChineseText(value),
    "Include both the English derivative and its Chinese meaning.",
  )).max(8),
  example_en: z.string().trim().min(1).max(1000),
  example_zh: z.string().trim().min(1).max(1000).refine(hasChineseText, "Add a Chinese translation for the example."),
  note: z.string().trim().min(1).max(1000),
  exercise: exerciseSchema,
});

const errorLayerSchema = z.enum(["none", "meaning", "collocation", "grammar", "spelling", "pronunciation"]);

const nullableOptionalText = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || undefined).optional();
const nullableOptionalWordId = z.string().trim().uuid().nullish().transform((value) => value || undefined).optional();

const gradeDimensionSchema = z.object({
  passed: z.boolean(),
  note: z.string().trim().max(1000).nullish().transform((value) => value ?? ""),
}).nullish().transform((value) => value ?? undefined).optional();

export const semanticGradeSchema = z.object({
  is_correct: z.boolean(),
  error_layer: errorLayerSchema,
  message: z.string().trim().min(1).max(1000).refine(hasChineseText, "Use Chinese for grading feedback."),
  explanation: z.string().trim().min(1).max(4000).refine(hasChineseText, "Use Chinese for the grading explanation."),
  reference_answer: z.string().trim().max(4000).nullish().transform((value) => value || undefined),
  task_fulfillment: z.boolean().nullish().transform((value) => value ?? undefined),
  meaning: gradeDimensionSchema,
  collocation: gradeDimensionSchema,
  grammar: gradeDimensionSchema,
  naturalness: gradeDimensionSchema,
  target_word_results: z.array(z.object({
    word_id: nullableOptionalWordId,
    target_word_id: nullableOptionalWordId,
    word: z.string().trim().min(1).max(100),
    outcome: z.enum(["correct", "incorrect", "partial", "not_assessed"]),
    meaning: nullableOptionalText(1000),
    collocation: nullableOptionalText(1000),
    grammar: nullableOptionalText(1000),
    naturalness: nullableOptionalText(1000),
    error_excerpt: nullableOptionalText(500),
    hint: nullableOptionalText(500),
    reference_expression: nullableOptionalText(1000),
  }).transform(({ target_word_id, ...result }) => ({
    ...result,
    ...(result.word_id ? {} : target_word_id ? { word_id: target_word_id } : {}),
  }))).nullish().transform((value) => value ?? undefined),
  skill_results: z.array(z.object({
    skill_id: z.string().trim().min(1).max(120),
    word_id: nullableOptionalWordId,
    target_word_id: nullableOptionalWordId,
    outcome: z.enum(["correct", "incorrect", "partial", "not_assessed"]),
    evidence: nullableOptionalText(500),
  }).transform(({ target_word_id, ...result }) => ({
    ...result,
    ...(result.word_id ? {} : target_word_id ? { word_id: target_word_id } : {}),
  }))).nullish().transform((value) => value ?? undefined),
  error_excerpt: nullableOptionalText(500),
  short_hint: nullableOptionalText(500),
}).transform((value) => ({
  ...value,
  task_fulfillment: value.task_fulfillment ?? value.is_correct,
  meaning: value.meaning ?? { passed: value.is_correct, note: value.message },
  collocation: value.collocation ?? { passed: value.is_correct, note: value.message },
  grammar: value.grammar ?? { passed: value.is_correct, note: value.message },
  naturalness: value.naturalness ?? { passed: value.is_correct, note: value.message },
  target_word_results: value.target_word_results ?? [],
  skill_results: value.skill_results ?? [],
  error_excerpt: value.error_excerpt ?? "",
  short_hint: value.short_hint ?? value.message,
}));

function semanticGradeSchemaFor(retryCount: number) {
  return semanticGradeSchema.superRefine((grade, context) => {
    if (!grade.is_correct && grade.error_layer === "none") {
      context.addIssue({ code: "custom", message: "An incorrect answer needs a core error_layer.", path: ["error_layer"] });
    }
    if (!grade.is_correct && retryCount >= 1 && !grade.reference_answer) {
      context.addIssue({ code: "custom", message: "A second incorrect answer needs a reference_answer.", path: ["reference_answer"] });
    }
  });
}

export const englishDefinitionGradeSchema = z.object({
  is_correct: z.boolean(),
  feedback: z.string().trim().min(1).max(1000).refine(hasChineseText, "Use Chinese for grading feedback."),
});

export const wrapupExerciseSchema = z.object({
  activity_type: z.literal("translation_en_to_cn"),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.literal(true),
}).superRefine((value, context) => {
  const count = englishWords(value.prompt).length;
  if (count < 25 || count > 40) {
    context.addIssue({ code: "custom", message: "The wrap-up sentence must contain 25–40 English words.", path: ["prompt"] });
  }
});

export const sentenceConsolidationExerciseSchema = z.object({
  activity_type: z.literal("sentence"),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.literal(true),
});

export const plannedConsolidationExerciseSchema = z.object({
  activity_type: z.enum(["translation_en_to_cn", "translation_cn_to_en", "sentence"]),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.literal(true),
}).superRefine((exercise, context) => {
  if (exercise.activity_type === "translation_en_to_cn") {
    const count = englishWords(exercise.prompt).length;
    if (count < 25 || count > 40) context.addIssue({ code: "custom", message: "The long sentence must contain 25–40 English words.", path: ["prompt"] });
  }
  if (exercise.activity_type === "translation_cn_to_en" && !hasChineseText(exercise.prompt)) {
    context.addIssue({ code: "custom", message: "The complete Chinese-to-English prompt needs a concrete Chinese sentence.", path: ["prompt"] });
  }
});

export const wrapupGradeSchema = semanticGradeSchema;

export type LessonGeneration = z.output<typeof lessonGenerationSchema>;
export type SemanticGrade = z.output<typeof semanticGradeSchema>;
export type EnglishDefinitionGrade = z.output<typeof englishDefinitionGradeSchema>;
export type WrapupExercise = z.output<typeof wrapupExerciseSchema>;
export type SentenceConsolidationExercise = z.output<typeof sentenceConsolidationExerciseSchema>;
export type PlannedConsolidationExercise = z.output<typeof plannedConsolidationExerciseSchema>;
export type WrapupGrade = z.output<typeof wrapupGradeSchema>;

export interface LessonExerciseValidationContext {
  word: string;
  lesson_profile: LessonProfile;
  error_focus: LessonErrorFocus;
  plan: LessonExercisePlan;
}

export interface LessonExerciseValidationIssue {
  path: (string | number)[];
  message: string;
}

function canonicalWordTokens(value: string): string[] {
  return canonicalizeRecallForm(value).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

function containsTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return haystack.some((_, start) => needle.every((token, offset) => haystack[start + offset] === token));
}

function promptContainsTarget(prompt: string, word: string): boolean {
  const targetTokens = canonicalWordTokens(word);
  return prompt.split("___").some((part) => containsTokenSequence(canonicalWordTokens(part), targetTokens));
}

function promptRepeatsExample(prompt: string, example: string, word: string): boolean {
  const normalizedPrompt = prompt.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  const normalizedExample = example.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  if (normalizedPrompt === normalizedExample) return true;

  const promptParts = prompt.split("___");
  if (promptParts.length !== 2) return false;
  const promptShape = [
    ...canonicalWordTokens(promptParts[0] ?? ""),
    "<blank>",
    ...canonicalWordTokens(promptParts[1] ?? ""),
  ];
  const exampleTokens = canonicalWordTokens(example);
  const targetTokens = canonicalWordTokens(word);
  const exampleShape: string[] = [];
  let replacedTarget = false;
  for (let index = 0; index < exampleTokens.length;) {
    if (targetTokens.length > 0 && targetTokens.every((token, offset) => exampleTokens[index + offset] === token)) {
      exampleShape.push("<blank>");
      index += targetTokens.length;
      replacedTarget = true;
    } else {
      exampleShape.push(exampleTokens[index] ?? "");
      index += 1;
    }
  }
  return replacedTarget && promptShape.join(" ") === exampleShape.join(" ");
}

/** Validate generated content against the single persisted server plan. */
export function validateGeneratedLessonExercise(
  context: LessonExerciseValidationContext,
  generated: Pick<LessonGeneration, "example_en" | "exercise">,
): LessonExerciseValidationIssue[] {
  const issues: LessonExerciseValidationIssue[] = [];
  const { exercise } = generated;
  if (exercise.activity_type !== context.plan.planned_activity_type) {
    issues.push({
      path: ["exercise", "activity_type"],
      message: `The planned activity type is ${context.plan.planned_activity_type}; do not substitute another type.`,
    });
  }
  if (exercise.multiline !== false) {
    issues.push({ path: ["exercise", "multiline"], message: "Ordinary Lesson exercises must be single-line." });
  }
  if (["exact_cloze", "collocation"].includes(exercise.activity_type)) {
    if ((exercise.prompt.match(/___/gu) ?? []).length !== 1) {
      issues.push({ path: ["exercise", "prompt"], message: "This planned blank-answer exercise must contain exactly one blank." });
    }
    if (!exercise.accepted_answers?.length) {
      issues.push({ path: ["exercise", "accepted_answers"], message: "A fixed-answer exercise requires accepted_answers." });
    }
    if (promptContainsTarget(exercise.prompt, context.word)) {
      issues.push({ path: ["exercise", "prompt"], message: "The target word must not appear outside the blank." });
    }
    if (promptRepeatsExample(exercise.prompt, generated.example_en, context.word)) {
      issues.push({ path: ["exercise", "prompt"], message: "Use a new context instead of turning the example into the exercise." });
    }
  }
  if (exercise.prompt.trim().toLocaleLowerCase().replace(/\s+/gu, " ")
    === generated.example_en.trim().toLocaleLowerCase().replace(/\s+/gu, " ")) {
    issues.push({ path: ["exercise", "prompt"], message: "The exercise prompt must differ from the example." });
  }
  const planned = context.plan.planned_activity_type;
  const promptHasTarget = promptContainsTarget(exercise.prompt, context.word);
  if (planned === "exact_cloze") {
    const wordCount = canonicalWordTokens(exercise.prompt).length + 1;
    if (wordCount < 6 || wordCount > 20 || /\p{Script=Han}/u.test(exercise.prompt)) {
      issues.push({ path: ["exercise", "prompt"], message: "An exact cloze needs a short English context of 6–20 words." });
    }
  } else if (planned === "word_recall") {
    if (!exercise.accepted_answers?.length) {
      issues.push({ path: ["exercise", "accepted_answers"], message: "A word recall requires a server-stored accepted answer." });
    }
    if (!/\p{Script=Han}/u.test(exercise.prompt) || promptHasTarget) {
      issues.push({ path: ["exercise", "prompt"], message: "Word recall must cue the target sense without showing the target word." });
    }
  } else if (planned === "translation_cn_to_en") {
    if (!/\p{Script=Han}/u.test(exercise.prompt) || promptHasTarget) {
      issues.push({ path: ["exercise", "prompt"], message: "Short translation must give a clear Chinese cue without showing the target word." });
    }
    if (exercise.accepted_answers?.length) {
      issues.push({ path: ["exercise", "accepted_answers"], message: "Open translation alternatives are graded semantically, not as one fixed string." });
    }
  } else if (planned === "collocation") {
    if (promptHasTarget || canonicalWordTokens(exercise.prompt).length < 6) {
      issues.push({ path: ["exercise", "prompt"], message: "Collocation tasks need a new, contextual sentence and must hide the target word." });
    }
    if (!exercise.accepted_answers?.length) {
      issues.push({ path: ["exercise", "accepted_answers"], message: "A planned collocation gap needs at least one accepted phrase." });
    }
  } else if (planned === "derivation") {
    if (!exercise.accepted_answers?.length || exercise.accepted_answers.some((answer) => canonicalizeRecallForm(answer) === canonicalizeRecallForm(context.word))) {
      issues.push({ path: ["exercise", "accepted_answers"], message: "A word-form task needs a useful derived answer distinct from the base word." });
    }
  }
  return issues;
}

function lessonGenerationSchemaFor(context: LessonExerciseValidationContext) {
  return lessonGenerationSchema.superRefine((generated, refinementContext) => {
    for (const issue of validateGeneratedLessonExercise(context, generated)) {
      refinementContext.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
  });
}

interface DeepSeekJsonOptions {
  maxTokens: number;
  repairMaxTokens?: number;
  repairGuidance?: (issues: readonly z.ZodIssue[]) => string | undefined;
  timeoutMs: number;
  task: "lesson_generation" | "semantic_lesson_grading" | "english_definition_grading" | "wrapup_generation" | "sentence_consolidation_generation" | "wrapup_grading";
}

export class DeepSeekError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: { httpStatus?: number; issuePaths?: string[]; finishReason?: string } = {},
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

function retryableJsonError(httpStatus?: number, finishReason?: string): DeepSeekError {
  return new DeepSeekError("DEEPSEEK_INVALID_JSON", 502, "DeepSeek returned invalid JSON.", {
    httpStatus,
    ...(finishReason ? { finishReason } : {}),
  });
}

function logDeepSeekError(error: DeepSeekError, task: DeepSeekJsonOptions["task"]): void {
  console.error("WordLoop DeepSeek request failed", {
    code: error.code,
    ...(error.details.httpStatus === undefined ? {} : { http_status: error.details.httpStatus }),
    ...(error.details.finishReason === undefined ? {} : { finish_reason: error.details.finishReason }),
    task,
    ...(error.details.issuePaths ? { issues: error.details.issuePaths } : {}),
  });
}

const retryableHttpStatuses = new Set([429, 500, 502, 503, 504]);

function retryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500));
}

function repairFeedback(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  guidance?: string,
): string {
  const fields = new Map<string, string>();
  for (const issue of issues) {
    const path = issue.path.map(String).join(".") || "$";
    if (!fields.has(path)) fields.set(path, issue.message);
  }
  return [
    "上一次 JSON 未通过校验。只修复以下字段：",
    ...[...fields].map(([path, message]) => `- ${path}: ${message}`),
    ...(guidance ? [guidance] : []),
    "返回完整 JSON。",
  ].join("\n");
}

async function deepSeekJson<T>(
  schema: z.ZodType<T>,
  prompt: string,
  input: unknown,
  options: DeepSeekJsonOptions,
): Promise<T> {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    const error = new DeepSeekError("DEEPSEEK_NOT_CONFIGURED", 503, "DeepSeek is not configured.");
    logDeepSeekError(error, options.task);
    throw error;
  }

  let repairMessage: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let httpStatus: number | undefined;
    let finishReason: string | undefined;
    try {
      const response = await fetch(deepseekBase, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "deepseek-flash",
          thinking: { type: "disabled" },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: [JSON.stringify(input), repairMessage].filter(Boolean).join("\n\n") },
          ],
          response_format: { type: "json_object" },
          max_tokens: attempt === 0 ? options.maxTokens : options.repairMaxTokens ?? options.maxTokens,
        }),
      });
      httpStatus = response.status;
      if (!response.ok) {
        if (attempt === 0 && retryableHttpStatuses.has(response.status)) {
          try { await response.body?.cancel(); } catch { /* Retry even if the response body cannot be drained. */ }
          await retryDelay();
          continue;
        }
        throw new DeepSeekError("DEEPSEEK_HTTP_ERROR", 502, `DeepSeek request failed with HTTP ${response.status}.`, { httpStatus });
      }

      let content: unknown;
      try {
        const payload: unknown = await response.json();
        if (typeof payload === "object" && payload !== null && "choices" in payload) {
          const choices = (payload as { choices?: unknown }).choices;
          if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object" && "message" in choices[0]) {
            const choice = choices[0] as { finish_reason?: unknown; message?: unknown };
            if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
            const message = choice.message;
            if (typeof message === "object" && message !== null && "content" in message) {
              content = (message as { content?: unknown }).content;
            }
          }
        }
      } catch {
        content = undefined;
      }

      if (typeof content !== "string" || content.trim().length === 0) {
        if (attempt === 0) {
          repairMessage = finishReason === "length"
            ? "上一次响应达到输出长度上限，JSON 被截断。请缩短每条说明，只返回必要字段，并完整闭合 JSON 对象。"
            : "上一次响应未返回有效 JSON。请只返回简短、完整且可解析的 JSON 对象。";
          continue;
        }
        throw retryableJsonError(httpStatus, finishReason);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        if (attempt === 0) {
          repairMessage = finishReason === "length"
            ? "上一次响应达到输出长度上限，JSON 被截断。请缩短每条说明，只返回必要字段，并完整闭合 JSON 对象。"
            : "上一次响应不是有效 JSON。请只返回简短、完整且可解析的 JSON 对象。";
          continue;
        }
        throw retryableJsonError(httpStatus, finishReason);
      }
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const issuePaths = [...new Set(validated.error.issues.map((issue) => issue.path.map(String).join(".") || "$"))];
        if (attempt === 0) {
          repairMessage = repairFeedback(validated.error.issues, [
            options.repairGuidance?.(validated.error.issues),
            ...(validated.error.issues.some((issue) => issue.path.join(".") === "error_layer")
              ? ["error_layer 只能使用 none、meaning、collocation、grammar、spelling、pronunciation。正确用 none；错误不能用 none。结构错误用 grammar，语义或逻辑误译用 meaning。"] : []),
          ].filter(Boolean).join("\n"));
          continue;
        }
        throw new DeepSeekError(
          "DEEPSEEK_INVALID_OUTPUT",
          502,
          "DeepSeek output did not match the required schema.",
          { httpStatus, issuePaths },
        );
      }
      return validated.data;
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new DeepSeekError("DEEPSEEK_TIMEOUT", 504, "DeepSeek request timed out.", { httpStatus });
        logDeepSeekError(timeoutError, options.task);
        throw timeoutError;
      }
      const requestError = error instanceof DeepSeekError
        ? error
        : new DeepSeekError("DEEPSEEK_HTTP_ERROR", 502, "DeepSeek request failed.", { httpStatus });
      logDeepSeekError(requestError, options.task);
      throw requestError;
    } finally {
      clearTimeout(timer);
    }
  }
  const error = retryableJsonError();
  logDeepSeekError(error, options.task);
  throw error;
}

export function generateLesson(input: {
  word: string;
  meaning_zh: string;
  part_of_speech: string;
  ipa?: string;
  lesson_profile: LessonProfile;
  error_focus: LessonErrorFocus;
  plan: LessonExercisePlan;
}): Promise<LessonGeneration> {
  const prompt = `${LESSON_GENERATION_PROMPT}\n\n本次计划的 exercise.activity_type 唯一合法值是 ${JSON.stringify(input.plan.planned_activity_type)}。输出必须逐字相同。搭配和派生词的每个字符串都必须同时含英文表达和简体中文释义。`;
  return deepSeekJson(lessonGenerationSchemaFor(input), prompt, input, {
    task: "lesson_generation", maxTokens: 1200, timeoutMs: 30_000,
    repairGuidance: (issues) => issues.some((issue) => issue.path.join(".") === "exercise.activity_type")
      ? `服务端已锁定唯一题型为 ${JSON.stringify(input.plan.planned_activity_type)}。只把 exercise.activity_type 改为这个完全相同的值；不得改成 cloze、exact_cloze 或其他题型，也不得替换目标或计划。`
      : undefined,
  });
}

export function gradeSemanticAnswer(input: {
  word: string;
  target_words?: string[];
  activity_type: string;
  instruction: string;
  prompt: string;
  answer: string;
  retry_count: number;
  plan?: LessonExercisePlan;
}): Promise<SemanticGrade> {
  return deepSeekJson(semanticGradeSchemaFor(input.retry_count), SEMANTIC_GRADING_PROMPT, input, {
    task: "semantic_lesson_grading", maxTokens: 1200, repairMaxTokens: 1800, timeoutMs: 20_000,
  });
}

export function gradeEnglishDefinition(input: {
  word: string;
  part_of_speech?: string;
  meaning_zh: string;
  answer: string;
}): Promise<EnglishDefinitionGrade> {
  return deepSeekJson(englishDefinitionGradeSchema, ENGLISH_DEFINITION_GRADING_PROMPT, input, {
    task: "english_definition_grading", maxTokens: 400, timeoutMs: 15_000,
  });
}

export function generateWrapup(input: { words: string[] }): Promise<WrapupExercise> {
  const words = [...new Set(input.words.map((word) => word.trim()).filter(Boolean))];
  if (words.length < 2 || words.length > 3) {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "Translation consolidation requires two or three target words.");
  }
  return deepSeekJson(wrapupExerciseSchema, WRAPUP_GENERATION_PROMPT, { words }, {
    task: "wrapup_generation", maxTokens: 900, timeoutMs: 30_000,
  });
}

export async function generateSentenceConsolidation(input: { words: string[] }): Promise<SentenceConsolidationExercise> {
  const words = [...new Set(input.words.map((word) => word.trim()).filter(Boolean))];
  if (words.length < 1 || words.length > 2) {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "Sentence consolidation requires one or two target words.");
  }
  const exercise = await deepSeekJson(sentenceConsolidationExerciseSchema, SENTENCE_CONSOLIDATION_GENERATION_PROMPT, { words }, {
    task: "sentence_consolidation_generation", maxTokens: 400, timeoutMs: 20_000,
  });
  const generatedWords = englishWords(exercise.prompt).map((word) => word.toLocaleLowerCase());
  if (!words.every((word) => generatedWords.includes(word.toLocaleLowerCase()))) {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "Sentence consolidation did not include every target word.");
  }
  return {
    ...exercise,
    instruction: "写一个自然英文句子，控制在 15–30 个单词。",
  };
}

export function generatePlannedConsolidation(input: {
  plan: LessonExercisePlan;
  words: string[];
}): Promise<PlannedConsolidationExercise> {
  const words = [...new Set(input.words.map((word) => word.trim()).filter(Boolean))];
  if (input.plan.scope !== "consolidation" || words.length < 1 || words.length > 2) {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "The saved consolidation plan is invalid.");
  }
  const prompt = input.plan.planned_activity_type === "translation_en_to_cn" ? WRAPUP_GENERATION_PROMPT
    : input.plan.planned_activity_type === "translation_cn_to_en" ? FULL_CN_TO_EN_CONSOLIDATION_PROMPT
      : input.plan.planned_activity_type === "sentence" ? SENTENCE_CONSOLIDATION_GENERATION_PROMPT : null;
  if (!prompt) throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "The saved consolidation activity is unsupported.");
  const schema = plannedConsolidationExerciseSchema.superRefine((exercise, context) => {
    if (exercise.activity_type !== input.plan.planned_activity_type) {
      context.addIssue({ code: "custom", path: ["activity_type"], message: `Use the saved planned activity type: ${input.plan.planned_activity_type}.` });
    }
    if (exercise.activity_type === "sentence" && !words.every((word) => englishWords(exercise.prompt).includes(word.toLocaleLowerCase()))) {
      context.addIssue({ code: "custom", path: ["prompt"], message: "The sentence prompt must explicitly show every target word as hinted application." });
    }
  });
  return deepSeekJson(schema, prompt, {
    plan: {
      planned_activity_type: input.plan.planned_activity_type,
      skill_goal: input.plan.skill_goal,
      target_sense: input.plan.target_sense,
      hint_level: input.plan.hint_level,
    },
    words,
  }, { task: "wrapup_generation", maxTokens: 900, timeoutMs: 30_000 });
}

export function gradeWrapupAnswer(input: {
  words: string[];
  instruction: string;
  prompt: string;
  answer: string;
  retry_count: number;
}): Promise<WrapupGrade> {
  return deepSeekJson(semanticGradeSchemaFor(input.retry_count), WRAPUP_GRADING_PROMPT, input, {
    task: "wrapup_grading", maxTokens: 1200, repairMaxTokens: 1800, timeoutMs: 20_000,
  });
}
