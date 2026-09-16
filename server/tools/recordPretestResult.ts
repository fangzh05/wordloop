import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordPretestResult } from "../services/words.js";
import { recordPretestResultSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerRecordPretestResultTool(server: McpServer): void {
  server.registerTool("record_pretest_result", {
    title: "Record pretest result",
    description: "Classify one word after its first real retrieval and advance its FSRS card once: known=Good, uncertain=Hard, unknown=Again.",
    inputSchema: recordPretestResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => recordPretestResult(input)));
}
