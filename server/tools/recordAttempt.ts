import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordAttempt } from "../services/attempts.js";
import { recordAttemptSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerRecordAttemptTool(server: McpServer): void {
  server.registerTool("record_attempt", {
    title: "Record vocabulary attempt",
    description: "Persist one ordinary exercise attempt and update error-layer repair streaks. This never advances FSRS or changes review dates. This is a pure persistence layer: it stores the is_correct and error_layer it is given and does not grade anything itself. The caller must supply a verdict produced by the shared grading layer: deterministic activity types (pretest_cn_to_en, listen_recall, spelling, word_recall) are graded in code by the deterministic grader, and only semantic activity types are graded by the model. For a correct repair attempt, pass the tested error layer.",
    inputSchema: recordAttemptSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => safeTool(() => recordAttempt(input)));
}
