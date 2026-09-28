import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { finishStudySession } from "../services/studySessions.js";
import { safeTool } from "./helpers.js";

export function registerFinishStudySessionTool(server: McpServer): void {
  server.registerTool("finish_study_session", {
    title: "Finish study session",
    description: "Close the active WordLoop study session after the current Lesson round is complete and any backend-scheduled consolidation has been answered and graded. If the backend did not schedule consolidation, finish immediately; then call get_study_bootstrap to continue due Review, the next Pretest, the next Lesson, or done. This is not the session-end free recall trigger.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safeTool(async () => {
    await finishStudySession();
    return { active: false };
  }));
}
