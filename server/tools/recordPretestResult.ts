import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordPretestResult } from "../services/words.js";
import { safeTool } from "./helpers.js";

export function registerRecordPretestResultTool(server: McpServer): void {
  server.registerTool("record_pretest_result", {
    title: "Record pretest result",
    description: "Classify one imported word as known, uncertain, or unknown after a pretest.",
    inputSchema: z.object({
      word: z.string().trim().min(1).max(100),
      result: z.enum(["known", "uncertain", "unknown"]),
      user_answer: z.string().max(2000).default(""),
      activity_type: z.enum(["pretest_cn_to_en", "pretest_en_definition"]).default("pretest_cn_to_en"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => recordPretestResult(input)));
}
