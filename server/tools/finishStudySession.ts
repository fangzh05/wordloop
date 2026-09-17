import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { finishStudySession } from "../services/studySessions.js";
import { safeTool } from "./helpers.js";

export function registerFinishStudySessionTool(server: McpServer): void {
  server.registerTool("finish_study_session", {
    title: "Finish study session",
    description: "Close the active WordLoop study session exactly once after the current Lesson round's long-sentence wrap-up has been answered and graded. Do not call before that wrap-up; after it completes, immediately call get_study_bootstrap to continue any remaining daily words. This is not the session-end free recall trigger.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safeTool(async () => {
    await finishStudySession();
    return { active: false };
  }));
}
