import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNextRound } from "../services/review.js";
import { safeTool } from "./helpers.js";

export function registerGetNextRoundTool(server: McpServer): void {
  server.registerTool("get_next_round", {
    title: "Get next word round",
    description: "Return 5–7 unfinished words, ordered unknown, uncertain, then new.",
    inputSchema: z.object({ limit: z.number().int().min(5).max(7).default(6) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ limit }) => safeTool(() => getNextRound(limit)));
}

