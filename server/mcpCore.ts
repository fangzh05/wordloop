import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerImpl } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerGetErrorBookTool } from "./tools/getErrorBook.js";
import { registerGetActiveStudySessionTool } from "./tools/getActiveStudySession.js";
import { registerGetStudyBootstrapTool } from "./tools/getStudyBootstrap.js";
import { registerGetLearningContextTool } from "./tools/getLearningContext.js";
import { registerGetNextLearningWordTool } from "./tools/getNextLearningWord.js";
import { registerGetNextRoundTool } from "./tools/getNextRound.js";
import { registerGetProgressTool } from "./tools/getProgress.js";
import { registerImportWordsTool } from "./tools/importWords.js";
import { registerRecordAttemptTool } from "./tools/recordAttempt.js";
import { registerRecordPretestResultTool } from "./tools/recordPretestResult.js";
import { LEGACY_WIDGET_URIS, registerRenderTools, WIDGET_URIS } from "./tools/renderWidgets.js";
import { registerSaveSentenceTool } from "./tools/saveSentence.js";
import { registerRecordReviewResultTool } from "./tools/recordReviewResult.js";
import { registerRecordReviewSubmissionTool } from "./tools/recordReviewSubmission.js";
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

LLM never chooses the next lesson word. In a new study flow, get_study_bootstrap supplies the backend-selected word or the pretest batch. Before the first Lesson card, WordLoop freezes the canonical flow.lesson_words queue in study_sessions.state. Lesson navigation is backend-owned and authoritative: render_lesson_widget returns payload.navigation. For action="next_word", the Widget sends exactly navigation.next_word and ChatGPT renders only that exact word in LessonWidget mode=explain. The normal Widget next-word button does not call get_next_learning_word, and the model never supplies or edits navigation. For action="round_complete", the Widget calls advance_study_session with event="lesson_complete" and then sends the round-complete handoff; it does not call get_next_learning_word, get_next_round, or the daily queue. Never describe a round-complete action as invalid, unavailable, failed, or retryable. The legacy get_next_learning_word tool remains available for legacy hosts, debugging, and fallback paths only; its output is not the normal Widget progression boundary.

At normal study start for “开始学习”“继续学习” or “wordloop 开始”, call get_study_bootstrap first. When there is no active session, bootstrap ensures today's daily queue before checking the due-only FSRS queue, then short-circuits in this order: active session→resume, ensure today queue→one frozen due-review snapshot (maximum 200)→render review, prepared new words→render pretest, next learning word→lesson, otherwise done. Do not call get_active_study_session→get_learning_context→prepare_daily_new_words→get_next_round as a default orchestration chain. Bootstrap owns the active-session, local-date, idempotent daily-queue preparation, due-only review gate, and today-queue checks; an active resume returns immediately without preparing a new queue. After review_complete, continue the same session into pretest or the session-aware lesson queue; do not start a second review or re-query due cards. Legacy clients that do not expose get_study_bootstrap may keep the old flow: call get_active_study_session first; if active=true, resume without preparing or selecting; only active=false may call get_learning_context. If the user specifies a daily new-word count, call set_daily_new_word_limit; that tool prepares today's queue in the same server call. Lowering the limit never deletes words already prepared today. A whole Shanbay migration enters the vocabulary pool; it does not make the whole book today's lesson.

Use record_attempt only for ordinary exercises and error-layer repair. It must not advance FSRS. The review Widget uses the internal record_review_submission tool for fsrs_due/both cards; that operation atomically records the review attempt and advances FSRS once, and ChatGPT must not call it. Use record_review_result only for an allowed direct/session_checkpoint path after next_review_at is due and the user completes a new, unprompted independent retrieval; this includes an FSRS learning or relearning step in the same session. Again means retrieval failed, an answer was shown, or a substantial hint was required; Hard means independent but effortful or hesitant; Good means normal independent recall; Easy means immediate and stable recall. The deterministic one-edit spelling near miss is always correct + Hard + spelling; when the non-FSRS record_attempt path stores it, only the FSRS-only rating is omitted and is_correct plus error_layer=spelling remain. Immediate repetition after seeing the answer, shadowing, self-correction, just-taught practice, repair of a not-yet-due error word, default quiz questions, and end-of-session free recall must not use record_review_result. Pretest classifications are the initial retrieval and advance FSRS once through the dedicated pretest tool.

Initial Review contains only FSRS cards with next_review_at <= now, ordered by due time then normalized word, in one immutable session snapshot of at most 200 cards. An active error whose next_review_at is in the future never gates initial Review; it is handled later as ordinary error repair. The server computes review_kind as error_repair, fsrs_due, or both and sends the final payload to render_review_widget_v2 (or the legacy render_review_widget when that is the only tool exposed); the model does not pass items. A due card gets one independent retrieval through the atomic Widget submission, followed by one durable review_answer cursor transition. If a word is both active-error and due, that one submission maintains the error layer and advances FSRS together. Never pull future cards just to fill a quota. A mastered word is still reviewed when its card is due. A failed review card is added once to the current session's relearn queue and is not re-entered into the current Review snapshot; after review_complete it is taught through the session-aware Lesson queue. Error-layer repair and FSRS scheduling are independent: a Good review does not clear an error layer without two consecutive correct repairs. When the due-only queue is non-empty, call one of the server-owned review render tools without a review word list; after a successful review render or render_learning_dashboard call, keep the chat quiet and do not repeat the card, progress, answers, or per-word feedback.

The pretest Widget has two fixed directions only: cn_to_en gives a Chinese core meaning and asks for the English word; en_definition gives the English word and part of speech and asks for a simple English definition. Pretest items must come only from the current get_next_round / today's prepared daily queue; the server rejects inserted, repeated, skipped, or reordered words and overlays persisted lexical fields. ChatGPT may choose the direction but must not add a word outside that queue. render_pretest_widget persists the complete card before returning it. Pretest stage changes use advance_study_session events pretest_question, pretest_result, listen_repeat, listen_recall, and pretest_complete; do not use model context to save them. The Widget determines the visible question from direction and ignores the compatibility prompt field. After a successful render_pretest_widget, render_review_widget_v2, or render_review_widget call, keep the chat quiet: do not explain how to use the Widget, repeat its questions, ask the user to answer in the chat box, report known / uncertain / unknown per item, or append product instructions. Only describe a Widget failure when the render call fails.

When the user asks for progress, call render_learning_dashboard directly; it ensures today's queue and then reads progress once inside the renderer. Keep get_progress for plain-text, debug, and legacy clients. When the user asks to import vocabulary, render_word_import. For a difficult sentence, let ChatGPT analyze it and call save_sentence. Never expose Shanbay credentials or server secrets to the user, Widget, tool arguments, or model context.
The embedded pronunciation flow is owned by the pretest Widget. Its final recall transition must durably write phase=pretest_complete before the Widget shows ready. After it sends the completion handoff, call get_study_bootstrap and follow its backend-owned action; if action=lesson, render LessonWidget mode=explain only for the returned word, and if action=pretest use the returned batch. Do not call render_pronunciation_cards again; that tool is for an independent pronunciation request only.

Formal learning uses the single render_lesson_widget with mode=explain, exercise, or feedback. Teach one backend-specified word at a time. The server validates the word against the active lesson cursor or the canonical next learning word before persisting the card. A new explain payload must include its complete exercise payload, and render_lesson_widget persists it before returning the card, including backend-derived navigation. After pronunciation/listening is complete, render the explain card; after the user starts practice, the Widget calls advance_study_session(lesson_start_exercise) and switches locally without a GPT turn; after grading and record_attempt, render self-contained feedback. The feedback payload must carry the original exercise and server-owned navigation. A retry calls advance_study_session(lesson_retry) and reuses that exercise without asking GPT for a new one. When navigation.action="next_word", send the exact next_word and render only that word. When navigation.action="round_complete", call advance_study_session({ event: "lesson_complete" }) once, then continue with the configured end-of-round handoff; do not query another word. lesson_complete is durable and idempotent, and resume must preserve the completed UI. Keep semantic grading in ChatGPT, but keep all teaching text and user input in the Widget. Example sentences and exercise prompts must be independent new scenes: never translate, reverse-translate, closely paraphrase, or make a minor noun substitution. Derivation practice, listening practice, long-sentence close, 20-word quizzes, and end-of-session free recall all reuse this same Widget.

render_lesson_widget, render_pretest_widget, and render_dictation_widget accept resume=true to restore the active persisted payload. Do not regenerate content already stored in the active session. Call finish_study_session only after the real learning wrap-up is complete; it clears the active cursor and allows a future new session.

After a successful render_pretest_widget, render_review_widget_v2, render_review_widget, render_lesson_widget, render_dictation_widget, or render_learning_dashboard call, keep the assistant turn quiet. Do not append “请在上面的卡片作答”, repeat questions, list the next word, repeat progress, ask the user to copy an answer into chat, or emit formal teaching prose. Only report a render failure.
`;

function registerWidgetResources(server: McpServer, loadWidgetHtml: WidgetHtmlLoader): void {
  const registerWidgetResource = (name: string, kind: WidgetKind, uri: string): void => {
    registerAppResource(server, name, uri, {
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
  };

  for (const [kind, uri] of Object.entries(WIDGET_URIS) as Array<[WidgetKind, string]>) {
    registerWidgetResource(`Wordloop ${kind} widget`, kind, uri);
  }
  registerWidgetResource("Wordloop lesson v3 alias", "lesson", LEGACY_WIDGET_URIS.lessonV3);
  registerWidgetResource("Wordloop lesson v2 alias", "lesson", LEGACY_WIDGET_URIS.lessonV2);
  registerWidgetResource("Wordloop lesson legacy widget", "lesson", LEGACY_WIDGET_URIS.lesson);
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
  registerGetStudyBootstrapTool(server);
  registerGetLearningContextTool(server);
  registerGetNextLearningWordTool(server);
  registerGetNextRoundTool(server);
  registerRecordPretestResultTool(server);
  registerRecordAttemptTool(server);
  registerRecordReviewResultTool(server);
  registerRecordReviewSubmissionTool(server);
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
