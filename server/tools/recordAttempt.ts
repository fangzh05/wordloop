import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recordAttempt } from "../services/attempts.js";
import { ACTIVITY_TYPES, ERROR_LAYERS } from "../types.js";
import { safeTool } from "./helpers.js";

export function registerRecordAttemptTool(server: McpServer): void {
  server.registerTool("record_attempt", {
    title: "Record vocabulary attempt",
    description: "Persist one ordinary exercise attempt and update error-layer repair streaks. This never advances FSRS or changes review dates. This is a pure persistence layer: it stores the is_correct and error_layer it is given and does not grade anything itself. The caller must supply a verdict produced by the shared grading layer: deterministic activity types (pretest_cn_to_en, listen_recall, spelling, word_recall) are graded in code by the deterministic grader, and only semantic activity types are graded by the model. For a correct repair attempt, pass the tested error layer.",
    inputSchema: z.object({
      word: z.string().trim().min(1).max(100),
      session_id: z.string().uuid().optional(),
      activity_type: z.enum(ACTIVITY_TYPES),
      // Review cards only: pass the card's direction so the persistence gate
      // can apply the matching grading rules. Omit for ordinary lesson practice.
      direction: z.enum(["cn_to_en", "en_definition"]).optional(),
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
