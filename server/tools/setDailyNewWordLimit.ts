import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setDailyNewWordLimit } from "../services/words.js";
import { safeTool } from "./helpers.js";

export function registerSetDailyNewWordLimitTool(server: McpServer): void {
  server.registerTool("set_daily_new_word_limit", {
    title: "设置每日新词数量",
    description: "设置 Wordloop 每天可从词库安排的新词数量（1–200）。",
    inputSchema: z.object({ limit: z.number().int().min(1).max(200) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => setDailyNewWordLimit(input.limit)));
}
