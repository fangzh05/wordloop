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
      instructions: "Use this plugin to retrieve and persist the user's English vocabulary learning state. Before starting a vocabulary study session, call get_learning_context. Record pretest classifications and scored vocabulary attempts. Never invent stored progress. Use render tools only when visual interaction is useful.",
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
