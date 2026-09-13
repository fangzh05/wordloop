import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerGetErrorBookTool } from "./tools/getErrorBook.js";
import { registerGetLearningContextTool } from "./tools/getLearningContext.js";
import { registerGetNextRoundTool } from "./tools/getNextRound.js";
import { registerGetProgressTool } from "./tools/getProgress.js";
import { registerImportWordsTool } from "./tools/importWords.js";
import { registerRecordAttemptTool } from "./tools/recordAttempt.js";
import { registerRecordPretestResultTool } from "./tools/recordPretestResult.js";
import { registerRenderTools, WIDGET_URIS } from "./tools/renderWidgets.js";
import { registerSaveSentenceTool } from "./tools/saveSentence.js";

export type WidgetKind = keyof typeof WIDGET_URIS;
export type WidgetHtmlLoader = (kind: WidgetKind) => Promise<string>;

function registerWidgetResources(server: McpServer, loadWidgetHtml: WidgetHtmlLoader): void {
  for (const [kind, uri] of Object.entries(WIDGET_URIS) as Array<[WidgetKind, string]>) {
    registerAppResource(server, `Wordloop ${kind} widget`, uri, {
      description: `Wordloop ${kind} interactive view`,
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
      },
    }, async () => ({
      contents: [{
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await loadWidgetHtml(kind),
        _meta: { ui: { prefersBorder: true } },
      }],
    }));
  }
}

export function createWordloopMcpServer(loadWidgetHtml: WidgetHtmlLoader): McpServer {
  const server = new McpServerImpl(
    { name: "wordloop", version: "0.1.0" },
    {
      instructions: "Use this plugin to retrieve and persist the user's English vocabulary learning state. Before every study session, including a new conversation, call get_learning_context and trust its stored statuses instead of restarting completed work. Record every scored vocabulary attempt. Never invent stored progress. Use render_pretest_widget only for today's words whose stored status is new, once with the complete 1–7 item round, American IPA, part of speech, and concise Chinese meaning for every item. The widget restores saved classifications from Wordloop, grades through host sampling, records through tools/call, displays feedback, advances locally, and becomes the pronunciation player after the round. Do not use it for rolling review, send per-question chat feedback, or render separate pronunciation cards for that round. Respond only when the completed widget sends one request to continue. When the user asks for 进度, call get_progress and then render_learning_dashboard in the same turn. When the user asks to import words, call render_word_import. Use standalone pronunciation or dictation render tools only outside this integrated pretest flow. Data tools alone do not render UI.",
    },
  );
  registerImportWordsTool(server);
  registerGetLearningContextTool(server);
  registerGetNextRoundTool(server);
  registerRecordPretestResultTool(server);
  registerRecordAttemptTool(server);
  registerGetErrorBookTool(server);
  registerSaveSentenceTool(server);
  registerGetProgressTool(server);
  registerRenderTools(server);
  registerWidgetResources(server, loadWidgetHtml);
  return server;
}
