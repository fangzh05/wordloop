import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getProgress } from "../services/progress.js";
import { safeTool } from "./helpers.js";

export const WIDGET_URIS = {
  import: "ui://wordloop/import.html",
  dashboard: "ui://wordloop/dashboard.html",
  pronunciation: "ui://wordloop/pronunciation.html",
  dictation: "ui://wordloop/dictation.html",
} as const;

const pronunciationWord = z.object({ word: z.string().trim().min(1).max(100), ipa: z.string().trim().min(1).max(120) });

export function registerRenderTools(server: McpServer): void {
  registerAppTool(server, "render_word_import", {
    title: "Open Word Import",
    description: "Render the manual Shanbay word import widget.",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: WIDGET_URIS.import } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => ({ widget: "import" })));

  registerAppTool(server, "render_learning_dashboard", {
    title: "Show Learning Dashboard",
    description: "Render today's vocabulary progress and study actions.",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: WIDGET_URIS.dashboard } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => ({ widget: "dashboard", progress: await getProgress() })));

  registerAppTool(server, "render_pronunciation_cards", {
    title: "Show Pronunciation Cards",
    description: "Render 5–7 user-triggered American English pronunciation cards after the user repeats the words.",
    inputSchema: z.object({ words: z.array(pronunciationWord).min(1).max(7) }),
    _meta: { ui: { resourceUri: WIDGET_URIS.pronunciation } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "pronunciation", ...input })));

  registerAppTool(server, "render_dictation_widget", {
    title: "Open Dictation",
    description: "Render a user-triggered speech-synthesis dictation player with the transcript hidden by default.",
    inputSchema: z.object({
      text: z.string().trim().min(1).max(4000),
      title: z.string().trim().min(1).max(100).default("Dictation"),
    }),
    _meta: { ui: { resourceUri: WIDGET_URIS.dictation } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "dictation", ...input })));
}

