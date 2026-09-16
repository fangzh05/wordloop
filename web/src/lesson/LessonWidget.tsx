import { useEffect, useRef, useState } from "react";
import { ArrowIcon, PlayIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { FocusButton } from "../components/FocusButton.js";
import { callServerTool, sendUserMessage, subscribeToApp } from "../mcpBridge.js";
import { z } from "zod";
import {
  LESSON_WIDGET_VERSION,
  advanceStudySessionSchema,
  lessonNavigationSchema,
  lessonSubmissionSchema,
  type AdvanceStudySessionInput,
} from "../../../shared/toolContracts.js";

export { LESSON_WIDGET_VERSION } from "../../../shared/toolContracts.js";

export const LESSON_WIDGET_LOAD_ERROR = "WordLoop 学习卡版本不兼容，请重新打开学习。";

const exerciseSchema = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
}).strict();

const feedbackSchema = z.object({
  is_correct: z.boolean(),
  user_answer: z.string().max(4000),
  error_layer: z.string().trim().max(80).optional(),
  message: z.string().trim().max(1000).optional(),
  reference_answer: z.string().trim().max(4000).optional(),
  explanation: z.string().trim().max(4000).optional(),
  reveal_answer: z.boolean(),
}).strict();

const payloadCommon = {
  widget: z.literal("lesson"),
  title: z.string().trim().max(120).optional(),
  phase: z.enum(["lesson_explain", "lesson_exercise", "lesson_feedback", "lesson_complete"]).optional(),
  current_index: z.number().int().min(0).optional(),
  word: z.string().trim().min(1).max(100),
  widget_version: z.literal(LESSON_WIDGET_VERSION).optional(),
  // Old persisted payloads may omit this once; the server fills it on resume.
  navigation: lessonNavigationSchema.optional(),
};

const explainPayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("explain"),
  progress: z.string().trim().max(40).optional(),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(40),
  meaning_zh: z.string().trim().min(1).max(240),
  collocations: z.array(z.string().trim().min(1).max(200)).max(8),
  derivations: z.array(z.string().trim().min(1).max(200)).max(8),
  example_en: z.string().trim().min(1).max(1000),
  note: z.string().trim().min(1).max(1000),
  exercise: exerciseSchema,
}).passthrough();

const exercisePayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("exercise"),
  progress: z.string().trim().min(1).max(40),
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
}).passthrough();

const feedbackPayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("feedback"),
  progress: z.string().trim().min(1).max(40),
  exercise: exerciseSchema,
  feedback: feedbackSchema,
}).passthrough();

export const lessonPayloadSchema = z.discriminatedUnion("mode", [
  explainPayloadSchema,
  exercisePayloadSchema,
  feedbackPayloadSchema,
]);

type Payload = z.infer<typeof lessonPayloadSchema>;
type Mode = "explain" | "exercise" | "feedback";
type SubmitStatus = "idle" | "sending" | "sent" | "error";
export type NextLessonStatus = "idle" | "sending" | "sent" | "error";

type ExercisePayload = z.infer<typeof exerciseSchema>;
type FeedbackPayload = z.infer<typeof feedbackSchema>;

function exerciseFromPayload(payload: Payload): ExercisePayload {
  if (payload.mode === "exercise") {
    return {
      activity_type: payload.activity_type,
      instruction: payload.instruction,
      prompt: payload.prompt,
      multiline: payload.multiline,
    };
  }
  return payload.exercise;
}

function feedbackIsCorrect(feedback: FeedbackPayload | undefined): boolean {
  return feedback?.is_correct === true;
}

function feedbackRevealsAnswer(feedback: FeedbackPayload | undefined): boolean {
  return Boolean(feedback?.reveal_answer || feedback?.reference_answer);
}

function modeForPhase(phase: Payload["phase"]): Mode | null {
  if (phase === "lesson_exercise") return "exercise";
  if (phase === "lesson_feedback") return "feedback";
  if (phase === "lesson_explain") return "explain";
  return null;
}

export function buildLessonSubmissionMessage(input: {
  word: string;
  activityType: string;
  prompt: string;
  answer: string;
}): string {
  const submission = lessonSubmissionSchema.parse({
    word: input.word,
    activity_type: input.activityType,
    prompt: input.prompt,
    answer: input.answer,
  });
  return `提交 WordLoop 正式学习答案。\n\n目标词：${submission.word}\n练习类型：${submission.activity_type}\n题目：${submission.prompt}\n用户答案：${submission.answer.trim()}\n\n判定规则：若练习类型属于确定性题型（pretest_cn_to_en、listen_recall、spelling、word_recall），用确定性判分得到 is_correct 与 error_layer（不要凭语感判断；错误层只允许 none/spelling/meaning）；其余题型按 Teaching Prompt 做语义批改。然后调用 record_attempt 记录本次作答（record_attempt 只负责持久化，不会替你判分）。最后调用 render_lesson_widget mode=feedback，批改用词与解释由你负责。`;
}

export function buildLessonSessionAdvance(
  event: "lesson_start_exercise" | "lesson_retry" | "lesson_complete",
): AdvanceStudySessionInput {
  return advanceStudySessionSchema.parse({ event });
}

export function buildNextLessonMessage(nextWord: string): string {
  return `WordLoop backend 指定下一个学习词：\n${nextWord}\n\n请只为这个词按 Teaching Prompt 生成并渲染 LessonWidget mode=explain。\n不要自行更换单词。`;
}

export function buildRoundCompleteMessage(): string {
  return "WORDLOOP_ROUND_COMPLETE\n\nThe backend-owned frozen Lesson queue is complete.\nDo not call get_next_learning_word again.\nDo not select another vocabulary word.\nContinue directly with the configured end-of-round activity.";
}

export function canStartNextLesson(status: NextLessonStatus): boolean {
  return status === "idle" || status === "error";
}

export function LessonWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [localMode, setLocalMode] = useState<Mode | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [nextStatus, setNextStatus] = useState<NextLessonStatus>("idle");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [widgetLoadError, setWidgetLoadError] = useState("");
  const signatureRef = useRef("");
  const nextStatusRef = useRef<NextLessonStatus>("idle");
  const answerRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const speechAvailable = typeof window !== "undefined"
    && "speechSynthesis" in window
    && "SpeechSynthesisUtterance" in window;

  useEffect(() => {
    const unsubscribe = subscribeToApp((event) => {
      if (event.type !== "toolinput" && event.type !== "toolresult") return;
      const candidate = event.type === "toolinput"
        ? { widget: "lesson", ...event.value }
        : event.value.structuredContent;
      const parsed = lessonPayloadSchema.safeParse(candidate);
      if (!parsed.success) {
        // A resume tool input is a control message, not a render payload; the
        // following tool result is the authoritative payload for that call.
        if (event.type === "toolinput"
          && Object.keys(event.value).length === 1
          && event.value.resume === true) return;
        if (typeof process === "undefined" || process.env.NODE_ENV !== "production") {
          console.error(
            "LESSON_WIDGET_PAYLOAD_INVALID",
            parsed.error.issues.map(({ code, path }) => ({ code, path })),
          );
        }
        signatureRef.current = "";
        setPayload(null);
        setWidgetLoadError(LESSON_WIDGET_LOAD_ERROR);
        return;
      }
      const signature = JSON.stringify(parsed.data);
      if (signatureRef.current === signature) return;
      signatureRef.current = signature;
      setPayload(parsed.data);
      setLocalMode(null);
      setAnswer("");
      setSubmitStatus("idle");
      nextStatusRef.current = "idle";
      setNextStatus("idle");
      setError("");
      setWidgetLoadError("");
    });
    return unsubscribe;
  }, []);

  const mode = localMode ?? modeForPhase(payload?.phase) ?? payload?.mode ?? "explain";
  const exercise = payload ? exerciseFromPayload(payload) : null;
  const activityType = exercise?.activity_type ?? "";
  const exercisePrompt = exercise?.prompt ?? "";
  const instruction = exercise?.instruction ?? "";
  const multiline = exercise?.multiline ?? false;
  const currentWord = payload?.word ?? "";

  function play(): void {
    if (!speechAvailable || !currentWord) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(currentWord);
    utterance.lang = "en-US";
    utterance.rate = 0.9;
    utterance.onstart = () => setPlaying(true);
    utterance.onend = () => setPlaying(false);
    utterance.onerror = () => setPlaying(false);
    window.speechSynthesis.speak(utterance);
  }

  async function startExercise(): Promise<void> {
    if (!payload || payload.mode !== "explain") return;
    setError("");
    setAnswer("");
    setSubmitStatus("idle");
    try {
      if (!window.__WORDLOOP_PREVIEW__) {
        const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_start_exercise"));
        if (result.isError) throw new Error("无法保存练习阶段，请重试。");
      }
      setLocalMode("exercise");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法开始练习，请重试。");
    }
  }

  async function submitExercise(): Promise<void> {
    if (!payload || !exercisePrompt.trim() || !answer.trim() || submitStatus === "sending" || submitStatus === "sent") return;
    setSubmitStatus("sending");
    setError("");
    try {
      await sendUserMessage(buildLessonSubmissionMessage({
        word: currentWord,
        activityType,
        prompt: exercisePrompt,
        answer,
      }));
      setSubmitStatus("sent");
    } catch (caught) {
      setSubmitStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    }
  }

  async function nextLesson(): Promise<void> {
    if (!payload || !canStartNextLesson(nextStatusRef.current)) return;
    nextStatusRef.current = "sending";
    setNextStatus("sending");
    setError("");
    try {
      const navigation = payload.navigation;
      if (!navigation) throw new Error("LESSON_NAVIGATION_MISSING");
      if (navigation.action === "next_word") {
        await sendUserMessage(buildNextLessonMessage(navigation.next_word));
      } else {
        if (payload.phase !== "lesson_complete" && !window.__WORDLOOP_PREVIEW__) {
          const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_complete"));
          if (result.isError) throw new Error("无法保存本轮完成状态，请重试。");
        }
        await sendUserMessage(buildRoundCompleteMessage());
      }
      nextStatusRef.current = "sent";
      setNextStatus("sent");
    } catch (caught) {
      nextStatusRef.current = "error";
      setNextStatus("error");
      setError(caught instanceof Error ? caught.message : "无法进入下一步，请重试。");
    }
  }

  async function retryExercise(): Promise<void> {
    if (!payload || payload.mode !== "feedback") return;
    setSubmitStatus("sending");
    setError("");
    try {
      if (!window.__WORDLOOP_PREVIEW__) {
        const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_retry"));
        if (result.isError) throw new Error("无法保存重试阶段，请重试。");
      }
      setLocalMode("exercise");
      setAnswer("");
      setSubmitStatus("idle");
    } catch (caught) {
      setSubmitStatus("error");
      setError(caught instanceof Error ? caught.message : "无法开始重试，请重试。");
    }
  }

  if (!payload) {
    if (widgetLoadError) {
      return <section className="widget-card load-error" role="alert"><span>{widgetLoadError}</span></section>;
    }
    return <section className="widget-card skeleton" aria-busy="true"><span>正在加载学习内容…</span></section>;
  }

  if (mode === "exercise") {
    return <section className="widget-card lesson-card" aria-labelledby="lesson-exercise-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">{payload.title ?? "练习"}</span>
          <h1 id="lesson-exercise-title">{payload.progress ?? "当前练习"}</h1>
        </div>
        <FocusButton />
      </header>
      <div className="lesson-exercise-heading">
        <strong>{instruction}</strong>
      </div>
      <div className="lesson-prompt">{exercisePrompt}</div>
      {activityType === "listening" ? <button className="play-button lesson-audio" type="button" onClick={play} disabled={!speechAvailable} aria-label="播放听力">
        <span className="play-icon"><PlayIcon /></span>{speechAvailable ? (playing ? "正在播放" : "播放") : "当前设备无法播放"}
      </button> : null}
      <label className="answer-label" htmlFor="lesson-answer">你的答案</label>
      {multiline ? <textarea
        ref={(node) => { answerRef.current = node; }}
        id="lesson-answer"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="输入答案…"
        disabled={submitStatus === "sending" || submitStatus === "sent"}
        autoFocus
      /> : <input
        ref={(node) => { answerRef.current = node; }}
        id="lesson-answer"
        className="answer-input"
        type="text"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="输入英文…"
        disabled={submitStatus === "sending" || submitStatus === "sent"}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submitExercise();
          }
        }}
        autoFocus
      />}
      {submitStatus === "sent" ? <p className="answer-status" role="status">已提交，正在批改…</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <Button onClick={() => void submitExercise()} disabled={!answer.trim() || submitStatus === "sending" || submitStatus === "sent"}>
        {submitStatus === "sending" ? "正在提交…" : submitStatus === "sent" ? "已提交" : "提交"}
      </Button>
    </section>;
  }

  if (mode === "feedback" && payload.mode === "feedback") {
    const feedback = payload.feedback;
    const correct = feedbackIsCorrect(feedback);
    const reveal = feedbackRevealsAnswer(feedback);
    const roundComplete = payload.navigation?.action === "round_complete";
    const completed = payload.phase === "lesson_complete";
    const nextDisabled = nextStatus === "sending" || nextStatus === "sent";
    return <section className="widget-card lesson-card" aria-labelledby="lesson-feedback-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">批改</span>
          <h1 id="lesson-feedback-title">{completed ? "本轮词汇已完成" : correct ? "✓ 通过" : "需要修改"}</h1>
        </div>
        <FocusButton />
      </header>
      {feedback?.user_answer || answer ? <div className="lesson-answer"><span>你的答案</span><p>{feedback?.user_answer ?? answer}</p></div> : null}
      {!correct ? <div className="lesson-feedback">
        {feedback?.error_layer ? <p><strong>错误层：</strong>{feedback.error_layer}</p> : null}
        {feedback?.message ? <p>{feedback.message}</p> : null}
        {reveal && feedback?.reference_answer ? <p><strong>参考：</strong>{feedback.reference_answer}</p> : null}
        {reveal && feedback?.explanation ? <p><strong>解释：</strong>{feedback.explanation}</p> : null}
      </div> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {completed || roundComplete || correct || reveal
        ? <Button onClick={() => void nextLesson()} disabled={nextDisabled}>
          {nextStatus === "sending" ? "正在进入下一步…" : nextStatus === "sent" ? "已进入下一步" : roundComplete || completed ? "继续本轮收尾" : "下一词"}
          {nextStatus === "idle" || nextStatus === "error" ? <ArrowIcon className="button-icon trailing" /> : null}
        </Button>
        : <Button className="secondary" onClick={() => void retryExercise()} disabled={submitStatus === "sending"}>再试一次</Button>}
    </section>;
  }

  return <section className="widget-card lesson-card" aria-labelledby="lesson-explain-title">
    <header className="widget-header compact-header">
      <div>
        <span className="eyebrow">新词</span>
        <h1 id="lesson-explain-title">{payload.progress ?? "单词学习"}</h1>
      </div>
      <FocusButton />
    </header>
    <div className="lesson-word-heading">
      <strong>{payload.word}</strong>
      {payload.mode === "explain" && payload.part_of_speech ? <span className="part-of-speech">{payload.part_of_speech}</span> : null}
    </div>
    {payload.mode === "explain" && payload.ipa ? <div className="lesson-ipa">{payload.ipa}</div> : null}
    {payload.mode === "explain" ? <section className="lesson-section"><h2>核心义</h2><p>{payload.meaning_zh}</p></section> : null}
    {payload.mode === "explain" && payload.collocations.length ? <section className="lesson-section"><h2>高频搭配</h2><ul>{payload.collocations.map((entry) => <li key={entry}>{entry}</li>)}</ul></section> : null}
    {payload.mode === "explain" && payload.derivations.length ? <section className="lesson-section"><h2>词族</h2><ul>{payload.derivations.map((entry) => <li key={entry}>{entry}</li>)}</ul></section> : null}
    {payload.mode === "explain" ? <section className="lesson-section"><h2>例句</h2><p className="lesson-example">{payload.example_en}</p></section> : null}
    {payload.mode === "explain" ? <section className="lesson-section"><h2>补充</h2><p>{payload.note}</p></section> : null}
    <button className="play-button lesson-audio" type="button" onClick={play} disabled={!speechAvailable} aria-label={"播放 " + payload.word}>
      <span className="play-icon"><PlayIcon /></span>{speechAvailable ? (playing ? "正在播放" : "播放") : "当前设备无法播放"}
    </button>
    <Button onClick={() => void startExercise()}>开始练习 <ArrowIcon className="button-icon trailing" /></Button>
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </section>;
}
