import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProgress } from "../services/progress.js";
import { safeTool } from "./helpers.js";

export function registerGetProgressTool(server: McpServer): void {
  server.registerTool("get_progress", {
    title: "Get vocabulary progress",
    description: "Read today's and all-time vocabulary learning totals. For a user-facing 进度 request, call this first and then call render_learning_dashboard in the same turn; after the dashboard renders, do not repeat its progress in chat.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getProgress));
}
