import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLearningContext } from "../services/review.js";
import { safeTool } from "./helpers.js";

export function registerGetLearningContextTool(server: McpServer): void {
  server.registerTool("get_learning_context", {
    title: "Get learning context",
    description: "Read today's persisted word statuses, recent answer history, the five-word review queue, and current learning stats. Call before every study session or when resuming in a new conversation; when the review queue is non-empty, render_review_widget instead of writing review questions in chat; never restart already classified words.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getLearningContext));
}
