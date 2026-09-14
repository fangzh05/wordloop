import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCurrentShanbayBook, importShanbayBook, previewShanbayBook } from "../integrations/shanbay/importer.js";
import { safeTool } from "./helpers.js";

const bookId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const importCursor = z.object({
  state: z.enum(["unlearned", "learning", "simple_learned"]),
  page: z.number().int().min(1).max(100_000),
});

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
    title: "Import Shanbay book chunk",
    description: "Import one bounded, resumable chunk of all Shanbay word states. Call again with next_cursor until complete=true. Every chunk is idempotent; existing learning, FSRS, errors, and attempts are preserved.",
    inputSchema: z.object({ book_id: bookId.optional(), cursor: importCursor.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => safeTool(() => importShanbayBook(input.book_id, input.cursor)));
}
