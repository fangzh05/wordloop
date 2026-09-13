import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordAttempt } from "../services/attempts.js";
import { ACTIVITY_TYPES, ERROR_LAYERS } from "../types.js";
import { safeTool } from "./helpers.js";

export function registerRecordAttemptTool(server: McpServer): void {
  server.registerTool("record_attempt", {
    title: "Record vocabulary attempt",
    description: "Persist one scored vocabulary output. For a correct repair attempt, pass the error layer being tested so its 2-correct streak can be tracked.",
    inputSchema: z.object({
      word: z.string().trim().min(1).max(100),
      session_id: z.string().uuid().optional(),
      activity_type: z.enum(ACTIVITY_TYPES),
      user_answer: z.string().max(4000).default(""),
      is_correct: z.boolean(),
      error_layer: z.enum(ERROR_LAYERS).default("none"),
    }).superRefine((value, context) => {
      if (!value.is_correct && value.error_layer === "none") {
        context.addIssue({ code: "custom", message: "Incorrect attempts require a concrete error_layer.", path: ["error_layer"] });
      }
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => safeTool(() => recordAttempt(input)));
}

