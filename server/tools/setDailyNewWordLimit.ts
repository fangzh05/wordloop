import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setDailyNewWordLimit } from "../services/words.js";
import { setDailyNewWordLimitSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerSetDailyNewWordLimitTool(server: McpServer): void {
  server.registerTool("set_daily_new_word_limit", {
    title: "设置每日新词数量",
    description: "设置 Wordloop 每天可从词库安排的新词数量（1–200）。",
    inputSchema: setDailyNewWordLimitSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => setDailyNewWordLimit(input.limit)));
}
