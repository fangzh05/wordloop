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
import { registerRecordReviewResultTool } from "./tools/recordReviewResult.js";
import { registerPrepareDailyNewWordsTool } from "./tools/prepareDailyNewWords.js";
import { registerShanbayTools } from "./tools/shanbay.js";
import { registerSetDailyNewWordLimitTool } from "./tools/setDailyNewWordLimit.js";

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
      instructions: "Use Wordloop to retrieve and persist vocabulary state; ChatGPT remains the teaching and grading engine. Before every study session call get_learning_context and trust stored state. If today's list is empty after a book migration, call prepare_daily_new_words once, then reload context. When the user says 今天学20个、每天30个、新词改成50 or otherwise specifies a daily-new-word count, call set_daily_new_word_limit first; if today's list needs supplementing call prepare_daily_new_words, then reload get_learning_context. If the user lowers the limit, never delete words already prepared today. Use record_attempt only for ordinary exercises and error-layer repair. Use record_review_result exactly once for a genuine independent retrieval checkpoint: Again means retrieval failed, an answer was shown, or a substantial hint was required; Hard means independent but effortful or self-corrected; Good means normal independent recall; Easy means immediate and stable recall. Repetition after an answer, shadowing, copying, immediate correction, and newly taught practice never advance FSRS. Pretest classifications already advance FSRS. Review active errors and due cards only, at most five; never pull future cards to fill a quota. Mastered is a progress label, not exclusion from due review. Use render_pretest_widget only for today's new words. When asked for progress, call get_progress then render_learning_dashboard. When asked to import vocabulary, render_word_import. Never invent stored progress or expose Shanbay credentials.",
    },
  );
  registerImportWordsTool(server);
  registerGetLearningContextTool(server);
  registerGetNextRoundTool(server);
  registerRecordPretestResultTool(server);
  registerRecordAttemptTool(server);
  registerRecordReviewResultTool(server);
  registerPrepareDailyNewWordsTool(server);
  registerShanbayTools(server);
  registerSetDailyNewWordLimitTool(server);
  registerGetErrorBookTool(server);
  registerSaveSentenceTool(server);
  registerGetProgressTool(server);
  registerRenderTools(server);
  registerWidgetResources(server, loadWidgetHtml);
  return server;
}
