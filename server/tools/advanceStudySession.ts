import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advanceStudySession } from "../services/studySessions.js";
import { advanceStudySessionSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";

export function registerAdvanceStudySessionTool(server: McpServer): void {
  server.registerTool("advance_study_session", {
    title: "Advance study session",
    description: "Advance one fixed WordLoop Widget transition. The backend validates the current phase and owns the durable cursor; arbitrary session JSON is not accepted.",
    inputSchema: advanceStudySessionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ event, current_index }) => safeTool(async () => {
    const session = await advanceStudySession(event, current_index);
    return {
      active: true,
      widget: session.state?.widget,
      phase: session.state?.phase,
      current_word: session.state?.current_word,
      current_index: session.state?.current_index,
    };
  }));
}
