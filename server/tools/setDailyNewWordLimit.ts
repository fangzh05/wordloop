import { z } from "zod";
import { getLearningBudget, setLearningBudget } from "../services/learningBudget.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setDailyNewWordLimit } from "../services/words.js";
import { setDailyNewWordLimitSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerSetDailyNewWordLimitTool(server: McpServer): void {
  server.registerTool("get_learning_budget", { inputSchema: z.object({}).strict(), description: "读取每日预计时间预算，未做复习仍保持到期。" }, () => safeTool(() => getLearningBudget()));
  server.registerTool("set_daily_time_budget", { inputSchema: z.object({ minutes: z.number().int().min(5).max(240) }).strict(), description: "设置每日学习分钟数，默认45分钟。" }, input => safeTool(() => setLearningBudget(input.minutes)));
  server.registerTool("extend_daily_time_budget", { inputSchema: z.object({ request_id: z.string().uuid() }).strict(), description: "今天加练15分钟。同一request_id重试不会重复加时。" }, input => safeTool(() => setLearningBudget(undefined, input.request_id)));
  server.registerTool("set_daily_new_word_limit", {
    title: "设置每日新词数量",
    description: "设置 Wordloop 每天可从词库安排的新词数量（1–200）。",
    inputSchema: setDailyNewWordLimitSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => setDailyNewWordLimit(input.limit)));
}
