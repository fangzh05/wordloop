import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getNextLearningWord } from "../services/review.js";
import {
  getNextLearningWordSchema,
  nextLearningWordOutputSchema,
} from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerGetNextLearningWordTool(server: McpServer): void {
  server.registerTool("get_next_learning_word", {
    title: "Get next learning word",
    description: 'Legacy/debug fallback: return the next Lesson action from the active frozen flow.lesson_words queue. Normal LessonWidget progression uses backend-owned payload.navigation and does not call this tool. action="next_word" means use exactly next_word and render the next LessonWidget. action="round_complete" means the frozen Lesson queue is finished: next_word is intentionally null and this is SUCCESS, not an error. Do not retry get_next_learning_word, call get_next_round, or request a replacement word after action="round_complete". The server validates the current cursor and never filters the frozen queue by live status.',
    inputSchema: getNextLearningWordSchema,
    outputSchema: nextLearningWordOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ current_word }) => safeTool(() => getNextLearningWord(current_word)));
}
