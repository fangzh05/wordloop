import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLearningContext } from "../services/review.js";
import { safeTool } from "./helpers.js";

export function registerGetLearningContextTool(server: McpServer): void {
  server.registerTool("get_learning_context", {
    title: "Get learning context",
    description: "Legacy compatibility read of today's persisted word statuses, recent answer history, the due-only Review queue (up to 200 cards), and current learning stats. New study starts should call get_study_bootstrap instead; when this legacy path is used and the due-only queue is non-empty, prefer render_review_widget_v2, or use the legacy render_review_widget only when that is the host's available tool, instead of writing review questions in chat; never pass review items or restart already classified words.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getLearningContext));
}
