import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { ensureTodayQueue } from "../services/dailyQueue.js";
import { getProgress } from "../services/progress.js";
import {
  getDueReviewSelection,
} from "../services/review.js";
import {
  freezeLessonQueueForSession,
  getActiveStudySession,
  getStudyDate,
  makeStudyState,
  normalizeLegacyLessonSession,
  normalizeStudyStateForRead,
  persistStudyState,
} from "../services/studySessions.js";
import { getTodayWords } from "../services/words.js";
import {
  buildLessonWords,
  buildLessonNavigation,
  isLessonCursorAtCurrentWord,
  lessonWordAt,
} from "../services/lessonQueue.js";
import { normalizeWord } from "../services/wordNormalization.js";
import type { ReviewVocabularyItem, StudyPhase, StudySessionRow, StudyState, VocabularyItem } from "../types.js";
import {
  REVIEW_SESSION_MAX,
  LESSON_WIDGET_VERSION,
  reviewWidgetItemSchema,
  reviewWidgetPayloadSchema,
  type ReviewWidgetItem,
  type ReviewWidgetPayload,
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
  lesson: "ui://wordloop/lesson-v8.html",
} as const;

/** Resource aliases kept for conversations that still reference old Lesson URIs. */
export const LEGACY_WIDGET_URIS = {
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
  part_of_speech: z.string().trim().min(1).max(40).optional(),
  meaning_zh: z.string().trim().min(1).max(240).optional(),
}).strict();
const pretestItem = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120).describe("American English IPA, including stress marks"),
  part_of_speech: z.string().trim().min(1).max(40).describe("Concise part of speech, such as adj. or v."),
  meaning_zh: z.string().trim().min(1).max(240).describe("Concise Chinese core meaning"),
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
const lessonExercise = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.activity_type === "cloze" && !value.prompt.includes("___")) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["prompt"] });
  }
  if (value.activity_type === "translation_cn_to_en" && !/\p{Script=Han}/u.test(value.prompt)) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["prompt"] });
  }
  if (value.activity_type === "translation_en_to_cn" && !/[A-Za-z]/.test(value.prompt)) {
    context.addIssue({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["prompt"] });
  }
});
const lessonFeedback = z.object({
  is_correct: z.boolean(),
  user_answer: z.string().max(4000),
  error_layer: z.string().trim().max(80).optional().describe("具体错误层级：词义、搭配、语法、发音或拼写。"),
  message: z.string().trim().max(1000).optional().describe("错误时必须指出用户答案中的具体错误片段或位置，不要只写笼统的错误数量。"),
  reference_answer: z.string().trim().max(4000).optional(),
  explanation: z.string().trim().max(4000).optional().describe("错误时说明错因和下一步改哪里/怎么改；第一次错误只能给自纠提示，不得给完整改后句。"),
  reveal_answer: z.boolean(),
}).strict();
const lessonCommon = {
  title: z.string().trim().max(120).optional(),
};
const explainPayload = z.object({
  ...lessonCommon,
  mode: z.literal("explain"),
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(40),
  meaning_zh: z.string().trim().min(1).max(240),
  collocations: z.array(z.string().trim().min(1).max(200)).max(8),
  derivations: z.array(z.string().trim().min(1).max(200)).max(8),
  example_en: z.string().trim().min(1).max(1000),
  note: z.string().trim().min(1).max(1000),
  exercise: lessonExercise,
}).strict();
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
}).strict();
const feedbackPayload = z.object({
  ...lessonCommon,
  mode: z.literal("feedback"),
  wrapup: z.literal(true).optional(),
  word: z.string().trim().min(1).max(100),
  progress: z.string().trim().min(1).max(40),
  exercise: lessonExercise,
  feedback: lessonFeedback,
}).strict();
const lessonPayload = z.discriminatedUnion("mode", [explainPayload, exercisePayload, feedbackPayload]);
const lessonInput = z.union([lessonPayload, z.object({ resume: z.literal(true) }).strict()]);
const lessonToolInputSchema = z.object({
  resume: z.literal(true).optional(),
  mode: z.enum(["explain", "exercise", "feedback"]).optional(),
  wrapup: z.literal(true).optional(),
  title: z.string().trim().max(120).optional(),
  word: z.string().trim().min(1).max(100).optional(),
  ipa: z.string().trim().min(1).max(120).optional(),
  part_of_speech: z.string().trim().min(1).max(40).optional(),
  meaning_zh: z.string().trim().min(1).max(240).optional(),
  collocations: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  derivations: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  example_en: z.string().trim().min(1).max(1000).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
  progress: z.string().trim().min(1).max(40).optional(),
  activity_type: z.string().trim().min(1).max(80).optional(),
  instruction: z.string().trim().min(1).max(300).optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  multiline: z.boolean().optional(),
  exercise: lessonExercise.optional(),
  feedback: lessonFeedback.optional(),
}).strict();
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
  meaning_zh: z.string().trim().min(1).max(240).describe("Concise Chinese core meaning"),
  part_of_speech: z.string().trim().max(40).optional(),
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

const lessonExerciseKeys = ["activity_type", "instruction", "prompt", "multiline"] as const;
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

function widgetPayloadWithState(payload: Record<string, unknown>, state: StudyState): Record<string, unknown> {
  return { ...payload, widget: state.widget, phase: state.phase, current_index: state.current_index };
}

function lessonWidgetPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, widget_version: LESSON_WIDGET_VERSION };
}

function resumablePayload(session: StudySessionRow | null, widget: StudyState["widget"]): Record<string, unknown> {
  const state = session?.state ? normalizeStudyStateForRead(session.state) : null;
  if (!state || state.widget !== widget) {
    throw new Error(`No resumable active ${widget} study session.`);
  }
  return widgetPayloadWithState(state.payload, state);
}

async function resumableLessonPayload(session: StudySessionRow | null): Promise<Record<string, unknown>> {
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

  const navigation = buildLessonNavigation(
    resolved.flow.lesson_words,
    resolved.current_index,
    resolved.current_word,
  );
  // Persisted Lesson payloads from older versions may contain extra keys in
  // nested exercise/feedback objects. The Widget keeps those nested schemas
  // strict, so project only their canonical fields on resume while retaining
  // unknown top-level fields for forward compatibility.
  const normalizedPayload = normalizePersistedLessonPayload(resolved.payload);
  const payload = lessonWidgetPayload({ ...normalizedPayload, navigation });
  const payloadChanged = JSON.stringify(resolved.payload) !== JSON.stringify(normalizedPayload);
  const navigationChanged = JSON.stringify(resolved.payload.navigation) !== JSON.stringify(navigation);
  const versionChanged = resolved.payload.widget_version !== LESSON_WIDGET_VERSION;
  if ((payloadChanged || navigationChanged || versionChanged) && resolvedSession) {
    resolvedSession = await persistStudyState({ ...resolved, payload }, db, userId, resolvedSession);
    resolved = resolvedSession.state ? normalizeStudyStateForRead(resolvedSession.state) : { ...resolved, payload };
  } else {
    resolved = { ...resolved, payload };
  }
  return widgetPayloadWithState(resolved.payload, resolved);
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
}): Promise<Record<string, unknown>> {
  const { date, knownActive, flow, ...stateInput } = input;
  const state = makeStudyState({
    date: date ?? await getStudyDate(),
    flow: flow ?? knownActive?.state?.flow,
    ...stateInput,
  });
  await persistStudyState(state, getDatabase(), getAuthenticatedUserId(), knownActive);
  return widgetPayloadWithState(input.payload, state);
}

function lessonRenderIndex(
  active: StudySessionRow | null,
  input: Exclude<LessonInput, { resume: true }>,
): number {
  if (active?.state?.widget !== "lesson") return 0;
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
  return (Array.isArray(item.senses) ? item.senses : [])
    .map((sense) => (typeof sense?.definition_cn === "string" ? sense.definition_cn.trim() : ""))
    .filter(Boolean)
    .join("；");
}

function persistedPartOfSpeech(item: VocabularyItem): string | undefined {
  const value = (Array.isArray(item.senses) ? item.senses : []).find((sense) => typeof sense?.pos === "string" && sense.pos.trim())?.pos.trim();
  return value || undefined;
}

export function validatePretestItems(
  items: PretestRenderItem[],
  todayWords: VocabularyItem[],
): PretestRenderItem[] {
  const eligible = todayWords.filter((word) => word.status === "new" && !word.mastered);
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
    const state = resolvedActive?.state?.widget === "lesson" ? resolvedActive.state : null;
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
      if (input.mode === "exercise" && input.activity_type !== "sentence") {
        throw new Error("LESSON_WRAPUP_ACTIVITY_INVALID");
      }
      if (input.mode === "feedback"
        && (input.exercise.activity_type !== "sentence"
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
    return { date: resolvedActive?.state?.date ?? await getStudyDate(), active: resolvedActive, flow: state?.flow };
  }

  if (resolvedActive?.state?.widget === "lesson") {
    const state = resolvedActive.state;
    const lessonWords = state.flow.lesson_words;
    if (!lessonWords) throw new Error("LESSON_QUEUE_MISSING");
    if (!state.current_word
      || !isLessonCursorAtCurrentWord(lessonWords, state.current_word, state.current_index)) {
      throw new Error("LESSON_CURSOR_MISMATCH");
    }
    const expected = lessonWordAt(lessonWords, state.current_index + 1);
    assertLessonWordMatches(expected, input.word);
    return { date: state.date, active: resolvedActive, flow: state.flow };
  }
  if (resolvedActive?.state?.widget === "review" && resolvedActive.state.phase === "review_complete") {
    const state = resolvedActive.state;
    if (state.flow.lesson_words === undefined) {
      const todayWords = await getTodayWords(state.date, db, userId);
      resolvedActive = await freezeLessonQueueForSession(resolvedActive, todayWords, db, userId);
    }
    const lessonWords = resolvedActive.state?.flow.lesson_words ?? [];
    assertLessonWordMatches(lessonWordAt(lessonWords, 0), input.word);
    return { date: state.date, active: resolvedActive, flow: resolvedActive.state?.flow };
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
    return { date: state.date, active: resolvedActive, flow: resolvedActive.state?.flow };
  }
  const date = await getStudyDate();
  const todayWords = await getTodayWords(date);
  const lessonWords = buildLessonWords([], todayWords);
  assertLessonWordMatches(lessonWordAt(lessonWords, 0), input.word);
  return { date, active: null, flow: { relearn_words: [], lesson_words: lessonWords } };
}

export function reviewWidgetItemFromVocabulary(item: ReviewVocabularyItem): ReviewWidgetItem {
  const senses = Array.isArray(item.senses) ? item.senses : [];
  const meaning = senses.map((sense) => typeof sense?.definition_cn === "string" ? sense.definition_cn.trim() : "").filter(Boolean).join("；");
  if (!meaning) throw new Error(`Review word ${item.word} has no persisted meaning.`);
  const partOfSpeech = senses.find((sense) => typeof sense?.pos === "string" && sense.pos.trim())?.pos.trim();
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

export async function buildReviewWidgetPayload(currentIndex = 0): Promise<ReviewWidgetPayload> {
  void currentIndex;
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const active = await getActiveStudySession(db, userId);
  if (active?.state?.widget === "review") {
    const resumed = reviewWidgetPayloadSchema.safeParse(widgetPayloadWithState(active.state.payload, active.state));
    if (!resumed.success) throw new Error("Saved review session payload is invalid.");
    return resumed.data;
  }
  if (active?.state) throw new Error("A different WordLoop study session is already active.");

  const { rollingReview } = await getDueReviewSelection(REVIEW_SESSION_MAX, db, userId);
  if (rollingReview.length === 0) throw new Error("No review words are currently due.");
  const items = buildReviewWidgetItems(rollingReview, REVIEW_SESSION_MAX);
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
  const persisted = await persistStudyState(state, db, userId, active);
  return reviewWidgetPayloadSchema.parse(widgetPayloadWithState(persisted.state?.payload ?? payload, persisted.state ?? state));
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
    const todayWords = await getTodayWords(date);
    const items = validatePretestItems(parsedInput.items, todayWords);
    const payload = { widget: "pretest", ...parsedInput, items };
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
    return { widget: "dashboard", progress: await getProgress() };
  }));

  registerAppTool(server, "render_lesson_widget", {
    title: "打开单词学习",
    description: "显示一个单词的讲解、练习或批改卡片。Lesson answer grading must terminate in render_lesson_widget mode=feedback; chat-only grading is invalid. Reuse the current word and exercise; backend supplies navigation. 正式学习内容、输入和反馈都留在卡片内；例句与练习必须是不同语境。收到 WORDLOOP_ROUND_COMPLETE 时必须在此工具中用 mode=exercise、wrapup=true 显示唯一长难句收尾题，用户作答后再用 mode=feedback、wrapup=true 显示批改；不要把长句只写在聊天区，也不要提前 finish_study_session。错误反馈第一次必须指出具体错误片段/位置并给出自纠方向，但不公布完整参考句；连续第二次仍错才公布答案。成功显示后不要在聊天区重复教学正文或操作说明。",
    inputSchema: lessonToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.lesson } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const parsedInput = lessonInput.parse(input);
    if ("resume" in parsedInput) return resumableLessonPayload(await getActiveStudySession());
    const active = await getActiveStudySession();
    const validated = await validateLessonWord(parsedInput, active);
    const currentIndex = lessonRenderIndex(validated.active, parsedInput);
    const lessonWords = validated.flow?.lesson_words;
    if (!lessonWords) throw new Error("LESSON_QUEUE_MISSING");
    const navigation = buildLessonNavigation(lessonWords, currentIndex, parsedInput.word);
    const payload = lessonWidgetPayload({ widget: "lesson", ...parsedInput, navigation });
    return saveWidgetState({
      date: validated.date,
      knownActive: validated.active,
      widget: "lesson",
      phase: parsedInput.mode !== "explain" && parsedInput.wrapup === true
        ? "lesson_complete"
        : lessonPhaseByMode[parsedInput.mode],
      current_word: parsedInput.word,
      current_index: currentIndex,
      retry_count: parsedInput.mode === "feedback" ? lessonRetryCount(validated.active, parsedInput) : validated.active?.state?.widget === "lesson" && validated.active.state.current_word === parsedInput.word ? validated.active.state.retry_count : 0,
      flow: validated.flow,
      payload,
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
