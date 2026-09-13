import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCurrentShanbayBook, importShanbayBook, previewShanbayBook } from "../integrations/shanbay/importer.js";
import { safeTool } from "./helpers.js";

const bookId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

export function registerShanbayTools(server: McpServer): void {
  server.registerTool("get_current_shanbay_book", {
    title: "Get current Shanbay book",
    description: "Read the current Shanbay word book using server-side credentials. Credentials are never returned.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: true },
  }, () => safeTool(getCurrentShanbayBook));

  server.registerTool("preview_shanbay_book", {
    title: "Preview Shanbay book",
    description: "Read every page of all three Shanbay source states and report the complete unique size without importing.",
    inputSchema: z.object({ book_id: bookId }), annotations: { readOnlyHint: true, openWorldHint: true },
  }, (input) => safeTool(() => previewShanbayBook(input.book_id)));

  server.registerTool("import_shanbay_book", {
    title: "Import complete Shanbay book",
    description: "One-time, idempotent migration of unlearned, learning, and simple-learned words into the Wordloop vocabulary pool. Existing learning, FSRS, errors, and attempts are preserved.",
    inputSchema: z.object({ book_id: bookId.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => safeTool(() => importShanbayBook(input.book_id)));
}
