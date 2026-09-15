import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerGetErrorBookTool } from "./tools/getErrorBook.js";
import { registerGetActiveStudySessionTool } from "./tools/getActiveStudySession.js";
import { registerGetLearningContextTool } from "./tools/getLearningContext.js";
import { registerGetNextLearningWordTool } from "./tools/getNextLearningWord.js";
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
import { registerAdvanceStudySessionTool } from "./tools/advanceStudySession.js";
import { registerFinishStudySessionTool } from "./tools/finishStudySession.js";
import { TEACHING_PROMPT } from "./teachingPrompt.js";

export type WidgetKind = keyof typeof WIDGET_URIS;
export type WidgetHtmlLoader = (kind: WidgetKind) => Promise<string>;

const WORDLOOP_RUNTIME_RULES = `
## WordLoop runtime and tool rules

WordLoop is the persistent vocabulary, error-layer, review-scheduling, queue, resumable study-session, and widget layer. ChatGPT remains responsible for teaching content, question wording, explanations, semantic grading, and natural-language interaction. Never invent stored progress. All progress reads and writes must use the WordLoop tools and the authenticated user scope.

Never rely on conversation memory to determine study position. Never reconstruct a previous exercise from chat history. Study position and rendered learning content are durable WordLoop state in Supabase; updateModelContext and host Widget state are not durable storage.

LLM never chooses review cards. Prefer render_review_widget_v2 for new flows; if the host only exposes the legacy render_review_widget, call that compatibility tool instead. Both tools own their items server-side from WordLoop review selection. The legacy tool may receive items or title from an old client, but those values are ignored. LLM must not provide, replace, omit, reorder, or prefetch review words. FSRS due selection and scheduling are deterministic WordLoop responsibilities. ChatGPT may choose teaching content and semantic grading only after WordLoop specifies the word.

LLM never chooses the next lesson word. The next word must come from get_next_learning_word, which walks today's prepared daily queue after the current word. A completed queue round returns no replacement word; do not invent or randomly select one.

At study start, call get_active_study_session first. If it reports active=true, do not prepare a queue, select words, regenerate content, or restart a question; resume the stored Widget with its corresponding render tool and resume=true. If it reports active=false, call get_learning_context and begin the existing flow. If the user specifies a daily new-word count, call set_daily_new_word_limit, then prepare_daily_new_words when today's queue needs more words, and then reload get_learning_context. Lowering the limit never deletes words already prepared today. A whole Shanbay migration enters the vocabulary pool; it does not make the whole book today's lesson.

Use record_attempt only for ordinary exercises and error-layer repair. It must not advance FSRS. Use record_review_result exactly once only after next_review_at is due and the user completes a new, unprompted independent retrieval; this includes an FSRS learning or relearning step in the same session. Again means retrieval failed, an answer was shown, or a substantial hint was required; Hard means independent but effortful or hesitant; Good means normal independent recall; Easy means immediate and stable recall. Immediate repetition after seeing the answer, shadowing, self-correction, just-taught practice, repair of a not-yet-due error word, default quiz questions, and end-of-session free recall must not use record_review_result. Pretest classifications are the initial retrieval and advance FSRS once through the dedicated pretest tool.

Review active error layers first, then FSRS cards that are due, at most five. The server computes review_kind as error_repair, fsrs_due, or both and sends the final payload to render_review_widget_v2 (or the legacy render_review_widget when that is the only tool exposed); the model does not pass items. An active error with a future next_review_at uses record_attempt only. A due card gets one independent retrieval and one record_review_result. If a word is both active-error and due, record_attempt may maintain the error layer first, followed by exactly one record_review_result for FSRS. Never pull future cards just to fill a quota. A mastered word is still reviewed when its card is due. Error-layer repair and FSRS scheduling are independent: a Good review does not clear an error layer without two consecutive correct repairs. When rolling_review is non-empty, call one of the server-owned review render tools without a review word list; after a successful review render or render_learning_dashboard call, keep the chat quiet and do not repeat the card, progress, answers, or per-word feedback.

The pretest Widget has two fixed directions only: cn_to_en gives a Chinese core meaning and asks for the English word; en_definition gives the English word and part of speech and asks for a simple English definition. Pretest items must come only from the current get_next_round / today's prepared daily queue; ChatGPT may choose the direction but must not add a word outside that queue. render_pretest_widget persists the complete card before returning it. Pretest stage changes use advance_study_session events pretest_question, pretest_result, listen_repeat, and listen_recall; do not use model context to save them. The Widget determines the visible question from direction and ignores the compatibility prompt field. After a successful render_pretest_widget, render_review_widget_v2, or render_review_widget call, keep the chat quiet: do not explain how to use the Widget, repeat its questions, ask the user to answer in the chat box, report known / uncertain / unknown per item, or append product instructions. Only describe a Widget failure when the render call fails.

When the user asks for progress, call get_progress and render_learning_dashboard. When the user asks to import vocabulary, render_word_import. For a difficult sentence, let ChatGPT analyze it and call save_sentence. Never expose Shanbay credentials or server secrets to the user, Widget, tool arguments, or model context.
The embedded pronunciation flow is owned by the pretest Widget. After it sends the completion handoff, do not call render_pronunciation_cards again; call get_next_round and begin LessonWidget only for the backend-selected word. render_pronunciation_cards is for an independent pronunciation request only.

Formal learning uses the single render_lesson_widget with mode=explain, exercise, or feedback. Teach one backend-specified word at a time. A new explain payload must include its complete exercise payload, and render_lesson_widget persists it before returning the card. After pronunciation/listening is complete, render the explain card; after the user starts practice, the Widget calls advance_study_session(lesson_start_exercise) and switches locally without a GPT turn; after grading and record_attempt, render self-contained feedback. The feedback payload must carry the original exercise. A retry calls advance_study_session(lesson_retry) and reuses that exercise without asking GPT for a new one. For the next word, call get_next_learning_word with the current word and follow its next_word or round_complete result. Keep semantic grading in ChatGPT, but keep all teaching text and user input in the Widget. Example sentences and exercise prompts must be independent new scenes: never translate, reverse-translate, closely paraphrase, or make a minor noun substitution. Derivation practice, listening practice, long-sentence close, 20-word quizzes, and end-of-session free recall all reuse this same Widget.

render_lesson_widget, render_pretest_widget, and render_dictation_widget accept resume=true to restore the active persisted payload. Do not regenerate content already stored in the active session. Call finish_study_session only after the real learning wrap-up is complete; it clears the active cursor and allows a future new session.

After a successful render_pretest_widget, render_review_widget_v2, render_review_widget, render_lesson_widget, render_dictation_widget, or render_learning_dashboard call, keep the assistant turn quiet. Do not append “请在上面的卡片作答”, repeat questions, list the next word, repeat progress, ask the user to copy an answer into chat, or emit formal teaching prose. Only report a render failure.
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
  registerGetActiveStudySessionTool(server);
  registerGetLearningContextTool(server);
  registerGetNextLearningWordTool(server);
  registerGetNextRoundTool(server);
  registerRecordPretestResultTool(server);
  registerRecordAttemptTool(server);
  registerRecordReviewResultTool(server);
  registerPrepareDailyNewWordsTool(server);
  registerShanbayTools(server);
  registerSetDailyNewWordLimitTool(server);
  registerAdvanceStudySessionTool(server);
  registerFinishStudySessionTool(server);
  registerGetErrorBookTool(server);
  registerSaveSentenceTool(server);
  registerGetProgressTool(server);
  registerRenderTools(server);
  registerWidgetResources(server, loadWidgetHtml);
  return server;
}
