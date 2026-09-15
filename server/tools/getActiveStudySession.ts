import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveStudySession, studySessionSummary } from "../services/studySessions.js";
import { safeTool } from "./helpers.js";

export function registerGetActiveStudySessionTool(server: McpServer): void {
  server.registerTool("get_active_study_session", {
    title: "Get active study session",
    description: "Read the small durable cursor for the current WordLoop study session. The full Widget payload stays in WordLoop and is not returned to the model.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => studySessionSummary(await getActiveStudySession())));
}
