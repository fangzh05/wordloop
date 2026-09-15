import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordReviewSubmission } from "../services/fsrsReviews.js";
import { ERROR_LAYERS, FSRS_RATINGS } from "../types.js";
import { safeTool } from "./helpers.js";

const inputSchema = z.object({
  word: z.string().trim().min(1).max(100),
  user_answer: z.string().max(4000).default(""),
  is_correct: z.boolean(),
  error_layer: z.enum(ERROR_LAYERS).default("none"),
  rating: z.enum(FSRS_RATINGS),
  session_id: z.string().uuid().optional(),
}).superRefine((value, context) => {
  if (!value.is_correct && value.error_layer === "none") {
    context.addIssue({ code: "custom", message: "Incorrect attempts require a concrete error_layer.", path: ["error_layer"] });
  }
});

export function registerRecordReviewSubmissionTool(server: McpServer): void {
  server.registerTool("record_review_submission", {
    title: "Record atomic review submission",
    description: "Widget-only review submission. Atomically records the review attempt and advances a due FSRS card; the backend rejects stale or future cards. ChatGPT must not call this tool directly.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => safeTool(() => recordReviewSubmission(input)));
}
