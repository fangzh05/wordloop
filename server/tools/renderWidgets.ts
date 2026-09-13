import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getProgress } from "../services/progress.js";
import { safeTool } from "./helpers.js";

export const WIDGET_URIS = {
  import: "ui://wordloop/import.html",
  pretest: "ui://wordloop/pretest.html",
  dashboard: "ui://wordloop/dashboard.html",
  pronunciation: "ui://wordloop/pronunciation.html",
  dictation: "ui://wordloop/dictation.html",
} as const;

const pronunciationWord = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(40).optional(),
  meaning_zh: z.string().trim().min(1).max(240).optional(),
});
const pretestItem = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120).describe("American English IPA, including stress marks"),
  part_of_speech: z.string().trim().min(1).max(40).describe("Concise part of speech, such as adj. or v."),
  meaning_zh: z.string().trim().min(1).max(240).describe("Concise Chinese core meaning"),
  prompt: z.string().trim().min(1).max(1000),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
});

export function registerRenderTools(server: McpServer): void {
  registerAppTool(server, "render_word_import", {
    title: "Open Word Import",
    description: "Render the one-time Shanbay book migration UI with current-book, materialbook ID, preview, full import, and manual fallback.",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: WIDGET_URIS.import } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(async () => ({ widget: "import" })));

  registerAppTool(server, "render_pretest_widget", {
    title: "Open Interactive Pretest",
    description: "Render one self-contained interactive card for a complete 1–7 item NEW-WORD pretest round. Include American IPA, part of speech, and concise Chinese meaning for every item. The widget restores saved classifications from Wordloop, supports a one-tap unknown action, records results with tools/call, and turns into the pronunciation player after the round. Do not use this tool for rolling review, send per-question chat feedback, or render a separate pronunciation widget for this round.",
    inputSchema: z.object({
      items: z.array(pretestItem).min(1).max(7),
      current_index: z.number().int().min(0).max(6).default(0),
      title: z.string().trim().min(1).max(100).default("Quick pretest"),
    }),
    _meta: { ui: { resourceUri: WIDGET_URIS.pretest } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => safeTool(async () => ({ widget: "pretest", ...input })));

  registerAppTool(server, "render_learning_dashboard", {
    title: "Show Learning Dashboard",
    description: "Render today's vocabulary progress and study actions. MUST be called after get_progress when the user asks for 进度, so the user receives the interactive dashboard.",
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
