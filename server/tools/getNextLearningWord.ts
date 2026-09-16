import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNextLearningWord } from "../services/review.js";
import { getNextLearningWordSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerGetNextLearningWordTool(server: McpServer): void {
  server.registerTool("get_next_learning_word", {
    title: "Get next learning word",
    description: "Return the first unfinished word after the current word in the backend-owned canonical queue. A matching active lesson cursor continues its saved session date across days; otherwise the backend uses today's prepared queue. A completed round returns null without selecting a replacement word.",
    inputSchema: getNextLearningWordSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ current_word }) => safeTool(() => getNextLearningWord(current_word)));
}
