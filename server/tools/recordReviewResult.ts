import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordReviewResult } from "../services/fsrsReviews.js";
import { FSRS_RATINGS } from "../types.js";
import { safeTool } from "./helpers.js";

export function registerRecordReviewResultTool(server: McpServer): void {
  server.registerTool("record_review_result", {
    title: "Record independent review result",
    description: "Advance the FSRS card exactly once after a genuine independent retrieval checkpoint. Do not call for ordinary exercises, repetition after seeing the answer, shadowing, copying, or immediate corrections.",
    inputSchema: z.object({
      word: z.string().trim().min(1).max(100),
      session_id: z.string().uuid().optional(),
      rating: z.enum(FSRS_RATINGS),
      source: z.enum(["review", "session_checkpoint"]),
      reason: z.string().trim().max(500).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => safeTool(() => recordReviewResult(input)));
}
