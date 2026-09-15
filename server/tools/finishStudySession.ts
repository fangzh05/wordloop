import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { finishStudySession } from "../services/studySessions.js";
import { safeTool } from "./helpers.js";

export function registerFinishStudySessionTool(server: McpServer): void {
  server.registerTool("finish_study_session", {
    title: "Finish study session",
    description: "Close the active WordLoop study session after the real learning wrap-up. The durable state is cleared only after this explicit completion event.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safeTool(async () => {
    await finishStudySession();
    return { active: false };
  }));
}
