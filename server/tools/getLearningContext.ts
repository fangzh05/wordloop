import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLearningContext } from "../services/review.js";
import { safeTool } from "./helpers.js";

export function registerGetLearningContextTool(server: McpServer): void {
  server.registerTool("get_learning_context", {
    title: "Get learning context",
    description: "Read today's words, the five-word review queue, and current learning stats. Call before a study session.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getLearningContext));
}

