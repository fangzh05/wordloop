import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advanceStudySession, studySessionSummary } from "../services/studySessions.js";
import { advanceStudySessionSchema, reviewAnswerSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerAdvanceStudySessionTool(server: McpServer): void {
  server.registerTool("advance_study_session", {
    title: "Advance study session",
    description: "Advance one fixed WordLoop Widget transition, including the idempotent final Lesson lesson_complete commit. The backend validates the current phase, owns the durable cursor, and returns a periodic consolidation marker only when cadence is due; arbitrary session JSON is not accepted.",
    inputSchema: advanceStudySessionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => {
    const reviewAnswer = input.event === "review_answer"
      ? reviewAnswerSchema.parse(input)
      : undefined;
    const session = await advanceStudySession(input.event, input.current_index, reviewAnswer);
    return studySessionSummary(session);
  }));
}
