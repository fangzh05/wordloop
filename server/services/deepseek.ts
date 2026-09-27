import { z } from "zod";
import { getDeepSeekApiKey } from "../db.js";
import {
  ENGLISH_DEFINITION_GRADING_PROMPT,
  LESSON_GENERATION_PROMPT,
  SEMANTIC_GRADING_PROMPT,
  WRAPUP_GENERATION_PROMPT,
  WRAPUP_GRADING_PROMPT,
} from "./deepseekPrompts.js";

const deepseekBase = "https://api.deepseek.com/chat/completions";
const activityTypes = [
  "cloze", "exact_cloze", "translation_cn_to_en", "translation_en_to_cn", "collocation", "derivation", "recall", "sentence", "semantic_expression",
] as const;
const fixedAnswerActivityTypes = new Set<string>(["cloze", "exact_cloze", "derivation", "recall"]);
function hasChineseText(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

const exerciseSchema = z.object({
  activity_type: z.enum(activityTypes),
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
  part_of_speech: z.string().trim().min(1).max(40),
  meaning_zh: z.string().trim().min(1).max(240).refine(hasChineseText, "Use Chinese for the core meaning."),
  collocations: z.array(z.string().trim().min(1).max(200)).max(8),
  derivations: z.array(z.string().trim().min(1).max(200)).max(8),
  example_en: z.string().trim().min(1).max(1000),
  example_zh: z.string().trim().min(1).max(1000).refine(hasChineseText, "Add a Chinese translation for the example."),
  note: z.string().trim().min(1).max(1000),
  exercise: exerciseSchema,
});

const errorLayerSchema = z.enum(["none", "meaning", "collocation", "grammar", "spelling", "pronunciation"]);

export const semanticGradeSchema = z.object({
  is_correct: z.boolean(),
  error_layer: errorLayerSchema,
  message: z.string().trim().min(1).max(1000).refine(hasChineseText, "Use Chinese for grading feedback."),
  explanation: z.string().trim().min(1).max(4000).refine(hasChineseText, "Use Chinese for the grading explanation."),
  reference_answer: z.string().trim().min(1).max(4000).optional(),
});

export const englishDefinitionGradeSchema = z.object({
  is_correct: z.boolean(),
  feedback: z.string().trim().min(1).max(1000).refine(hasChineseText, "Use Chinese for grading feedback."),
});

export const wrapupExerciseSchema = z.object({
  activity_type: z.literal("sentence"),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.literal(true),
}).superRefine((value, context) => {
  const count = englishWords(value.prompt).length;
  if (count < 25 || count > 40) {
    context.addIssue({ code: "custom", message: "The wrap-up sentence must contain 25–40 English words.", path: ["prompt"] });
  }
});

export const wrapupGradeSchema = z.object({
  is_correct: z.boolean(),
  error_layer: errorLayerSchema,
  message: z.string().trim().min(1).max(1000).refine(hasChineseText, "Use Chinese for grading feedback."),
  explanation: z.string().trim().min(1).max(4000).refine(hasChineseText, "Use Chinese for the grading explanation."),
  reference_answer: z.string().trim().min(1).max(4000).optional(),
});

export type LessonGeneration = z.output<typeof lessonGenerationSchema>;
export type SemanticGrade = z.output<typeof semanticGradeSchema>;
export type EnglishDefinitionGrade = z.output<typeof englishDefinitionGradeSchema>;
export type WrapupExercise = z.output<typeof wrapupExerciseSchema>;
export type WrapupGrade = z.output<typeof wrapupGradeSchema>;

interface DeepSeekJsonOptions {
  maxTokens: number;
  timeoutMs: number;
  task: "lesson_generation" | "semantic_lesson_grading" | "english_definition_grading" | "wrapup_generation" | "wrapup_grading";
}

export class DeepSeekError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: { httpStatus?: number; issuePaths?: string[] } = {},
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

function retryableJsonError(httpStatus?: number): DeepSeekError {
  return new DeepSeekError("DEEPSEEK_INVALID_JSON", 502, "DeepSeek returned invalid JSON.", { httpStatus });
}

function logDeepSeekError(error: DeepSeekError, task: DeepSeekJsonOptions["task"]): void {
  console.error("WordLoop DeepSeek request failed", {
    code: error.code,
    ...(error.details.httpStatus === undefined ? {} : { http_status: error.details.httpStatus }),
    task,
    ...(error.details.issuePaths ? { issues: error.details.issuePaths } : {}),
  });
}

const retryableHttpStatuses = new Set([429, 500, 502, 503, 504]);

function retryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500));
}

function repairFeedback(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const fields = new Map<string, string>();
  for (const issue of issues) {
    const path = issue.path.map(String).join(".") || "$";
    if (!fields.has(path)) fields.set(path, issue.message);
  }
  return [
    "上一次 JSON 未通过校验。只修复以下字段：",
    ...[...fields].map(([path, message]) => `- ${path}: ${message}`),
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
          max_tokens: options.maxTokens,
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
            const message = (choices[0] as { message?: unknown }).message;
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
          repairMessage = "上一次响应未返回有效 JSON。请修复并返回完整 JSON。";
          continue;
        }
        throw retryableJsonError(httpStatus);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        if (attempt === 0) {
          repairMessage = "上一次响应不是有效 JSON。请修复 JSON 格式并返回完整 JSON。";
          continue;
        }
        throw retryableJsonError(httpStatus);
      }
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const issuePaths = [...new Set(validated.error.issues.map((issue) => issue.path.map(String).join(".") || "$"))];
        if (attempt === 0) {
          repairMessage = repairFeedback(validated.error.issues);
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
}): Promise<LessonGeneration> {
  return deepSeekJson(lessonGenerationSchema, LESSON_GENERATION_PROMPT, input, {
    task: "lesson_generation", maxTokens: 1200, timeoutMs: 30_000,
  });
}

export function gradeSemanticAnswer(input: {
  word: string;
  activity_type: string;
  instruction: string;
  prompt: string;
  answer: string;
  retry_count: number;
}): Promise<SemanticGrade> {
  return deepSeekJson(semanticGradeSchema, SEMANTIC_GRADING_PROMPT, input, {
    task: "semantic_lesson_grading", maxTokens: 600, timeoutMs: 20_000,
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
  return deepSeekJson(wrapupExerciseSchema, WRAPUP_GENERATION_PROMPT, input, {
    task: "wrapup_generation", maxTokens: 900, timeoutMs: 30_000,
  });
}

export function gradeWrapupAnswer(input: {
  words: string[];
  instruction: string;
  prompt: string;
  answer: string;
  retry_count: number;
}): Promise<WrapupGrade> {
  return deepSeekJson(wrapupGradeSchema, WRAPUP_GRADING_PROMPT, input, {
    task: "wrapup_grading", maxTokens: 700, timeoutMs: 20_000,
  });
}
