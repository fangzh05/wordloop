import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { getActiveStudySession } from "../services/studySessions.js";
import { normalizeWord } from "../services/wordNormalization.js";
import { recordPretestResult } from "../services/words.js";
import { recordPretestResultSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerRecordPretestResultTool(server: McpServer): void {
  server.registerTool("record_pretest_result", {
    title: "Record pretest result",
    description: "Classify one word after its first real retrieval and advance its FSRS card once: known=Good, uncertain=Hard, unknown=Again.",
    inputSchema: recordPretestResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const db = getDatabase();
    const userId = getAuthenticatedUserId();
    const session = await getActiveStudySession(db, userId);
    const state = session?.state;
    if (!session || !state || state.widget !== "pretest"
      || state.payload.source !== "new_word"
      || (state.phase !== "pretest" && state.phase !== "pretest_result")
      || !state.current_word
      || normalizeWord(state.current_word) !== normalizeWord(input.word)) {
      throw new Error("PRETEST_RESULT_SESSION_MISMATCH");
    }
    return recordPretestResult(input, db, userId, session.started_at);
  }));
}
