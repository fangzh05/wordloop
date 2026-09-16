import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getActiveStudySession, getPretestResults, studySessionSummary } from "../services/studySessions.js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { safeTool } from "./helpers.js";

export function registerGetActiveStudySessionTool(server: McpServer): void {
  server.registerTool("get_active_study_session", {
    title: "Get active study session",
    description: "Read the small durable cursor for the current WordLoop study session. The full Widget payload stays in WordLoop and is not returned to the model.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => {
    const db = getDatabase();
    const userId = getAuthenticatedUserId();
    const active = await getActiveStudySession(db, userId);
    const pretestResults = active?.state?.widget === "pretest"
      ? await getPretestResults(active, db, userId)
      : undefined;
    return studySessionSummary(active, pretestResults);
  }));
}
