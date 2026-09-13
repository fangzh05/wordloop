import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function successResult(data: unknown): CallToolResult {
  return {
    structuredContent: data as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : "Unexpected Wordloop error.";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export async function safeTool(handler: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return successResult(await handler());
  } catch (error) {
    return errorResult(error);
  }
}

