import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setDailyNewWordLimit } from "../services/words.js";
import { safeTool } from "./helpers.js";

export function registerSetDailyNewWordLimitTool(server: McpServer): void {
  server.registerTool("set_daily_new_word_limit", {
    title: "Set daily new-word limit",
    description: "Set how many vocabulary-pool words Wordloop may allocate per day.",
    inputSchema: z.object({ limit: z.number().int().min(10).max(100) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => setDailyNewWordLimit(input.limit)));
}
