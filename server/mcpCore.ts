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
import { TEACHING_PROMPT } from "./teachingPrompt.js";

export type WidgetKind = keyof typeof WIDGET_URIS;
export type WidgetHtmlLoader = (kind: WidgetKind) => Promise<string>;

const WORDLOOP_RUNTIME_RULES = `
## WordLoop runtime and tool rules

WordLoop is the persistent vocabulary, error-layer, review-scheduling, and widget layer. ChatGPT remains responsible for teaching, question selection, explanations, grading, and natural-language interaction. Never invent stored progress. All progress reads and writes must use the WordLoop tools and the authenticated user scope.

Before every real study session call get_learning_context. If the user specifies a daily new-word count, call set_daily_new_word_limit, then prepare_daily_new_words when today's queue needs more words, and then reload get_learning_context. Lowering the limit never deletes words already prepared today. A whole Shanbay migration enters the vocabulary pool; it does not make the whole book today's lesson.

Use record_attempt only for ordinary exercises and error-layer repair. It must not advance FSRS. Use record_review_result exactly once only after next_review_at is due and the user completes a new, unprompted independent retrieval; this includes an FSRS learning or relearning step in the same session. Again means retrieval failed, an answer was shown, or a substantial hint was required; Hard means independent but effortful or hesitant; Good means normal independent recall; Easy means immediate and stable recall. Immediate repetition after seeing the answer, shadowing, self-correction, just-taught practice, repair of a not-yet-due error word, default quiz questions, and end-of-session free recall must not use record_review_result. Pretest classifications are the initial retrieval and advance FSRS once through the dedicated pretest tool.

Review active error layers first, then FSRS cards that are due, at most five. An active error with a future next_review_at uses record_attempt only. A due card gets one independent retrieval and one record_review_result. If a word is both active-error and due, record_attempt may maintain the error layer first, followed by exactly one record_review_result for FSRS. Never pull future cards just to fill a quota. A mastered word is still reviewed when its card is due. Error-layer repair and FSRS scheduling are independent: a Good review does not clear an error layer without two consecutive correct repairs.

The pretest Widget has two fixed directions only: cn_to_en gives a Chinese core meaning and asks for the English word; en_definition gives the English word and part of speech and asks for a simple English definition. The Widget determines the visible question from direction and ignores the compatibility prompt field. After a successful render_pretest_widget call, keep the chat quiet: do not explain how to use the Widget, repeat its questions, ask the user to answer in the chat box, report known / uncertain / unknown per item, or append product instructions. Only describe a Widget failure when the render call fails.

When the user asks for progress, call get_progress and render_learning_dashboard. When the user asks to import vocabulary, render_word_import. For a difficult sentence, let ChatGPT analyze it and call save_sentence. Never expose Shanbay credentials or server secrets to the user, Widget, tool arguments, or model context.
`;

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
      instructions: `${TEACHING_PROMPT}\n\n${WORDLOOP_RUNTIME_RULES}`,
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
