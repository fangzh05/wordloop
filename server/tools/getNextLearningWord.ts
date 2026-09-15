import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNextLearningWord } from "../services/review.js";
import { safeTool } from "./helpers.js";

export function registerGetNextLearningWordTool(server: McpServer): void {
  server.registerTool("get_next_learning_word", {
    title: "Get next learning word",
    description: "Return the first unfinished word after the current word in today's prepared WordLoop queue. The backend owns queue order; a completed round returns null without selecting a replacement word.",
    inputSchema: z.object({
      current_word: z.string().trim().min(1).max(100),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ current_word }) => safeTool(() => getNextLearningWord(current_word)));
}
