import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNextLearningWord } from "../services/review.js";
import { getNextLearningWordSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerGetNextLearningWordTool(server: McpServer): void {
  server.registerTool("get_next_learning_word", {
    title: "Get next learning word",
    description: "Return the exact next word from the active Lesson's frozen backend-owned flow.lesson_words queue. The server validates the current cursor and looks up only that next lexical item; it never filters the frozen queue by live status. A completed queue returns the legal result {next_word:null, round_complete:true}.",
    inputSchema: getNextLearningWordSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ current_word }) => safeTool(() => getNextLearningWord(current_word)));
}
