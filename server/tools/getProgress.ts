import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProgress } from "../services/progress.js";
import { safeTool } from "./helpers.js";

export function registerGetProgressTool(server: McpServer): void {
  server.registerTool("get_progress", {
    title: "Get vocabulary progress",
    description: "Read today's and all-time vocabulary learning totals for plain-text, debug, or legacy clients. For a user-facing 进度 request, call render_learning_dashboard directly; it reads the snapshot once internally.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getProgress));
}
