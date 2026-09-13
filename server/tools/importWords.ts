import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { importWords } from "../services/words.js";
import { safeTool } from "./helpers.js";

export function registerImportWordsTool(server: McpServer): void {
  server.registerTool("import_words", {
    title: "Import words",
    description: "Import a daily vocabulary list in its original order without overwriting prior learning state.",
    inputSchema: z.object({
      words: z.array(z.string()).min(1).max(500),
      date: z.iso.date().optional(),
      source: z.string().trim().min(1).max(50).default("shanbay"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => importWords(input)));
}

