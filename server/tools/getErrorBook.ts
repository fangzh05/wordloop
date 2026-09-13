import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getErrorBook } from "../services/review.js";
import { safeTool } from "./helpers.js";

export function registerGetErrorBookTool(server: McpServer): void {
  server.registerTool("get_error_book", {
    title: "Get error book",
    description: "Return words with active error layers and their repair streaks.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getErrorBook));
}

