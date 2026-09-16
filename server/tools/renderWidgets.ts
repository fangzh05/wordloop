import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { ensureTodayQueue } from "../services/dailyQueue.js";
import { getProgress } from "../services/progress.js";
import { findFirstLearningWord, findNextLearningWord, getReviewSelection } from "../services/review.js";
import { getActiveStudySession, getStudyDate, makeStudyState, persistStudyState } from "../services/studySessions.js";
import { getTodayWords } from "../services/words.js";
import { normalizeWord } from "../services/wordNormalization.js";
import type { ReviewVocabularyItem, StudyPhase, StudySessionRow, StudyState, VocabularyItem } from "../types.js";
import { safeTool } from "./helpers.js";

export const WIDGET_URIS = {
  import: "ui://wordloop/import.html",
  pretest: "ui://wordloop/pretest.html",
  review: "ui://wordloop/review.html",
  dashboard: "ui://wordloop/dashboard.html",
  pronunciation: "ui://wordloop/pronunciation.html",
  dictation: "ui://wordloop/dictation.html",
  lesson: "ui://wordloop/lesson.html",
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
}).strict();
const lessonFeedback = z.object({
  is_correct: z.boolean(),
  user_answer: z.string().max(4000),
  error_layer: z.string().trim().max(80).optional(),
  message: z.string().trim().max(1000).optional(),
  reference_answer: z.string().trim().max(4000).optional(),
  explanation: z.string().trim().max(4000).optional(),
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
const dictationInput = z.union([dictationPayload, z.object({ resume: z.literal(true) }).strict()]);
const dictationToolInputSchema = z.object({
  resume: z.literal(true).optional(),
  text: z.string().trim().min(1).max(4000).optional(),
  title: z.string().trim().min(1).max(100).optional(),
}).strict();
const legacyReviewItem = z.object({
  word: z.string().trim().min(1).max(100),
  meaning_zh: z.string().trim().min(1).max(240).describe("Concise Chinese core meaning"),
  part_of_speech: z.string().trim().max(40).optional(),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
  error_layers: z.array(z.enum(["meaning", "collocation", "grammar", "pronunciation", "spelling"])).max(5).default([]),
});
const legacyReviewToolInputSchema = z.object({
  items: z.array(legacyReviewItem).min(1).max(5).optional(),
  current_index: z.number().int().min(0).max(4).optional(),
  title: z.string().trim().min(1).max(100).optional(),
}).strict();
const reviewV2ToolInputSchema = z.object({
  current_index: z.number().int().min(0).max(4).optional(),
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

function widgetPayloadWithState(payload: Record<string, unknown>, state: StudyState): Record<string, unknown> {
  return { ...payload, widget: state.widget, phase: state.phase, current_index: state.current_index };
}

function resumablePayload(session: StudySessionRow | null, widget: StudyState["widget"]): Record<string, unknown> {
  if (!session?.state || session.state.widget !== widget) {
    throw new Error(`No resumable active ${widget} study session.`);
  }
  return widgetPayloadWithState(session.state.payload, session.state);
}

async function saveWidgetState(input: {
  date?: string;
  knownActive?: StudySessionRow | null;
  widget: StudyState["widget"];
  phase: StudyPhase;
  current_word: string | null;
  current_index: number;
  retry_count: number;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { date, knownActive, ...stateInput } = input;
  const state = makeStudyState({ date: date ?? await getStudyDate(), ...stateInput });
  await persistStudyState(state, getDatabase(), getAuthenticatedUserId(), knownActive);
  return widgetPayloadWithState(input.payload, state);
}

function nextLessonIndex(active: StudySessionRow | null, word: string): number {
  if (active?.state?.widget !== "lesson") return 0;
  return active.state.current_word && normalizeWord(active.state.current_word) === normalizeWord(word)
    ? active.state.current_index
    : active.state.current_index + 1;
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
): Promise<{ date: string }> {
  if (input.mode === "exercise" || input.mode === "feedback") {
    assertLessonWordMatches(active?.state?.widget === "lesson" ? active.state.current_word : null, input.word);
    return { date: active?.state?.date ?? await getStudyDate() };
  }

  if (active?.state?.widget === "lesson") {
    const date = active.state.date;
    const todayWords = await getTodayWords(date);
    const expected = active.state.current_word
      ? findNextLearningWord(todayWords, active.state.current_word).next_word?.word ?? null
      : null;
    assertLessonWordMatches(expected, input.word);
    return { date };
  }
  const date = await getStudyDate();
  const todayWords = await getTodayWords(date);
  assertLessonWordMatches(findFirstLearningWord(todayWords)?.word ?? null, input.word);
  return { date };
}

export function reviewWidgetItemFromVocabulary(item: ReviewVocabularyItem): {
  word: string;
  meaning_zh: string;
  part_of_speech?: string;
  error_layers: ReviewVocabularyItem["error_layers"];
  is_due: boolean;
  review_kind: ReviewVocabularyItem["review_kind"];
  next_review_at: string | null;
  direction: "cn_to_en";
} {
  const senses = Array.isArray(item.senses) ? item.senses : [];
  const meaning = senses.map((sense) => typeof sense?.definition_cn === "string" ? sense.definition_cn.trim() : "").filter(Boolean).join("；");
  if (!meaning) throw new Error(`Review word ${item.word} has no persisted meaning.`);
  const partOfSpeech = senses.find((sense) => typeof sense?.pos === "string" && sense.pos.trim())?.pos.trim();
  return {
    word: item.word,
    meaning_zh: meaning,
    ...(partOfSpeech ? { part_of_speech: partOfSpeech } : {}),
    error_layers: item.error_layers,
    is_due: item.is_due,
    review_kind: item.review_kind,
    next_review_at: item.next_review_at,
    direction: "cn_to_en",
  };
}

export function buildReviewWidgetItems(
  candidates: ReviewVocabularyItem[],
  limit = 5,
): ReturnType<typeof reviewWidgetItemFromVocabulary>[] {
  const items: ReturnType<typeof reviewWidgetItemFromVocabulary>[] = [];
  for (const candidate of candidates.slice(0, 25)) {
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

export async function buildReviewWidgetPayload(currentIndex = 0): Promise<{
  widget: "review";
  items: ReturnType<typeof reviewWidgetItemFromVocabulary>[];
  current_index: number;
  title: string;
}> {
  const { rollingReview } = await getReviewSelection(25);
  if (rollingReview.length === 0) throw new Error("No review words are currently due or have active errors.");
  const items = buildReviewWidgetItems(rollingReview, 5);
  if (items.length === 0) throw new Error("到期复习词缺少释义数据。");
  return {
    widget: "review",
    items,
    current_index: Math.min(currentIndex, items.length - 1),
    title: "复习",
  };
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
    description: "兼容旧客户端。传入 items 会被忽略，实际复习队列由 WordLoop backend 生成。在卡片内完成 backend 选择的错误词和 FSRS 到期词复习；模型不能传入、替换或排序复习词。",
    inputSchema: legacyReviewToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.review } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ current_index }) => safeTool(async () => buildReviewWidgetPayload(current_index)));

  registerAppTool(server, "render_review_widget_v2", {
    title: "打开复习（v2）",
    description: "新客户端使用的复习卡片。复习词和顺序始终由 WordLoop backend 从实时复习队列生成，模型不能传入、替换或排序 items。",
    inputSchema: reviewV2ToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.review } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ current_index }) => safeTool(async () => buildReviewWidgetPayload(current_index)));

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
    description: "显示一个单词的讲解、练习或批改卡片。正式学习内容、输入和反馈都留在卡片内；例句与练习必须是不同语境。成功显示后不要在聊天区重复教学正文或操作说明。",
    inputSchema: lessonToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.lesson } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const parsedInput = lessonInput.parse(input);
    if ("resume" in parsedInput) return resumablePayload(await getActiveStudySession(), "lesson");
    const active = await getActiveStudySession();
    const { date } = await validateLessonWord(parsedInput, active);
    const payload = { widget: "lesson", ...parsedInput };
    return saveWidgetState({
      date,
      knownActive: active,
      widget: "lesson",
      phase: lessonPhaseByMode[parsedInput.mode],
      current_word: parsedInput.word,
      current_index: nextLessonIndex(active, parsedInput.word),
      retry_count: parsedInput.mode === "feedback" ? lessonRetryCount(active, parsedInput) : active?.state?.widget === "lesson" && active.state.current_word === parsedInput.word ? active.state.retry_count : 0,
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
    description: "显示由用户点击播放的听写播放器，原文默认隐藏。",
    inputSchema: dictationToolInputSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.dictation } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const parsedInput = dictationInput.parse(input);
    if ("resume" in parsedInput) return resumablePayload(await getActiveStudySession(), "dictation");
    const active = await getActiveStudySession();
    const payload = { widget: "dictation", ...parsedInput };
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
