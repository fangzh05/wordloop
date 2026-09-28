import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pretestMarkFamiliarSchema } from "../../shared/toolContracts.js";
import { markPretestFamiliar } from "../services/studySessions.js";
import { safeTool } from "./helpers.js";

export function registerPretestMarkFamiliarTool(server: McpServer): void {
  server.registerTool("pretest_mark_familiar", {
    title: "Mark revealed new word familiar",
    description: "After a new-word Pretest answer and its correct target have been revealed, mark the current word known and leave this new-word learning path. This action is rejected for Review and relearn sessions and creates no Review result.",
    inputSchema: pretestMarkFamiliarSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => safeTool(() => markPretestFamiliar(input)));
}
