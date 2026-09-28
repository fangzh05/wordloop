import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordAttempt } from "../services/attempts.js";
import { recordAttemptSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerRecordAttemptTool(server: McpServer): void {
  server.registerTool("record_attempt", {
    title: "Record vocabulary attempt",
    description: "Persist one ordinary exercise attempt and update error-layer repair streaks. This never advances FSRS or changes review dates. This is a pure persistence layer: it stores the is_correct and error_layer it is given and does not grade anything itself. The caller must supply a verdict produced by the shared grading layer: fixed-answer activity types (pretest_cn_to_en, listen_recall, spelling, word_recall, exact_cloze, legacy cloze, derivation, recall) are graded in code; exact_cloze accepts only the target word with exact normalized matching; only open-ended semantic activities are graded by the model. For a correct repair attempt, pass the tested error layer.",
    inputSchema: recordAttemptSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => safeTool(() => recordAttempt(input)));
}
