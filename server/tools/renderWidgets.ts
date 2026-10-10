import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { getCompletedLessonWords } from "../services/attempts.js";
import { ensureTodayQueue } from "../services/dailyQueue.js";
import { getProgress } from "../services/progress.js";
import { getDueReviewSelection } from "../services/review.js";
import { getLearningBudget, newWordAdmissionLimit } from "../services/learningBudget.js";
import {
  freezeLessonQueueForSession,
  getActiveStudySession,
  getStudyDate,
  makeStudyState,
  normalizeLegacyLessonSession,
  normalizeStudyStateForRead,
  persistStudyState,
  persistStudyStateIfRevision,
  recordPlannedSubmission,
} from "../services/studySessions.js";
import { getTodayWords } from "../services/words.js";
import { cadenceCandidatePlans, planLessonQueue } from "../services/exercisePlanner.js";
import { lessonGenerationSchema, validateGeneratedLessonExercise } from "../services/deepseek.js";
import { plannedSkillEvidence } from "../services/plannedSubmission.js";
import { getLessonCadence } from "../services/lessonConsolidation.js";
import { gradeExactCloze, gradeExactRecall } from "../../web/src/grading/deterministic.js";
import {
  buildLessonWords,
  buildLessonNavigation,
  filterNewWordsWithoutLessonHistory,
  isLessonCursorAtCurrentWord,
  lessonProgressLabel,
  lessonWordAt,
  reconcileLessonQueueAfterCursor,
} from "../services/lessonQueue.js";
import { normalizeWord } from "../services/wordNormalization.js";
import { formatMeaningByPartOfSpeech, formatPartOfSpeech } from "../../shared/lexicalDisplay.js";
import { withLessonClozeHint } from "../services/lessonClozeHint.js";
import type { ReviewVocabularyItem, StudyPhase, StudySessionRow, StudyState, VocabularyItem } from "../types.js";
import {
  REVIEW_SESSION_MAX,
  LESSON_WIDGET_VERSION,
  containsTargetWord,
  isValidExactClozePrompt,
  normalizeReviewWidgetPayload,
  reviewWidgetItemSchema,
  reviewWidgetPayloadSchema,
  type ReviewWidgetItem,
  type ReviewWidgetPayload,
  type LessonExercisePlan,
  type SkillEvidence,
  lessonExercisePlanSchema,
} from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

// Rotate the primary URI when a widget's client bundle, payload contract, or
// host-facing transport changes materially; keep the old URI as an alias for
// the current compatible bundle. Prompt, server, copy, or small CSS changes alone do not require rotation.
export const WIDGET_URIS = {
  import: "ui://wordloop/import.html",
  pretest: "ui://wordloop/pretest.html",
  review: "ui://wordloop/review.html",
  dashboard: "ui://wordloop/dashboard.html",
  pronunciation: "ui://wordloop/pronunciation.html",
  dictation: "ui://wordloop/dictation-v2.html",
  lesson: "ui://wordloop/lesson-v9.html",
} as const;

/** Resource aliases kept for conversations that still reference old Lesson URIs. */
export const LEGACY_WIDGET_URIS = {
  lessonV8: "ui://wordloop/lesson-v8.html",
  lessonV7: "ui://wordloop/lesson-v7.html",
  lessonV6: "ui://wordloop/lesson-v6.html",
  lessonV5: "ui://wordloop/lesson-v5.html",
  lessonV4: "ui://wordloop/lesson-v4.html",
  lessonV3: "ui://wordloop/lesson-v3.html",
  lessonV2: "ui://wordloop/lesson-v2.html",
  lesson: "ui://wordloop/lesson.html",
  dictationV1: "ui://wordloop/dictation.html",
} as const;

const pronunciationWord = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(120).optional(),
  meaning_zh: z.string().trim().min(1).max(1000).optional(),
}).strict();
const pretestItem = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120).describe("American English IPA, including stress marks"),
  part_of_speech: z.string().trim().min(1).max(120).describe("All dictionary parts of speech, joined with / when there are several."),
  meaning_zh: z.string().trim().min(1).max(1000).describe("Chinese meanings, with each part of speech prefixed to its meanings when available."),
  prompt: z.string().trim().max(1000).optional(),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
}).strict();
const pretestPayload = z.object({
  items: z.array(pretestItem).min(1).max(7),
  title: z.string().trim().min(1).max(100).default("快速预测试"),
}).strict();
const pretestInput = z.union([
  z.object({ resume: z.literal(true) }).strict(),
  pretestPayload,
]);
type PretestRenderItem = z.infer<typeof pretestItem>;
const pretestToolInputSchema = z.object({
  resume: z.literal(true).optional(),
  items: z.array(pretestItem).min(1).max(7).optional(),
  title: z.string().trim().min(1).max(100).optional(),
}).strict();
function validateExactClozePrompt(
  value: { activity_type: string; prompt: string },
  context: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): void {
  if (value.activity_type !== "exact_cloze") return;
  if (!isValidExactClozePrompt(value.prompt)) {
    context.addIssue({
      code: "custom",
      message: "An exact_cloze prompt must be a natural English sentence.",
      path: [...pathPrefix, "prompt"],
    });
  }
}

function validateExactClozeTargetExposure(
  word: string,
  exercise: { activity_type: string; instruction: string; prompt: string },
  context: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): void {
  if (exercise.activity_type !== "exact_cloze") return;
  if (containsTargetWord(exercise.instruction, word)) {
    context.addIssue({
      code: "custom",
      message: "An exact_cloze instruction must not reveal the target word.",
      path: [...pathPrefix, "instruction"],
    });
  }
  if (containsTargetWord(exercise.prompt, word)) {
    context.addIssue({
      code: "custom",
      message: "An exact_cloze prompt must not reveal the target word.",
      path: [...pathPrefix, "prompt"],
    });
  }
}

const lessonExercise = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
  accepted_answers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).strict().superRefine((value, context) => {
  if ((value.activity_type === "cloze" || value.activity_type === "exact_cloze") && !value.prompt.includes("___")) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["prompt"] });
  }
  if (value.activity_type === "exact_cloze" && !value.accepted_answers?.length) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["accepted_answers"] });
  }
  if (value.activity_type === "translation_cn_to_en" && !/\p{Script=Han}/u.test(value.prompt)) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["prompt"] });
  }
  if (value.activity_type === "translation_en_to_cn" && !/[A-Za-z]/.test(value.prompt)) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["prompt"] });
  }
  validateExactClozePrompt(value, context);
});
const lessonFeedback = z.object({
  is_correct: z.boolean(),
  user_answer: z.string().max(4000),
  error_layer: z.string().trim().max(80).optional().describe("具体错误层级：词义、搭配、语法、发音或拼写。"),
  message: z.string().trim().max(1000).optional().describe("错误时必须指出用户答案中的具体错误片段或位置，不要只写笼统的错误数量。"),
  reference_answer: z.string().trim().max(4000).optional(),
  explanation: z.string().trim().max(4000).optional().describe("错误时说明错因和下一步改哪里/怎么改；第一次错误只能给自纠提示，不得给完整改后句。"),
  reveal_answer: z.boolean(),
  task_fulfillment: z.boolean().optional(),
  meaning: z.object({ passed: z.boolean(), note: z.string().max(1000) }).optional(),
  collocation: z.object({ passed: z.boolean(), note: z.string().max(1000) }).optional(),
  grammar: z.object({ passed: z.boolean(), note: z.string().max(1000) }).optional(),
  naturalness: z.object({ passed: z.boolean(), note: z.string().max(1000) }).optional(),
  target_word_results: z.array(z.object({ word_id: z.string().uuid().optional(), word: z.string().min(1).max(100), outcome: z.enum(["correct", "incorrect", "partial", "not_assessed"]), meaning: z.string().max(1000).optional(), collocation: z.string().max(1000).optional(), grammar: z.string().max(1000).optional(), naturalness: z.string().max(1000).optional(), error_excerpt: z.string().max(500).optional(), hint: z.string().max(500).optional(), reference_expression: z.string().max(1000).optional() }).strict()).max(3).optional(),
  skill_results: z.array(z.object({ skill_id: z.string().min(1).max(120), word_id: z.string().uuid().optional(), outcome: z.enum(["correct", "incorrect", "partial", "not_assessed"]), evidence: z.string().max(500).optional() }).strict()).max(8).optional(),
  error_excerpt: z.string().max(500).optional(),
  short_hint: z.string().max(500).optional(),
}).strict();
const lessonProfile = z.enum(["quick_recall", "reinforce", "targeted_relearn"]);
const lessonErrorFocus = z.enum(["meaning", "collocation", "grammar", "spelling", "pronunciation"]).nullable();
const translatedLessonEntry = z.string().trim().min(1).max(200).refine(
  (value) => /[A-Za-z]/.test(value) && /\p{Script=Han}/u.test(value),
  "Lesson collocations and derivatives must include an English form and Chinese translation.",
);
const lessonCommon = {
  title: z.string().trim().max(120).optional(),
  progress: z.string().trim().max(40).optional(),
  lesson_profile: lessonProfile.optional(),
  error_focus: lessonErrorFocus.optional(),
  consolidation: z.literal(true).optional(),
  consolidation_kind: z.enum(["translation", "translation_cn_to_en", "sentence"]).optional(),
  consolidation_trigger_round: z.number().int().positive().optional(),
  consolidation_target_words: z.array(z.string().trim().min(1).max(100)).max(3).optional(),
  consolidation_status: z.enum(["pending", "exercise", "feedback", "completed"]).optional(),
};
const explainPayload = z.object({
  ...lessonCommon,
  mode: z.literal("explain"),
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(120),
  meaning_zh: z.string().trim().min(1).max(1000),
  collocations: z.array(translatedLessonEntry).max(8),
  derivations: z.array(translatedLessonEntry).max(8),
  example_en: z.string().trim().min(1).max(1000),
  example_zh: z.string().trim().min(1).max(1000).optional(),
  note: z.string().trim().min(1).max(1000),
  exercise: lessonExercise,
}).strict().superRefine((value, context) => {
  validateExactClozeTargetExposure(value.word, value.exercise, context, ["exercise"]);
});
const exercisePayload = z.object({
  ...lessonCommon,
  mode: z.literal("exercise"),
  wrapup: z.literal(true).optional(),
  word: z.string().trim().min(1).max(100),
  progress: z.string().trim().min(1).max(40),
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
  accepted_answers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).strict().superRefine((value, context) => {
  if ((value.activity_type === "cloze" || value.activity_type === "exact_cloze") && !value.prompt.includes("___")) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["prompt"] });
  }
  if (value.activity_type === "exact_cloze" && !value.accepted_answers?.length) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["accepted_answers"] });
  }
  validateExactClozePrompt(value, context);
  validateExactClozeTargetExposure(value.word, value, context);
});
const feedbackPayload = z.object({
  ...lessonCommon,
  mode: z.literal("feedback"),
  wrapup: z.literal(true).optional(),
  word: z.string().trim().min(1).max(100),
  progress: z.string().trim().min(1).max(40),
  exercise: lessonExercise,
  feedback: lessonFeedback,
}).strict().superRefine((value, context) => {
  validateExactClozeTargetExposure(value.word, value.exercise, context, ["exercise"]);
});
const lessonPayload = z.discriminatedUnion("mode", [explainPayload, exercisePayload, feedbackPayload]);
const lessonInput = z.union([lessonPayload, z.object({ resume: z.literal(true) }).strict()]);
const feedbackToolPayload = z.object({
  mode: z.literal("feedback"),
  wrapup: z.literal(true).optional(),
  consolidation: z.literal(true).optional(),
  consolidation_kind: z.enum(["translation", "translation_cn_to_en", "sentence"]).optional(),
  word: z.string().trim().min(1).max(100),
  lesson_profile: lessonProfile.optional(),
  error_focus: lessonErrorFocus.optional(),
  submission_id: z.string().uuid().optional(),
  exercise_id: z.string().uuid().optional(),
  plan_id: z.string().uuid().optional(),
  hint_used: z.boolean().default(false),
  feedback: lessonFeedback,
}).strict();
const lessonToolInputBranches = [
  z.object({ resume: z.literal(true) }).strict(),
  explainPayload,
  exercisePayload,
  feedbackToolPayload,
] as const;
const lessonToolInputVariants = z.union(lessonToolInputBranches);
// The MCP SDK only emits JSON Schema for top-level objects; keep runtime union
// validation while exposing its strict branches through the object's anyOf.
const lessonToolInputSchema = z.object({
  resume: z.literal(true).optional(),
  mode: z.enum(["explain", "exercise", "feedback"]).optional(),
}).passthrough().superRefine((input, context) => {
  if (!lessonToolInputVariants.safeParse(input).success) {
    context.addIssue({ code: "custom", message: "Invalid Lesson tool input." });
  }
}).meta({
  additionalProperties: true,
  anyOf: lessonToolInputBranches.map((branch) => {
    const { $schema: _schemaVersion, ...jsonSchema } = z.toJSONSchema(branch);
    return jsonSchema;
  }),
});
const dictationPayload = z.object({
  text: z.string().trim().min(1).max(4000),
  title: z.string().trim().min(1).max(100).default("听写"),
}).strict();
const dictationWordsPayload = z.object({
  mode: z.literal("words"),
  words: z.array(z.string().trim().min(1).max(100)).min(5).max(7),
  title: z.string().trim().min(1).max(100).default("单词听写"),
  current_index: z.number().int().min(0).max(6).optional(),
}).strict();
const dictationResumeInput = z.object({ resume: z.literal(true) }).strict();
const dictationInput = z.union([dictationWordsPayload, dictationPayload, dictationResumeInput]);
const dictationToolInputSchema = z.union([
  dictationWordsPayload,
  z.object({ text: z.string().trim().min(1).max(4000), title: z.string().trim().min(1).max(100).optional() }).strict(),
  dictationResumeInput,
]);
const legacyReviewItem = z.object({
  word: z.string().trim().min(1).max(100),
  meaning_zh: z.string().trim().min(1).max(1000).describe("Chinese meanings, with each part of speech prefixed to its meanings when available."),
  part_of_speech: z.string().trim().max(120).optional(),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
  error_layers: z.array(z.enum(["meaning", "collocation", "grammar", "pronunciation", "spelling"])).max(5).default([]),
});
const legacyReviewToolInputSchema = z.object({
  items: z.array(legacyReviewItem).min(1).max(REVIEW_SESSION_MAX).optional(),
  current_index: z.number().int().min(0).max(REVIEW_SESSION_MAX).optional(),
  title: z.string().trim().min(1).max(100).optional(),
}).strict();
const reviewV2ToolInputSchema = z.object({
  current_index: z.number().int().min(0).max(REVIEW_SESSION_MAX).optional(),
}).strict();

export const lessonInputSchema = lessonInput;
export const pretestInputSchema = pretestInput;
export const dictationInputSchema = dictationInput;

const lessonPhaseByMode = {
  explain: "lesson_explain",
  exercise: "lesson_exercise",
  feedback: "lesson_feedback",
} as const;
type LessonInput = z.infer<typeof lessonInput>;

const lessonExerciseKeys = ["activity_type", "instruction", "prompt", "multiline", "accepted_answers"] as const;
function containsWholeEnglishWord(text: string, word: string): boolean {
  const haystack = text.toLocaleLowerCase();
  const needle = word.toLocaleLowerCase();
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return false;
    const before = index === 0 ? "" : haystack[index - 1] ?? "";
    const after = haystack[index + needle.length] ?? "";
    if (!/[a-z]/.test(before) && !/[a-z]/.test(after)) return true;
    offset = index + 1;
  }
  return false;
}
const lessonFeedbackKeys = [
  "is_correct",
  "user_answer",
  "error_layer",
  "message",
  "reference_answer",
  "explanation",
  "reveal_answer",
] as const;

function projectPersistedFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
      .map((key) => [key, source[key]]),
  );
}

function normalizePersistedLessonPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.mode === "explain") {
    const exercise = lessonExercise.parse(projectPersistedFields(payload.exercise, lessonExerciseKeys));
    return { ...payload, exercise };
  }
  if (payload.mode === "exercise") {
    const exercise = lessonExercise.parse(projectPersistedFields(payload, lessonExerciseKeys));
    return { ...payload, ...exercise };
  }
  if (payload.mode === "feedback") {
    const exercise = lessonExercise.parse(projectPersistedFields(payload.exercise, lessonExerciseKeys));
    const feedback = lessonFeedback.parse(projectPersistedFields(payload.feedback, lessonFeedbackKeys));
    return { ...payload, exercise, feedback };
  }
  throw new Error("Study session lesson payload has an unsupported mode.");
}

export function lessonWidgetResponsePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const response = { ...payload };
  delete response.accepted_answers;
  for (const key of ["plan", "consolidation_plan"]) {
    if (typeof response[key] === "object" && response[key] !== null && !Array.isArray(response[key])) {
      const plan = { ...response[key] as Record<string, unknown> };
      delete plan.target_sense;
      delete plan.word_id;
      delete plan.target_word_ids;
      delete plan.skill_signals;
      response[key] = plan;
    }
  }
  if (typeof response.exercise === "object" && response.exercise !== null && !Array.isArray(response.exercise)) {
    const exercise = { ...response.exercise as Record<string, unknown> };
    delete exercise.accepted_answers;
    response.exercise = exercise;
  }
  if (typeof response.feedback === "object" && response.feedback !== null && !Array.isArray(response.feedback)) {
    const feedback = { ...response.feedback as Record<string, unknown> };
    if (feedback.reveal_answer !== true) delete feedback.reference_answer;
    if (Array.isArray(feedback.target_word_results)) {
      feedback.target_word_results = feedback.target_word_results.map((result) => {
        if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
        const safeResult = { ...result as Record<string, unknown> };
        delete safeResult.reference_expression;
        return safeResult;
      });
    }
    response.feedback = feedback;
  }
  return response;
}

function widgetPayloadWithState(payload: Record<string, unknown>, state: StudyState): Record<string, unknown> {
  return { ...payload, widget: state.widget, phase: state.phase, current_index: state.current_index };
}

function lessonWidgetPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, widget_version: LESSON_WIDGET_VERSION };
}

function persistedLessonProfileFields(state: StudyState | null | undefined, word?: string): Record<string, unknown> {
  if (!state || state.widget !== "lesson") return {};
  if (word && (!state.current_word || normalizeWord(state.current_word) !== normalizeWord(word))) return {};
  const profile = lessonProfile.safeParse(state.payload.lesson_profile);
  const errorFocus = lessonErrorFocus.safeParse(state.payload.error_focus);
  return {
    ...(profile.success ? { lesson_profile: profile.data } : {}),
    ...(errorFocus.success ? { error_focus: errorFocus.data } : {}),
  };
}

function resumablePayload(session: StudySessionRow | null, widget: StudyState["widget"]): Record<string, unknown> {
  const state = session?.state ? normalizeStudyStateForRead(session.state) : null;
  if (!state || state.widget !== widget) {
    throw new Error(`No resumable active ${widget} study session.`);
  }
  return {
    ...widgetPayloadWithState(state.payload, state),
    ...(widget === "pretest" && session ? { revision: session.updated_at } : {}),
  };
}

export async function resumableLessonPayload(session: StudySessionRow | null): Promise<Record<string, unknown>> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  let resolved = session?.state ? normalizeStudyStateForRead(session.state) : null;
  let resolvedSession = session;
  if (!resolved || resolved.widget !== "lesson") {
    throw new Error("No resumable active lesson study session.");
  }
  if (resolved.flow.lesson_words === undefined && resolvedSession) {
    resolvedSession = await normalizeLegacyLessonSession(resolvedSession, db, userId);
    resolved = resolvedSession.state ? normalizeStudyStateForRead(resolvedSession.state) : null;
  }
  if (!resolved || resolved.widget !== "lesson" || !resolved.flow.lesson_words || !resolved.current_word) {
    throw new Error("LESSON_QUEUE_MISSING");
  }

  if (resolvedSession && resolved.phase !== "lesson_complete") {
    const completedBeforeSession = await getCompletedLessonWords(db, userId, resolvedSession.started_at);
    const reconciled = reconcileLessonQueueAfterCursor({
      lessonWords: resolved.flow.lesson_words,
      currentIndex: resolved.current_index,
      completedLessonWords: completedBeforeSession,
      relearnWords: resolved.flow.relearn_words,
    });
    if (reconciled?.changed) {
      resolved = {
        ...resolved,
        current_index: reconciled.currentIndex,
        flow: { ...resolved.flow, lesson_words: reconciled.lessonWords },
      };
      resolvedSession = await persistStudyState({
        ...resolved,
        payload: {
          ...resolved.payload,
          progress: lessonProgressLabel(resolved.flow.relearn_words, reconciled.lessonWords, reconciled.currentIndex),
          navigation: buildLessonNavigation(reconciled.lessonWords, reconciled.currentIndex, reconciled.currentWord),
        },
      }, db, userId, resolvedSession);
      resolved = resolvedSession.state ? normalizeStudyStateForRead(resolvedSession.state) : resolved;
    }
  }

  const queueForPlanning = resolved.flow.lesson_words;
  if (!queueForPlanning || !resolved.current_word) throw new Error("LESSON_QUEUE_MISSING");
  let restoredFlow = resolved.flow;
  if (resolved.payload.consolidation !== true) {
    const activity = persistedExerciseActivity(resolved);
    restoredFlow = await ensurePlannedFlow(
      resolved.flow,
      queueForPlanning,
      db,
      userId,
      activity ? { index: resolved.current_index, activity_type: activity } : undefined,
    );
  }
  const currentPlan = restoredFlow.exercise_plans?.[resolved.current_index];
  const resolvedQueue = restoredFlow.lesson_words;
  const resolvedCurrentWord = resolved.current_word;
  if (!resolvedQueue || !resolvedCurrentWord) throw new Error("LESSON_QUEUE_MISSING");
  const navigation = buildLessonNavigation(resolvedQueue, resolved.current_index, resolvedCurrentWord);
  // Persisted Lesson payloads from older versions may contain extra keys in
  // nested exercise/feedback objects. The Widget keeps those nested schemas
  // strict, so project only their canonical fields on resume while retaining
  // unknown top-level fields for forward compatibility.
  const normalizedPayload = normalizePersistedLessonPayload(resolved.payload);
  const responseContent = {
    ...normalizedPayload,
    ...(!resolved.payload.consolidation && currentPlan ? { plan: currentPlan } : {}),
  };
  const persistedPayload = { ...responseContent, navigation };
  const responseWithPlan = lessonWidgetPayload(lessonWidgetResponsePayload(await withLessonClozeHint({ ...responseContent, navigation })));
  const payloadChanged = JSON.stringify(resolved.payload) !== JSON.stringify(responseContent)
    || JSON.stringify(resolved.flow) !== JSON.stringify(restoredFlow);
  const navigationChanged = JSON.stringify(resolved.payload.navigation) !== JSON.stringify(navigation);
  const versionChanged = resolved.payload.widget_version !== LESSON_WIDGET_VERSION;
  if ((payloadChanged || navigationChanged || versionChanged) && resolvedSession) {
    const nextState = { ...resolved, flow: restoredFlow, payload: persistedPayload };
    resolvedSession = resolvedSession.updated_at
      ? await persistStudyStateIfRevision(nextState, resolvedSession.updated_at, db, userId, resolvedSession.id)
      : await persistStudyState(nextState, db, userId, resolvedSession);
    resolved = resolvedSession.state ? normalizeStudyStateForRead(resolvedSession.state) : { ...resolved, payload: persistedPayload };
  } else {
    resolved = { ...resolved, flow: restoredFlow, payload: persistedPayload };
  }
  return widgetPayloadWithState(responseWithPlan, resolved);
}

async function saveWidgetState(input: {
  date?: string;
  knownActive?: StudySessionRow | null;
  widget: StudyState["widget"];
  phase: StudyPhase;
  current_word: string | null;
  current_index: number;
  retry_count: number;
  flow?: StudyState["flow"];
  payload: Record<string, unknown>;
  atomicSubmission?: { submission_id: string; plan: LessonExercisePlan; hint_used: boolean };
}): Promise<Record<string, unknown>> {
  const { date, knownActive, flow, atomicSubmission, ...stateInput } = input;
  let state = makeStudyState({
    date: date ?? await getStudyDate(),
    flow: flow ?? knownActive?.state?.flow,
    ...stateInput,
  });
  if (atomicSubmission) {
    if (!knownActive?.state || knownActive.state.widget !== "lesson" || state.widget !== "lesson") {
      throw new Error("PLANNED_SUBMISSION_SESSION_MISSING");
    }
    const answerFeedback = state.payload.feedback as Record<string, unknown> | undefined;
    const savedPayload = knownActive.state.payload;
    const exercisePayload = savedPayload.mode === "feedback" ? savedPayload.exercise
      : savedPayload.mode === "exercise" ? savedPayload : null;
    const exercise = lessonExercise.safeParse(projectPersistedFields(exercisePayload, lessonExerciseKeys));
    const answer = typeof answerFeedback?.user_answer === "string" ? answerFeedback.user_answer : "";
    if (!exercise.success || exercise.data.activity_type !== atomicSubmission.plan.planned_activity_type || !answer.trim()) {
      throw new Error("PLANNED_SUBMISSION_EXERCISE_MISMATCH");
    }
    let isCorrect = answerFeedback?.is_correct === true;
    let errorLayer = typeof answerFeedback?.error_layer === "string" ? answerFeedback.error_layer : "meaning";
    let message = typeof answerFeedback?.message === "string" ? answerFeedback.message : "答案需要调整。";
    let explanation = typeof answerFeedback?.explanation === "string" ? answerFeedback.explanation : message;
    const recallActivity = ["word_recall", "recall", "spelling"].includes(exercise.data.activity_type);
    const accepted = Array.isArray(exercise.data.accepted_answers) ? exercise.data.accepted_answers : [];
    const fixedActivity = ["exact_cloze", "cloze", "derivation", "collocation"].includes(exercise.data.activity_type) && accepted.length > 0;
    let deterministicOutcome: "correct" | "incorrect" | undefined;
    if (fixedActivity || recallActivity) {
      const result = recallActivity
        ? gradeExactRecall(answer, knownActive.state.current_word ?? "")
        : gradeExactCloze(answer, accepted);
      isCorrect = result.is_correct;
      errorLayer = result.error_layer;
      if (exercise.data.activity_type === "collocation" && !isCorrect && errorLayer !== "spelling") errorLayer = "collocation";
      message = result.feedback;
      explanation = result.feedback;
      deterministicOutcome = result.is_correct ? "correct" : "incorrect";
    }
    const nextRetry = isCorrect ? knownActive.state.retry_count : knownActive.state.retry_count + 1;
    const revealAnswer = !isCorrect && nextRetry >= 2;
    const referenceAnswer = typeof answerFeedback?.reference_answer === "string" ? answerFeedback.reference_answer.trim() : "";
    if (revealAnswer && exercise.data.accepted_answers?.length && (fixedActivity || !referenceAnswer)) {
      answerFeedback!.reference_answer = exercise.data.accepted_answers[0];
    }
    const finalReference = revealAnswer ? (typeof answerFeedback?.reference_answer === "string" ? answerFeedback.reference_answer : undefined) : undefined;
    if (revealAnswer && !finalReference?.trim()) throw new Error("PLANNED_SECOND_MISS_REFERENCE_MISSING");
    const skillResults = Array.isArray(answerFeedback?.skill_results)
      ? answerFeedback.skill_results as Array<{ skill_id: string; word_id?: string; outcome: "correct" | "incorrect" | "partial" | "not_assessed"; evidence?: string }>
      : [];
    const savedFeedback = {
      ...answerFeedback,
      is_correct: isCorrect,
      error_layer: isCorrect ? "none" : errorLayer,
      message,
      explanation,
      reveal_answer: revealAnswer,
      ...(finalReference ? { reference_answer: finalReference } : {}),
      ...(finalReference ? {} : { reference_answer: undefined }),
    };
    state = {
      ...state,
      retry_count: nextRetry,
      payload: { ...state.payload, feedback: savedFeedback },
    };
    const firstAttempt = knownActive.state.retry_count === 0;
    const evidence = plannedSkillEvidence({
      plan: atomicSubmission.plan,
      overall_correct: isCorrect,
      skill_results: skillResults,
      first_attempt: firstAttempt,
      hint_used: atomicSubmission.hint_used,
      answer_revealed: revealAnswer,
      modified_correct: !firstAttempt && isCorrect,
      ...(deterministicOutcome ? { deterministic_outcome: deterministicOutcome } : {}),
    });
    const saved = await recordPlannedSubmission({
      active: knownActive,
      expected_revision: knownActive.updated_at,
      submission_id: atomicSubmission.submission_id,
      plan: atomicSubmission.plan,
      scope: atomicSubmission.plan.scope,
      word: knownActive.state.current_word ?? "",
      activity_type: exercise.data.activity_type,
      user_answer: answer,
      is_correct: isCorrect,
      error_layer: isCorrect ? "none" : errorLayer,
      skill_evidence: evidence as SkillEvidence[],
      first_attempt: firstAttempt,
      hint_used: atomicSubmission.hint_used,
      answer_revealed: revealAnswer,
      active_ms: null,
      grading_ms: null,
      next_state: state,
      completion_date: await getStudyDate(),
      ...(atomicSubmission.plan.scope === "lesson" ? { cadence_candidates: cadenceCandidatePlans(atomicSubmission.plan, knownActive.state.current_word ?? "") } : {}),
    });
    if (!saved.state) throw new Error("PLANNED_SUBMISSION_STATE_MISSING");
    return widgetPayloadWithState(lessonWidgetResponsePayload(await withLessonClozeHint(saved.state.payload)), saved.state);
  }
  const persisted = state.payload.consolidation === true && knownActive
    ? await persistStudyStateIfRevision(state, knownActive.updated_at, getDatabase(), getAuthenticatedUserId(), knownActive.id)
    : await persistStudyState(state, getDatabase(), getAuthenticatedUserId(), knownActive);
  const persistedPayload = persisted.state?.payload ?? input.payload;
  return {
    ...widgetPayloadWithState(input.widget === "lesson" ? lessonWidgetResponsePayload(await withLessonClozeHint(persistedPayload)) : persistedPayload, persisted.state ?? state),
    ...(input.widget === "pretest" ? { revision: persisted.updated_at } : {}),
  };
}

function lessonRenderIndex(
  active: StudySessionRow | null,
  input: Exclude<LessonInput, { resume: true }>,
): number {
  if (active?.state?.widget !== "lesson") return 0;
  if (active.state.payload.mode === "generation_error") return active.state.current_index;
  return input.mode === "explain"
    ? (active.state.current_word ? active.state.current_index + 1 : active.state.current_index)
    : active.state.current_index;
}

function lessonRetryCount(active: StudySessionRow | null, input: Extract<LessonInput, { mode: "feedback" }>): number {
  if (input.feedback.is_correct !== false) {
    return active?.state?.widget === "lesson"
      && active.state.current_word
      && normalizeWord(active.state.current_word) === normalizeWord(input.word)
      ? active.state.retry_count : 0;
  }
  if (active?.state?.widget === "lesson"
    && active.state.current_word
    && normalizeWord(active.state.current_word) === normalizeWord(input.word)) return active.state.retry_count + 1;
  return 1;
}

function persistedMeaning(item: VocabularyItem): string {
  return formatMeaningByPartOfSpeech(item.senses);
}

function persistedPartOfSpeech(item: VocabularyItem): string | undefined {
  return formatPartOfSpeech(item.senses);
}

export function validatePretestItems(
  items: PretestRenderItem[],
  todayWords: VocabularyItem[],
  completedLessonWords: ReadonlySet<string> = new Set(),
): PretestRenderItem[] {
  const eligible = filterNewWordsWithoutLessonHistory(todayWords, completedLessonWords);
  const eligibleIndex = new Map(eligible.map((word, index) => [normalizeWord(word.word), index]));
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const word = normalizeWord(item.word);
    if (seen.has(word)) throw new Error("PRETEST_WORD_DUPLICATE");
    seen.add(word);
    const expectedIndex = eligibleIndex.get(word);
    if (expectedIndex === undefined) throw new Error("PRETEST_WORD_NOT_ELIGIBLE");
    if (expectedIndex !== index) throw new Error("PRETEST_QUEUE_ORDER_INVALID");
  }
  if (eligible.length < 5 ? items.length !== eligible.length : items.length < 5) {
    throw new Error("PRETEST_ROUND_SIZE_INVALID");
  }
  return items.map((item) => {
    const persisted = todayWords.find((word) => normalizeWord(word.word) === normalizeWord(item.word));
    if (!persisted) throw new Error("PRETEST_WORD_NOT_ELIGIBLE");
    const meaning = persistedMeaning(persisted);
    const partOfSpeech = persistedPartOfSpeech(persisted);
    return {
      ...item,
      word: persisted.word,
      ...(persisted.ipa_us?.trim() ? { ipa: persisted.ipa_us.trim() } : {}),
      ...(partOfSpeech ? { part_of_speech: partOfSpeech } : {}),
      ...(meaning ? { meaning_zh: meaning } : {}),
    };
  });
}

export function assertLessonWordMatches(expectedWord: string | null, actualWord: string): void {
  if (!expectedWord || normalizeWord(expectedWord) !== normalizeWord(actualWord)) {
    throw new Error("LESSON_WORD_MISMATCH");
  }
}

function persistedExerciseActivity(state: StudyState): string | undefined {
  const payload = state.payload;
  const exercise = payload.mode === "feedback" && payload.exercise && typeof payload.exercise === "object"
    ? payload.exercise as Record<string, unknown>
    : payload.mode === "explain" && payload.exercise && typeof payload.exercise === "object"
      ? payload.exercise as Record<string, unknown> : null;
  const value = exercise?.activity_type ?? (payload.mode === "exercise" ? payload.activity_type : undefined);
  return typeof value === "string" ? value : undefined;
}

async function ensurePlannedFlow(
  flow: StudyState["flow"], queue: string[], db: ReturnType<typeof getDatabase>, userId: string,
  preserve?: { index: number; activity_type: string },
): Promise<StudyState["flow"]> {
  const saved = z.array(lessonExercisePlanSchema).length(queue.length).safeParse(flow.exercise_plans);
  if (saved.success) return flow;
  const exercise_plans = await planLessonQueue(queue, flow.relearn_words, db, userId,
    preserve ? { preserve_existing_activity: preserve } : {});
  return { ...flow, exercise_plans };
}

async function validateLessonWord(
  input: Exclude<LessonInput, { resume: true }>,
  active: StudySessionRow | null,
): Promise<{ date: string; active: StudySessionRow | null; flow?: StudyState["flow"] }> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  let resolvedActive = active;

  if (resolvedActive?.state?.widget === "lesson" && resolvedActive.state.flow.lesson_words === undefined) {
    resolvedActive = await normalizeLegacyLessonSession(resolvedActive, db, userId);
  }
  if (input.mode === "exercise" || input.mode === "feedback") {
    let state = resolvedActive?.state?.widget === "lesson" ? resolvedActive.state : null;
    let marker = state?.payload.consolidation === true
      ? z.object({
        consolidation_kind: z.enum(["translation", "translation_cn_to_en", "sentence"]),
        consolidation_trigger_round: z.number().int().positive(),
        consolidation_target_words: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
        consolidation_status: z.enum(["pending", "exercise", "feedback", "completed"]),
      }).superRefine((value, context) => {
        const validCount = value.consolidation_kind === "translation" && !state?.payload.consolidation_plan
          ? value.consolidation_target_words.length >= 2
          : value.consolidation_target_words.length <= 2;
        if (!validCount) context.addIssue({ code: "custom", message: "LESSON_CONSOLIDATION_TARGET_COUNT_INVALID" });
      }).safeParse(state.payload)
      : null;
    if (input.consolidation === true) {
      if (!state || !marker?.success || state.phase !== "lesson_complete"
        || marker.data.consolidation_status === "completed"
        || input.consolidation_kind !== marker.data.consolidation_kind) {
        throw new Error("LESSON_CONSOLIDATION_NOT_READY");
      }
      const savedPlan = lessonExercisePlanSchema.safeParse(state.payload.consolidation_plan ?? state.payload.plan);
      if (!savedPlan.success) {
        const savedActivity = persistedExerciseActivity(state);
        const fallbackActivity = marker.data.consolidation_kind === "translation" ? "translation_en_to_cn"
          : marker.data.consolidation_kind === "translation_cn_to_en" ? "translation_cn_to_en" : "sentence";
        const activity = lessonExercisePlanSchema.shape.planned_activity_type.parse(savedActivity ?? fallbackActivity);
        const candidates = await planLessonQueue(marker.data.consolidation_target_words, state.flow.relearn_words, db, userId);
        const anchorIndex = marker.data.consolidation_target_words.findIndex((word) => normalizeWord(word) === normalizeWord(state!.current_word!));
        const base = candidates[Math.max(0, anchorIndex)] ?? candidates[0];
        if (!base) throw new Error("LESSON_CONSOLIDATION_PLAN_MISSING");
        const reconstructed = lessonExercisePlanSchema.parse({
          ...base,
          plan_id: globalThis.crypto.randomUUID(),
          exercise_id: globalThis.crypto.randomUUID(),
          scope: "consolidation",
          word_id: base.word_id,
          target_word_ids: candidates.map((candidate) => candidate.word_id).slice(0, 3),
          planned_activity_type: activity,
          skill_goal: "保留旧会话已显示的综合任务并补齐技能证据关联",
          skill_ids: activity === "translation_en_to_cn" ? ["sentence_structure"]
            : activity === "translation_cn_to_en" ? ["target_sense_retrieval", "lexical_collocation"]
              : ["target_word_application"],
          hint_level: activity === "sentence" ? "context" : activity === "translation_cn_to_en" ? "meaning" : "none",
          estimated_seconds: 120,
          selection_reason: "旧会话兼容：恢复原综合题，不追算首次发布前的历史欠题。",
          coverage_exception_reason: "此任务在计划迁移前已建立，保留原题及轮换位置。",
        });
        const upgradedState = {
          ...state,
          payload: { ...state.payload, plan: reconstructed, consolidation_plan: reconstructed },
        };
        resolvedActive = resolvedActive?.updated_at
          ? await persistStudyStateIfRevision(upgradedState, resolvedActive.updated_at, db, userId, resolvedActive.id)
          : { ...resolvedActive!, state: upgradedState };
        state = upgradedState;
        marker = z.object({
          consolidation_kind: z.enum(["translation", "translation_cn_to_en", "sentence"]),
          consolidation_trigger_round: z.number().int().positive(),
          consolidation_target_words: z.array(z.string().trim().min(1).max(100)).max(3),
          consolidation_status: z.enum(["pending", "exercise", "feedback", "completed"]),
        }).safeParse(state.payload);
        if (!marker.success) throw new Error("LESSON_CONSOLIDATION_PLAN_MISSING");
      }
      const lessonWords = state.flow.lesson_words;
      const lastIndex = (lessonWords?.length ?? 0) - 1;
      if (!lessonWords || lessonWords.length === 0 || state.current_index !== lastIndex
        || !state.current_word || normalizeWord(state.current_word) !== normalizeWord(lessonWords[lastIndex] ?? "")) {
        throw new Error("LESSON_CONSOLIDATION_NOT_READY");
      }
      assertLessonWordMatches(state.current_word, input.word);
      const consolidationPlan = lessonExercisePlanSchema.safeParse(state.payload.consolidation_plan ?? state.payload.plan);
      const expectedActivity = consolidationPlan.success ? consolidationPlan.data.planned_activity_type
        : marker.data.consolidation_kind === "translation" ? "translation_en_to_cn"
          : marker.data.consolidation_kind === "translation_cn_to_en" ? "translation_cn_to_en" : "sentence";
      const words = marker.data.consolidation_target_words;
      if (input.mode === "exercise") {
        if (marker.data.consolidation_status !== "pending"
          && !(marker.data.consolidation_status === "exercise"
            && state.payload.mode === "exercise"
            && state.payload.activity_type === input.activity_type
            && state.payload.prompt === input.prompt)) {
          throw new Error("LESSON_CONSOLIDATION_ALREADY_RENDERED");
        }
        if (input.activity_type !== expectedActivity || !input.multiline) {
          throw new Error("LESSON_CONSOLIDATION_ACTIVITY_INVALID");
        }
        const included = words.filter((word) => containsWholeEnglishWord(input.prompt, word));
        if (expectedActivity === "translation_en_to_cn") {
          const count = input.prompt.toLocaleLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g)?.length ?? 0;
          if (count < 25 || count > 40 || (!consolidationPlan.success && included.length < 2)) throw new Error("LESSON_CONSOLIDATION_CONTENT_INVALID");
        } else if (expectedActivity === "translation_cn_to_en") {
          if (!/\p{Script=Han}/u.test(input.prompt)) throw new Error("LESSON_CONSOLIDATION_CONTENT_INVALID");
        } else if (included.length !== words.length) {
          throw new Error("LESSON_CONSOLIDATION_CONTENT_INVALID");
        }
      } else {
        const savedExercise = state.payload.mode === "feedback" ? state.payload.exercise : state.payload;
        const saved = lessonExercise.safeParse(projectPersistedFields(savedExercise, lessonExerciseKeys));
        if (!["exercise", "feedback"].includes(marker.data.consolidation_status)
          || !saved.success
          || saved.data.activity_type !== expectedActivity
          || input.exercise.activity_type !== expectedActivity
          || input.exercise.prompt !== saved.data.prompt) {
          throw new Error("LESSON_CONSOLIDATION_EXERCISE_MISSING");
        }
        if (!input.feedback.is_correct) {
          if (state.retry_count === 0 && (input.feedback.reveal_answer || input.feedback.reference_answer !== undefined)) {
            throw new Error("LESSON_CONSOLIDATION_FIRST_RETRY_MUST_HIDE_ANSWER");
          }
          if (state.retry_count >= 1 && (!input.feedback.reveal_answer || !input.feedback.reference_answer?.trim())) {
            throw new Error("LESSON_CONSOLIDATION_SECOND_MISS_MUST_REVEAL_ANSWER");
          }
        }
      }
      return { date: state.date, active: resolvedActive, flow: state.flow };
    }
    if (marker?.success && marker.data.consolidation_status !== "completed") {
      throw new Error("LESSON_CONSOLIDATION_REQUIRED");
    }
    if (input.wrapup === true) {
      const lessonWords = state?.flow.lesson_words;
      const lastIndex = (lessonWords?.length ?? 0) - 1;
      if (!state || state.phase !== "lesson_complete" || !lessonWords || lessonWords.length === 0
        || state.current_index !== lastIndex
        || !state.current_word
        || normalizeWord(state.current_word) !== normalizeWord(lessonWords[lastIndex] ?? "")) {
        throw new Error("LESSON_WRAPUP_NOT_READY");
      }
      assertLessonWordMatches(state.current_word, input.word);
      if (input.mode === "exercise" && input.activity_type !== "translation_en_to_cn") {
        throw new Error("LESSON_WRAPUP_ACTIVITY_INVALID");
      }
      if (input.mode === "feedback"
        && (input.exercise.activity_type !== "translation_en_to_cn"
          || (state.payload.mode !== "exercise" && state.payload.mode !== "feedback")
          || state.payload.wrapup !== true)) {
        throw new Error("LESSON_WRAPUP_EXERCISE_MISSING");
      }
      return { date: state.date, active: resolvedActive, flow: state.flow };
    }
    if (state?.phase === "lesson_complete") throw new Error("LESSON_WRAPUP_REQUIRED");
    if (state?.flow.lesson_words
      && !isLessonCursorAtCurrentWord(state.flow.lesson_words, state.current_word, state.current_index)) {
      throw new Error("LESSON_CURSOR_MISMATCH");
    }
    assertLessonWordMatches(state?.current_word ?? null, input.word);
    const currentActivity = state ? persistedExerciseActivity(state) : undefined;
    const flow = state?.flow && state.flow.lesson_words
      ? await ensurePlannedFlow(state.flow, state.flow.lesson_words, db, userId,
        currentActivity ? { index: state.current_index, activity_type: currentActivity } : undefined)
      : state?.flow;
    return { date: resolvedActive?.state?.date ?? await getStudyDate(), active: resolvedActive, flow };
  }

  if (resolvedActive?.state?.widget === "lesson") {
    const state = resolvedActive.state;
    const lessonWords = state.flow.lesson_words;
    if (!lessonWords) throw new Error("LESSON_QUEUE_MISSING");
    if (!state.current_word
      || !isLessonCursorAtCurrentWord(lessonWords, state.current_word, state.current_index)) {
      throw new Error("LESSON_CURSOR_MISMATCH");
    }
    const expected = state.payload.mode === "generation_error"
      ? lessonWordAt(lessonWords, state.current_index)
      : lessonWordAt(lessonWords, state.current_index + 1);
    assertLessonWordMatches(expected, input.word);
    const activity = persistedExerciseActivity(state);
    return { date: state.date, active: resolvedActive, flow: await ensurePlannedFlow(state.flow, lessonWords, db, userId,
      activity ? { index: state.current_index, activity_type: activity } : undefined) };
  }
  if (resolvedActive?.state?.widget === "review" && resolvedActive.state.phase === "review_complete") {
    const state = resolvedActive.state;
    if (state.flow.lesson_words === undefined) {
      const todayWords = await getTodayWords(state.date, db, userId);
      resolvedActive = await freezeLessonQueueForSession(resolvedActive, todayWords, db, userId);
    }
    const lessonWords = resolvedActive.state?.flow.lesson_words ?? [];
    assertLessonWordMatches(lessonWordAt(lessonWords, 0), input.word);
    const flow = resolvedActive.state?.flow;
    return { date: state.date, active: resolvedActive, flow: flow?.lesson_words
      ? await ensurePlannedFlow(flow, flow.lesson_words, db, userId) : flow };
  }
  if (resolvedActive?.state?.widget === "pretest") {
    const state = normalizeStudyStateForRead(resolvedActive.state);
    if (state.phase !== "pretest_complete") throw new Error("PRETEST_NOT_COMPLETE");
    resolvedActive = { ...resolvedActive, state };
    if (state.flow.lesson_words === undefined) {
      const todayWords = await getTodayWords(state.date, db, userId);
      resolvedActive = await freezeLessonQueueForSession(resolvedActive, todayWords, db, userId);
    }
    const lessonWords = resolvedActive.state?.flow.lesson_words ?? [];
    assertLessonWordMatches(lessonWordAt(lessonWords, 0), input.word);
    const flow = resolvedActive.state?.flow;
    return { date: state.date, active: resolvedActive, flow: flow?.lesson_words
      ? await ensurePlannedFlow(flow, flow.lesson_words, db, userId) : flow };
  }
  const date = await getStudyDate();
  const todayWords = await getTodayWords(date);
  const completedLessonWords = await getCompletedLessonWords(db, userId);
  const lessonWords = buildLessonWords(
    [],
    todayWords,
    completedLessonWords,
    active?.state?.flow.pretest_familiar_words ?? [],
  );
  assertLessonWordMatches(lessonWordAt(lessonWords, 0), input.word);
  const flow = { relearn_words: [], pretest_familiar_words: [], lesson_words: lessonWords };
  return { date, active: null, flow: await ensurePlannedFlow(flow, lessonWords, db, userId) };
}

export function reviewWidgetItemFromVocabulary(item: ReviewVocabularyItem): ReviewWidgetItem {
  const senses = Array.isArray(item.senses) ? item.senses : [];
  const meaning = formatMeaningByPartOfSpeech(senses);
  if (!meaning) throw new Error(`Review word ${item.word} has no persisted meaning.`);
  const partOfSpeech = formatPartOfSpeech(senses);
  return reviewWidgetItemSchema.parse({
    word: item.word,
    meaning_zh: meaning,
    ...(partOfSpeech ? { part_of_speech: partOfSpeech } : {}),
    error_layers: item.error_layers,
    is_due: item.is_due,
    review_kind: item.review_kind,
    next_review_at: item.next_review_at,
    direction: "cn_to_en",
  });
}

export function buildReviewWidgetItems(
  candidates: ReviewVocabularyItem[],
  limit = REVIEW_SESSION_MAX,
): ReviewWidgetItem[] {
  const items: ReviewWidgetItem[] = [];
  for (const candidate of candidates) {
    try {
      items.push(reviewWidgetItemFromVocabulary(candidate));
    } catch (error) {
      const expected = `Review word ${candidate.word} has no persisted meaning.`;
      if (!(error instanceof Error) || error.message !== expected) throw error;
      console.warn(`Review word ${candidate.word} has no persisted meaning; skipped.`);
    }
    if (items.length >= limit) break;
  }
  return items;
}

export async function buildReviewWidgetPayload(currentIndex = 0, expectedRevision?: string | null): Promise<ReviewWidgetPayload> {
  void currentIndex;
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const active = await getActiveStudySession(db, userId);
  if (expectedRevision !== undefined && (active?.updated_at ?? null) !== expectedRevision) {
    throw new Error("STALE_STUDY_STATE");
  }
  if (active?.state?.widget === "review" && active.state.phase !== "review_complete") {
    const resumed = reviewWidgetPayloadSchema.safeParse(widgetPayloadWithState(active.state.payload, active.state));
    if (!resumed.success) throw new Error("Saved review session payload is invalid.");
    return normalizeReviewWidgetPayload(resumed.data);
  }
  if (active?.state && active.state.widget !== "review") {
    throw new Error("A different WordLoop study session is already active.");
  }

  const completedReviewState = active?.state?.widget === "review" && active.state.phase === "review_complete"
    ? active.state
    : null;
  if (completedReviewState) throw new Error("REVIEW_STAGE_COMPLETE: 本组复习已完成，请继续预测试或补学。");
  const { rollingReview } = await getDueReviewSelection(REVIEW_SESSION_MAX, db, userId);
  const candidates = rollingReview;
  if (candidates.length === 0) throw new Error("No review words are currently due.");
  const items = buildReviewWidgetItems(candidates, REVIEW_SESSION_MAX);
  if (items.length === 0) throw new Error("到期复习词缺少释义数据。");
  const payload = reviewWidgetPayloadSchema.parse({
    widget: "review",
    items,
    title: "复习",
  });
  const state = makeStudyState({
    date: await getStudyDate(db, userId),
    widget: "review",
    phase: "review",
    current_word: items[0]?.word ?? null,
    current_index: 0,
    retry_count: 0,
    flow: { relearn_words: [] },
    payload,
  });
  const persisted = expectedRevision === undefined
    ? await persistStudyState(state, db, userId, active)
    : await persistStudyStateIfRevision(state, expectedRevision, db, userId, active?.id);
  return normalizeReviewWidgetPayload(reviewWidgetPayloadSchema.parse(widgetPayloadWithState(persisted.state?.payload ?? payload, persisted.state ?? state)));
}

export function registerRenderTools(server: McpServer): void {
  registerAppTool(server, "render_word_import", {
    title: "打开词表导入",
    description: "显示一次性扇贝词书迁移界面，包含当前词书、预览、完整导入和手动导入备用方式。",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: WIDGET_URIS.import } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => ({ widget: "import" })));

  registerAppTool(server, "render_pretest_widget", {
    title: "打开预测试",
    description: "显示一张完整的 1–7 题新词预测试卡片。预测试只使用两种固定题型：cn_to_en=给中文核心义并要求写英文单词；en_definition=给英文单词和词性并要求用简单英文解释。每题可传美式 IPA、词性和简明中文核心义供后续学习使用，但预测试答题阶段只显示当前题型需要的内容；prompt 仅为兼容字段，Widget 不渲染它。卡片会恢复已保存结果，支持一键标记不会、卡内批改和本轮发音，不要逐题在聊天区重复反馈。",
    inputSchema: pretestToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.pretest } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const parsedInput = pretestInput.parse(input);
    if ("resume" in parsedInput) return resumablePayload(await getActiveStudySession(), "pretest");
    const date = await getStudyDate();
    const active = await getActiveStudySession();
    const [todayWords, completedLessonWords] = await Promise.all([
      getTodayWords(date),
      getCompletedLessonWords(),
    ]);
    const items = validatePretestItems(parsedInput.items, todayWords, completedLessonWords);
    const budget = await getLearningBudget();
    const allowed = new Set(filterNewWordsWithoutLessonHistory(todayWords, completedLessonWords)
      .slice(0, newWordAdmissionLimit(budget)).map(word => normalizeWord(word.word)));
    if (items.some(item => !allowed.has(normalizeWord(item.word)))) throw new Error("DAILY_NEW_WORD_ALLOWANCE_REACHED");
    const payload = { widget: "pretest", ...parsedInput, source: "new_word", items };
    return saveWidgetState({
      date,
      knownActive: active,
      widget: "pretest",
      phase: "pretest",
      current_word: items[0]?.word ?? null,
      current_index: 0,
      retry_count: 0,
      payload,
    });
  }));

  registerAppTool(server, "render_review_widget", {
    title: "打开复习",
    description: "兼容旧客户端。传入 items 会被忽略，实际复习队列由 WordLoop backend 生成：只取 next_review_at <= now 的 due-only snapshot，单次最多 200 张；模型不能传入、替换或排序复习词。",
    inputSchema: legacyReviewToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.review } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => buildReviewWidgetPayload()));

  registerAppTool(server, "render_review_widget_v2", {
    title: "打开复习（v2）",
    description: "新客户端使用的复习卡片。复习词和顺序始终由 WordLoop backend 从 next_review_at <= now 的 immutable snapshot 生成，单次最多 200 张；模型不能传入、替换或排序 items。",
    inputSchema: reviewV2ToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.review } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => buildReviewWidgetPayload()));

  registerAppTool(server, "render_learning_dashboard", {
    title: "显示学习进度",
    description: "显示今日词汇进度和学习操作。用户询问进度时直接调用此工具；工具内部先确保今日队列，再从 WordLoop 实时读取一次进度。卡片成功显示后保持聊天区安静，不要重复进度或操作说明。",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: WIDGET_URIS.dashboard } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => {
    await ensureTodayQueue();
    const [progress, cadence] = await Promise.all([getProgress(), getLessonCadence()]);
    const pending = cadence.pending_task;
    return {
      widget: "dashboard",
      progress,
      pending_consolidation: pending ? {
        activity_type: pending.plan.planned_activity_type,
        label: pending.plan.planned_activity_type === "translation_en_to_cn" ? "长难句英译中"
          : pending.plan.planned_activity_type === "translation_cn_to_en" ? "完整中译英"
            : pending.plan.planned_activity_type === "sentence" ? "情境造句" : "应用任务",
        estimated_seconds: pending.plan.estimated_seconds,
      } : null,
    };
  }));

  registerAppTool(server, "render_lesson_widget", {
    title: "打开单词学习",
    description: "显示一个单词的讲解、练习或批改卡片。服务端 exercisePlanner 是 Web 与 MCP 共用的唯一最终选题入口；严格使用已保存 planned_activity_type、目标、skill_ids 和 exercise_id。Lesson answer grading must terminate in render_lesson_widget mode=feedback; chat-only grading is invalid. 正式学习内容、输入和反馈都留在卡片内；例句与练习必须使用不同语境。恢复旧会话时沿用当前单词和已显示题目，导航由 backend 提供。Lesson 轮末只有 backend 返回 pending consolidation 且用户选择“做一道”时才生成任务；按持久化计划精确使用 translation_en_to_cn、translation_cn_to_en 或 sentence，不能自行推断 cadence、换题型或额外出题。固定答案题由服务端判分并只保存在服务端；综合任务不调用 FSRS。第一次核心错误须指出具体片段并给自纠方向，但隐藏完整答案；第二次仍错才展示参考表达。技能结果仅记录有独立证据的技能，不能复制整体对错。Widget 成功显示后不要在聊天区重复题面或反馈。",
    inputSchema: lessonToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.lesson } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const toolInput = lessonToolInputVariants.parse(input);
    if ("resume" in toolInput) return resumableLessonPayload(await getActiveStudySession());
    let active = await getActiveStudySession();
    let parsedInput: Exclude<LessonInput, { resume: true }>;
    if (toolInput.mode === "feedback") {
      const normalizedState = active?.state ? normalizeStudyStateForRead(active.state) : null;
      if (active && normalizedState) active = { ...active, state: normalizedState };
      const storedPayload = normalizedState?.widget === "lesson" ? normalizedState.payload : null;
      const storedExercise = storedPayload?.mode === "feedback"
        ? projectPersistedFields(storedPayload.exercise, lessonExerciseKeys)
        : storedPayload?.mode === "exercise"
          ? projectPersistedFields(storedPayload, lessonExerciseKeys)
          : null;
      const exercise = storedExercise ? lessonExercise.safeParse(storedExercise) : null;
      const progress = typeof storedPayload?.progress === "string" && storedPayload.progress.trim()
        ? storedPayload.progress
        : "当前练习";
      if (toolInput.consolidation === true && !exercise?.success) {
        throw new Error("LESSON_CONSOLIDATION_EXERCISE_MISSING");
      }
      if (toolInput.wrapup === true && !exercise?.success) {
        await validateLessonWord({
          mode: "feedback",
          wrapup: true,
          word: toolInput.word,
          progress,
          exercise: { activity_type: "", instruction: "", prompt: "", multiline: false },
          feedback: toolInput.feedback,
        }, active);
      }
      parsedInput = feedbackPayload.parse({
        mode: "feedback",
        ...(toolInput.wrapup === true ? { wrapup: true } : {}),
        ...(toolInput.consolidation === true ? { consolidation: true, consolidation_kind: toolInput.consolidation_kind } : {}),
        ...persistedLessonProfileFields(normalizedState ?? undefined, toolInput.word),
        word: toolInput.word,
        progress,
        exercise: exercise?.success ? exercise.data : undefined,
        feedback: toolInput.feedback,
      });
    } else {
      parsedInput = lessonPayload.parse(toolInput);
    }
    const validated = await validateLessonWord(parsedInput, active);
    const currentIndex = lessonRenderIndex(validated.active, parsedInput);
    const lessonWords = validated.flow?.lesson_words;
    if (!lessonWords) throw new Error("LESSON_QUEUE_MISSING");
    const savedState = validated.active?.state?.widget === "lesson" ? validated.active.state : null;
    const plannedPlan = parsedInput.consolidation === true
      ? lessonExercisePlanSchema.safeParse(savedState?.payload.consolidation_plan ?? savedState?.payload.plan)
      : lessonExercisePlanSchema.safeParse(validated.flow?.exercise_plans?.[currentIndex]);
    const plannedActivity = parsedInput.mode === "explain" ? parsedInput.exercise.activity_type
      : parsedInput.mode === "exercise" ? parsedInput.activity_type : parsedInput.exercise.activity_type;
    if (plannedPlan.success && plannedPlan.data.planned_activity_type !== plannedActivity) {
      throw new Error(`LESSON_PLAN_ACTIVITY_MISMATCH:${plannedPlan.data.planned_activity_type}`);
    }
    if (parsedInput.consolidation === true && !plannedPlan.success) throw new Error("LESSON_CONSOLIDATION_PLAN_MISSING");
    let atomicSubmission: { submission_id: string; plan: LessonExercisePlan; hint_used: boolean } | undefined;
    if (parsedInput.mode === "feedback" && !parsedInput.wrapup && plannedPlan.success) {
      if (toolInput.mode !== "feedback") throw new Error("PLANNED_SUBMISSION_ID_REQUIRED");
      const legacyPreservedPlan = plannedPlan.data.selection_reason.startsWith("旧会话兼容：");
      if ((!toolInput.submission_id || !toolInput.plan_id || !toolInput.exercise_id) && !legacyPreservedPlan) {
        throw new Error("PLANNED_SUBMISSION_ID_REQUIRED");
      }
      if ((toolInput.plan_id !== plannedPlan.data.plan_id || toolInput.exercise_id !== plannedPlan.data.exercise_id)
        && !legacyPreservedPlan) {
        throw new Error("PLANNED_SUBMISSION_ID_MISMATCH");
      }
      atomicSubmission = { submission_id: toolInput.submission_id ?? globalThis.crypto.randomUUID(), plan: plannedPlan.data, hint_used: savedState?.payload.hint_used === true || toolInput.hint_used };
    }
    if (plannedPlan.success && plannedPlan.data.scope === "lesson"
      && !plannedPlan.data.selection_reason.startsWith("旧会话兼容：")) {
      const proposedExercise = lessonGenerationSchema.shape.exercise.parse(parsedInput.mode === "explain" ? parsedInput.exercise
        : parsedInput.mode === "exercise" ? parsedInput : parsedInput.exercise);
      const profile = lessonProfile.safeParse(savedState?.payload.lesson_profile);
      const issues = validateGeneratedLessonExercise({
        word: parsedInput.word,
        lesson_profile: profile.success ? profile.data : "quick_recall",
        error_focus: plannedPlan.data.error_focus,
        plan: plannedPlan.data,
      }, {
        example_en: parsedInput.mode === "explain" ? parsedInput.example_en : String(savedState?.payload.example_en ?? ""),
        exercise: proposedExercise,
      });
      if (issues.length > 0) throw new Error(`LESSON_PLAN_CONTENT_INVALID:${issues[0]?.path.join(".")}:${issues[0]?.message}`);
    }
    const navigation = buildLessonNavigation(lessonWords, currentIndex, parsedInput.word);
    const {
      lesson_profile: _clientLessonProfile,
      error_focus: _clientErrorFocus,
      consolidation: _clientConsolidation,
      consolidation_kind: _clientConsolidationKind,
      consolidation_trigger_round: _clientConsolidationRound,
      consolidation_target_words: _clientConsolidationWords,
      consolidation_status: _clientConsolidationStatus,
      ...content
    } = parsedInput;
    const savedConsolidation = validated.active?.state?.widget === "lesson"
      && validated.active.state.payload.consolidation === true
      ? validated.active.state.payload
      : null;
    const consolidationFields = parsedInput.consolidation === true && savedConsolidation
      ? {
        consolidation: true as const,
        consolidation_kind: savedConsolidation.consolidation_kind,
        consolidation_trigger_round: savedConsolidation.consolidation_trigger_round,
        consolidation_target_words: savedConsolidation.consolidation_target_words,
        consolidation_plan: savedConsolidation.consolidation_plan ?? savedConsolidation.plan,
        consolidation_status: parsedInput.mode === "exercise" ? "exercise" : "feedback",
        progress: savedConsolidation.consolidation_kind === "translation_cn_to_en" ? "应用巩固 · 中译英"
          : savedConsolidation.consolidation_kind === "sentence" ? "应用巩固 · 情境造句" : "应用巩固 · 长难句英译中",
      }
      : {};
    const payload = lessonWidgetPayload({
      widget: "lesson",
      ...content,
      ...(plannedPlan.success ? { plan: plannedPlan.data } : {}),
      ...consolidationFields,
      ...persistedLessonProfileFields(validated.active?.state ?? undefined, parsedInput.word),
      navigation,
    });
    return saveWidgetState({
      date: validated.date,
      knownActive: validated.active,
      widget: "lesson",
      phase: parsedInput.mode !== "explain" && (parsedInput.wrapup === true || parsedInput.consolidation === true)
        ? "lesson_complete"
        : lessonPhaseByMode[parsedInput.mode],
      current_word: parsedInput.word,
      current_index: currentIndex,
      retry_count: parsedInput.mode === "feedback" ? lessonRetryCount(validated.active, parsedInput) : validated.active?.state?.widget === "lesson" && validated.active.state.current_word === parsedInput.word ? validated.active.state.retry_count : 0,
      flow: validated.flow,
      payload,
      ...(atomicSubmission ? { atomicSubmission } : {}),
    });
  }));

  registerAppTool(server, "render_pronunciation_cards", {
    title: "显示发音卡片",
    description: "仅用于独立发音查询，显示由用户点击播放的美式英语发音卡片。预测试已经进入内嵌发音流程后禁止调用此工具。",
    inputSchema: z.object({ words: z.array(pronunciationWord).min(1).max(7) }),
    _meta: { ui: { resourceUri: WIDGET_URIS.pronunciation } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "pronunciation", ...input })));

  registerAppTool(server, "render_dictation_widget", {
    title: "打开听写",
    description: "打开单词听写时传 mode=words 和 1–7 个 words；听写只播放音频并在提交后显示拼写反馈。旧 text payload 继续支持播放与显示/隐藏原文。",
    inputSchema: dictationToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.dictation } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const parsedInput = dictationInput.parse(input);
    if ("resume" in parsedInput) return resumablePayload(await getActiveStudySession(), "dictation");
    const active = await getActiveStudySession();
    const payload = {
      widget: "dictation",
      ...parsedInput,
      ...("mode" in parsedInput && parsedInput.mode === "words" ? { current_index: parsedInput.current_index ?? 0 } : {}),
    };
    return saveWidgetState({
      date: active?.state?.date ?? await getStudyDate(),
      knownActive: active,
      widget: "dictation",
      phase: "dictation",
      current_word: null,
      current_index: 0,
      retry_count: 0,
      payload,
    });
  }));
}
