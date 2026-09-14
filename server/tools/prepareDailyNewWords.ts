import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prepareDailyNewWords } from "../services/words.js";
import { safeTool } from "./helpers.js";

export function registerPrepareDailyNewWordsTool(server: McpServer): void {
  server.registerTool("prepare_daily_new_words", {
    title: "准备今日新词",
    description: "根据当前每日新词上限，将仍处于 new 状态且今天尚未安排的词补入今日学习列表。整本导入不会直接变成当天任务。",
    inputSchema: z.object({ date: z.iso.date().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => prepareDailyNewWords(undefined, undefined, input.date)));
}
