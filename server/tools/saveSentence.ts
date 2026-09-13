import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { saveSentence } from "../services/sentences.js";
import { safeTool } from "./helpers.js";

export function registerSaveSentenceTool(server: McpServer): void {
  server.registerTool("save_sentence", {
    title: "Save difficult sentence",
    description: "Persist a difficult sentence and words that ChatGPT extracted from it. This tool does not analyze the sentence.",
    inputSchema: z.object({
      sentence: z.string().trim().min(1).max(10000),
      extracted_words: z.array(z.string()).max(100).default([]),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => safeTool(() => saveSentence(input)));
}

