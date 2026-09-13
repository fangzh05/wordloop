import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prepareDailyNewWords } from "../services/words.js";
import { safeTool } from "./helpers.js";

export function registerPrepareDailyNewWordsTool(server: McpServer): void {
  server.registerTool("prepare_daily_new_words", {
    title: "Prepare today's new words",
    description: "Allocate today's configured number of never-scheduled vocabulary-pool words into the existing daily learning flow. An imported book is never treated as one daily list.",
    inputSchema: z.object({ date: z.iso.date().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => prepareDailyNewWords(undefined, undefined, input.date)));
}
