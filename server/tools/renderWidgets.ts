import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getProgress } from "../services/progress.js";
import { safeTool } from "./helpers.js";

export const WIDGET_URIS = {
  import: "ui://wordloop/import.html",
  pretest: "ui://wordloop/pretest.html",
  review: "ui://wordloop/review.html",
  dashboard: "ui://wordloop/dashboard.html",
  pronunciation: "ui://wordloop/pronunciation.html",
  dictation: "ui://wordloop/dictation.html",
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
const reviewItem = z.object({
  word: z.string().trim().min(1).max(100),
  meaning_zh: z.string().trim().min(1).max(240).describe("Concise Chinese core meaning"),
  part_of_speech: z.string().trim().max(40).optional(),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
  error_layers: z.array(z.enum(["meaning", "collocation", "grammar", "pronunciation", "spelling"])).max(5).default([]),
});

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
    description: "在卡片内完成错误词和 FSRS 到期词的独立复习。卡片负责题面、批改和保存结果；成功渲染后不要在聊天区重复题目或反馈。",
    inputSchema: z.object({
      items: z.array(reviewItem).min(1).max(5),
      current_index: z.number().int().min(0).max(4).default(0),
      title: z.string().trim().min(1).max(100).default("复习"),
    }),
    _meta: { ui: { resourceUri: WIDGET_URIS.review } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "review", ...input })));

  registerAppTool(server, "render_learning_dashboard", {
    title: "显示学习进度",
    description: "显示今日词汇进度和学习操作。用户询问进度时，应先调用 get_progress，再调用此工具显示交互式面板。",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: WIDGET_URIS.dashboard } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => ({ widget: "dashboard", progress: await getProgress() })));

  registerAppTool(server, "render_pronunciation_cards", {
    title: "显示发音卡片",
    description: "显示 5–7 个由用户点击播放的美式英语发音卡片。",
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
