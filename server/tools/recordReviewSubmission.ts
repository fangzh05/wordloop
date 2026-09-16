import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { recordReviewSubmission } from "../services/fsrsReviews.js";
import { recordReviewSubmissionSchema } from "../../shared/toolContracts.js";
import { safeTool } from "./helpers.js";
import { WIDGET_URIS } from "./renderWidgets.js";

export function registerRecordReviewSubmissionTool(server: McpServer): void {
  registerAppTool(server, "record_review_submission", {
    title: "Record atomic review submission",
    description: "Widget-only review submission. Atomically records the review attempt and advances a due FSRS card; the backend rejects stale or future cards. ChatGPT must not call this tool directly.",
    inputSchema: recordReviewSubmissionSchema,
    _meta: { ui: { resourceUri: WIDGET_URIS.review, visibility: ["app"] } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => safeTool(() => recordReviewSubmission(input)));
}
