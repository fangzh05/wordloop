import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getProgress } from "../services/progress.js";
import { getReviewSelection } from "../services/review.js";
import type { ReviewVocabularyItem } from "../types.js";
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
});
const pretestItem = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120).describe("American English IPA, including stress marks"),
  part_of_speech: z.string().trim().min(1).max(40).describe("Concise part of speech, such as adj. or v."),
  meaning_zh: z.string().trim().min(1).max(240).describe("Concise Chinese core meaning"),
  prompt: z.string().trim().max(1000).optional(),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
});
const lessonExercise = z.object({
  type: z.string().trim().max(80).optional(),
  activity_type: z.string().trim().max(80).optional(),
  instruction: z.string().trim().max(300).optional(),
  prompt: z.string().trim().max(4000).optional(),
  prompt_en: z.string().trim().max(4000).optional(),
  multiline: z.boolean().optional(),
});
const lessonFeedback = z.object({
  is_correct: z.boolean().optional(),
  result: z.string().optional(),
  status: z.string().optional(),
  error_layer: z.string().optional(),
  message: z.string().optional(),
  user_answer: z.string().optional(),
  reference_answer: z.string().optional(),
  explanation: z.string().optional(),
  reveal_answer: z.boolean().optional(),
});
const lessonPayload = z.object({
  mode: z.enum(["explain", "exercise", "feedback"]).default("explain"),
  title: z.string().trim().max(120).optional(),
  progress: z.string().trim().max(40).optional(),
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().max(120).optional(),
  part_of_speech: z.string().trim().max(40).optional(),
  meaning_zh: z.string().trim().max(240).optional(),
  collocations: z.array(z.string().trim().max(200)).max(8).optional(),
  derivations: z.array(z.string().trim().max(200)).max(8).optional(),
  collocation: z.string().trim().max(200).optional(),
  example_en: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(1000).optional(),
  activity_type: z.string().trim().max(80).optional(),
  instruction: z.string().trim().max(300).optional(),
  prompt: z.string().trim().max(4000).optional(),
  prompt_en: z.string().trim().max(4000).optional(),
  multiline: z.boolean().optional(),
  exercise: lessonExercise.optional(),
  feedback: lessonFeedback.optional(),
});
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
  const senses = item.senses ?? [];
  const meaning = senses.map((sense) => sense.definition_cn.trim()).filter(Boolean).join("；");
  if (!meaning) throw new Error(`Review word ${item.word} has no persisted meaning.`);
  const partOfSpeech = senses.find((sense) => sense.pos.trim())?.pos.trim();
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
    inputSchema: z.object({
      items: z.array(pretestItem).min(1).max(7),
      current_index: z.number().int().min(0).max(6).default(0),
      title: z.string().trim().min(1).max(100).default("快速预测试"),
    }),
    _meta: { ui: { resourceUri: WIDGET_URIS.pretest } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "pretest", ...input })));

  registerAppTool(server, "render_review_widget", {
    title: "打开复习",
    description: "在卡片内完成 WordLoop backend 选择的错误词和 FSRS 到期词复习。模型不能传入、替换或排序复习词；卡片负责题面、批改和保存结果。",
    inputSchema: z.object({
      current_index: z.number().int().min(0).max(4).optional(),
    }),
    _meta: { ui: { resourceUri: WIDGET_URIS.review } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ current_index }) => safeTool(async () => {
    const { rollingReview } = await getReviewSelection(5);
    if (rollingReview.length === 0) throw new Error("No review words are currently due or have active errors.");
    const items = rollingReview.map(reviewWidgetItemFromVocabulary);
    return {
      widget: "review",
      items,
      current_index: Math.min(current_index ?? 0, items.length - 1),
      title: "复习",
    };
  }));

  registerAppTool(server, "render_learning_dashboard", {
    title: "显示学习进度",
    description: "显示今日词汇进度和学习操作。用户询问进度时，应先调用 get_progress，再调用此工具显示交互式面板；卡片成功显示后保持聊天区安静，不要重复进度或操作说明。",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: WIDGET_URIS.dashboard } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => ({ widget: "dashboard", progress: await getProgress() })));

  registerAppTool(server, "render_lesson_widget", {
    title: "打开单词学习",
    description: "显示一个单词的讲解、练习或批改卡片。正式学习内容、输入和反馈都留在卡片内；例句与练习必须是不同语境。成功显示后不要在聊天区重复教学正文或操作说明。",
    inputSchema: lessonPayload,
    _meta: { ui: { resourceUri: WIDGET_URIS.lesson } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "lesson", ...input })));

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
    inputSchema: z.object({
      text: z.string().trim().min(1).max(4000),
      title: z.string().trim().min(1).max(100).default("听写"),
    }),
    _meta: { ui: { resourceUri: WIDGET_URIS.dictation } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "dictation", ...input })));
}
