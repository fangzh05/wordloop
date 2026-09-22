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
import { registerGetPronunciationAudioTool } from "./tools/getPronunciationAudio.js";
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

WordLoop backend owns authenticated persistent state, Review selection and order, Lesson selection and navigation, and FSRS due timing. ChatGPT owns teaching content, exercise wording, semantic grading, explanations, and natural-language feedback; the server does not call the model. Never invent stored progress or use conversation history to reconstruct state.

### Start, action, and resume

For “开始学习”“继续学习”“wordloop 开始” or “wordloop 继续”, the first call is get_study_bootstrap. Follow its action exactly: resume restores the returned widget with resume=true; review calls a server-owned Review render tool without review items; pretest renders only the returned words; lesson teaches and renders only the returned word; done means there is no remaining backend work. Do not infer the current position, choose a word, or turn resume into a fresh flow.

An active session always resumes its persisted payload, including an active lesson_complete state. Do not rebuild an exercise from chat, regenerate saved content, reorder a queue, or finish that session before its persisted round handoff is answered and graded. After the pretest Widget completes its durable handoff, call get_study_bootstrap and follow the new action; its embedded pronunciation flow does not use the independent pronunciation tool.

The pretest Widget accepts only cn_to_en or en_definition and only the backend-returned batch. Choose the direction when needed, but never add, skip, or reorder words. For a user-requested dictation, use the Dictation Widget; its original is hidden by default.

### Backend-owned Review and attempt boundaries

Review cards, order, due status, and FSRS scheduling come from the backend. Review uses only the backend's due snapshot; render_review_widget_v2 is preferred and legacy render_review_widget is the compatibility fallback. Never pass, replace, omit, reorder, or prefetch review items.

Use record_attempt for ordinary practice and error-layer repair; it never advances FSRS. The Review Widget alone uses record_review_submission for a real due Review. Use record_review_result only for a due, new, unprompted independent retrieval, including a valid FSRS learning or relearning checkpoint. Immediate repetition after seeing an answer, just-taught practice, self-correction, shadowing, not-yet-due repair, default quizzes, and free recall are not review results. Pretest is the initial retrieval and advances FSRS once through its dedicated path.

Preserve the rating meanings: Again = failed or prompted retrieval; Hard = independent but effortful; Good = normal independent recall; Easy = immediate, stable independent recall. A one-edit spelling near miss is correct + Hard + spelling when a rating is required.

### Backend-owned Lesson progression

The Lesson queue is the frozen flow.lesson_words. Normal progression follows render_lesson_widget's payload.navigation: for action="next_word", render only the exact navigation.next_word; never choose or fetch a replacement word. For action="round_complete", do not call get_next_learning_word or any other tool to find another word. round_complete means the vocabulary round ended, not the whole study session.

After the WORDLOOP_ROUND_COMPLETE handoff, generate exactly one long-sentence wrap-up in the existing LessonWidget: mode=exercise, wrapup=true, activity_type=sentence, multiline=true, anchored to the exact final Lesson word. Keep the sentence and answer in the Widget. Do not finish early, start session-end free recall, or emit another equivalent wrap-up. After the user's answer is graded and feedback is persisted, call finish_study_session exactly once, then immediately call get_study_bootstrap to continue the day's remaining work.

### Widget and chat boundary

After any successful learning, Review, pretest, dictation, or progress Widget render, keep the chat quiet: do not repeat the card, answer, instructions, progress, next word, or teaching prose. Only explain a render failure. All Widget input and persisted feedback stay in the Widget; ChatGPT supplies the teaching and semantic grading.

For “进度”, use render_learning_dashboard; for “句子：xxx”, analyze the sentence and use save_sentence. “抽查”“小测”“听写” start their corresponding backend flow. Do not expose credentials or server secrets.
`;

const WIDGET_UI_META = {
  prefersBorder: true,
  csp: {
    connectDomains: [] as string[],
    resourceDomains: [
      "https://media.merriam-webster.com",
      "https://dictionaryapi.com",
    ],
  },
};

function registerWidgetResources(server: McpServer, loadWidgetHtml: WidgetHtmlLoader): void {
  const registerWidgetResource = (name: string, kind: WidgetKind, uri: string): void => {
    registerAppResource(server, name, uri, {
      description: `Wordloop ${kind} interactive view`,
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: WIDGET_UI_META },
    }, async () => ({
      contents: [{
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await loadWidgetHtml(kind),
        _meta: { ui: WIDGET_UI_META },
      }],
    }));
  };

  for (const [kind, uri] of Object.entries(WIDGET_URIS) as Array<[WidgetKind, string]>) {
    registerWidgetResource(`Wordloop ${kind} widget`, kind, uri);
  }
  registerWidgetResource("Wordloop lesson v5 alias", "lesson", LEGACY_WIDGET_URIS.lessonV5);
  registerWidgetResource("Wordloop lesson v4 alias", "lesson", LEGACY_WIDGET_URIS.lessonV4);
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
  registerGetPronunciationAudioTool(server);
  registerRenderTools(server);
  registerWidgetResources(server, loadWidgetHtml);
  return server;
}
