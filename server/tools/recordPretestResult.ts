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
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => recordPretestResult(input)));
}

