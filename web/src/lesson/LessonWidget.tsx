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

export const LESSON_WIDGET_LOAD_ERROR = "WordLoop 学习卡数据不完整，请重新进入学习。";
export const LESSON_WIDGET_REFRESH_ERROR = "WordLoop 未能刷新学习卡，请重试。";

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
  wrapup: z.literal(true).optional(),
  progress: z.string().trim().min(1).max(40),
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
}).passthrough();

const feedbackPayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("feedback"),
  wrapup: z.literal(true).optional(),
  progress: z.string().trim().min(1).max(40),
  exercise: exerciseSchema,
  feedback: feedbackSchema,
}).passthrough();

export const lessonPayloadSchema = z.discriminatedUnion("mode", [
  explainPayloadSchema,
  exercisePayloadSchema,
  feedbackPayloadSchema,
]);

export type LessonPayload = z.infer<typeof lessonPayloadSchema>;
type Payload = LessonPayload;
type Mode = "explain" | "exercise" | "feedback";
type SubmitStatus = "idle" | "sending" | "sent" | "error";
export type NextLessonStatus = "idle" | "sending" | "sent" | "error";

export function isLessonRenderCandidate(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === "explain" || mode === "exercise" || mode === "feedback";
}

type LessonAppEvent =
  | { type: "toolinput"; value: Record<string, unknown> }
  | { type: "toolresult"; value: { structuredContent?: unknown } };

export type LessonAppEventRoute =
  | { kind: "ignore" }
  | { kind: "invalid"; blocking: boolean; issues: z.ZodIssue[] }
  | { kind: "render"; payload: LessonPayload; signature: string; duplicate: boolean };

function normalizeLessonTransportPayload(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const navigation = candidate.navigation;
  if (typeof navigation !== "object" || navigation === null || Array.isArray(navigation)) return value;
  const navigationRecord = navigation as Record<string, unknown>;
  if (navigationRecord.action !== "round_complete") return value;

  // Some ChatGPT transports omit null-valued object fields. Restore the
  // explicit terminal values before validating against the strict contract.
  return {
    ...candidate,
    navigation: {
      ...navigationRecord,
      next_word: navigationRecord.next_word ?? null,
      next_index: navigationRecord.next_index ?? null,
    },
  };
}

export function routeLessonAppEvent(
  event: LessonAppEvent,
  hasLastGoodPayload: boolean,
  lastSignature = "",
): LessonAppEventRoute {
  if (event.type === "toolinput") return { kind: "ignore" };

  const candidate = event.value.structuredContent;
  if (!isLessonRenderCandidate(candidate) || (candidate as { widget?: unknown }).widget !== "lesson") {
    return { kind: "ignore" };
  }

  const parsed = lessonPayloadSchema.safeParse(normalizeLessonTransportPayload(candidate));
  if (!parsed.success) {
    return { kind: "invalid", blocking: !hasLastGoodPayload, issues: parsed.error.issues };
  }
  const signature = JSON.stringify(parsed.data);
  return { kind: "render", payload: parsed.data, signature, duplicate: signature === lastSignature };
}

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
  return feedback?.reveal_answer === true;
}

/**
 * The first incorrect attempt should still teach the user how to self-correct.
 * `reference_answer` remains gated by `reveal`, while `explanation` is the
 * actionable hint that is safe to show before the full answer.
 */
export function feedbackGuidanceLabel(reveal: boolean): string {
  return reveal ? "解释" : "错因与改法";
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
  return `提交 WordLoop 正式学习答案。\n\n目标词：${submission.word}\n练习类型：${submission.activity_type}\n题目：${submission.prompt}\n用户答案：${submission.answer.trim()}\n\n判定规则：若练习类型属于确定性题型（pretest_cn_to_en、listen_recall、spelling、word_recall），用确定性判分得到 is_correct 与 error_layer（不要凭语感判断；错误层只允许 none/spelling/meaning）；其余题型按 Teaching Prompt 做语义批改。然后调用 record_attempt 记录本次作答（record_attempt 只负责持久化，不会替你判分）。最后调用 render_lesson_widget mode=feedback，批改用词与解释由你负责。\n\n错误反馈必须帮助用户自纠：第一次答错时，message 要指出用户答案中的至少一个具体错误片段或位置，不能只写“有几处错误”或只报错误层；explanation 要说明为什么错以及下一步改哪里/怎么改，但不能给出完整改后句。第一次答错时设 reveal_answer=false 并省略 reference_answer。只有连续第二次仍错时，才可以提供 reference_answer 和完整 explanation，并设 reveal_answer=true。`;
}

export function buildLessonWrapupSubmissionMessage(input: {
  word: string;
  prompt: string;
  answer: string;
}): string {
  const submission = lessonSubmissionSchema.parse({
    word: input.word,
    activity_type: "sentence",
    prompt: input.prompt,
    answer: input.answer,
  });
  return `提交 WordLoop 长难句收尾答案。\n\n最后一个 Lesson 词（仅作 backend 收尾锚点）：${submission.word}\n练习类型：sentence\n题目：${submission.prompt}\n用户答案：${submission.answer.trim()}\n\n这是本轮唯一一次长难句收尾，不要生成第二句，也不要把答案改成聊天区教学。请先按结构、语义、翻译腔三层批改，再调用 record_attempt 记录本次普通收尾作答（word 必须使用上面的精确锚点，activity_type=sentence；record_attempt 不推进 FSRS）。然后调用 render_lesson_widget mode=feedback、wrapup=true，继续使用同一个 word、原 exercise 和这次 feedback。第一次答错时 message 必须指出用户答案中的具体错误片段或位置，explanation 必须说明为什么错以及下一步改哪里/怎么改，但不得给完整改后句；设置 reveal_answer=false 并省略 reference_answer。只有连续第二次仍错时才可以提供 reference_answer 和完整 explanation，并设置 reveal_answer=true。收尾 feedback 持久化后，先不要自行开始会话末自由回忆；等 Widget 的完成操作再调用 finish_study_session exactly once，然后立即调用 get_study_bootstrap。`;
}

export function buildLessonSessionAdvance(
  event: "lesson_start_exercise" | "lesson_retry" | "lesson_complete",
): AdvanceStudySessionInput {
  return advanceStudySessionSchema.parse({ event });
}

export function buildNextLessonMessage(nextWord: string): string {
  return `WordLoop backend 指定下一个学习词：\n${nextWord}\n\n请只为这个词按 Teaching Prompt 生成并渲染 LessonWidget mode=explain。\n不要自行更换单词。`;
}

export function buildRoundCompleteMessage(finalWord?: string): string {
  const anchor = finalWord?.trim();
  return [
    "WORDLOOP_ROUND_COMPLETE",
    "",
    "The current Lesson round is complete.",
    "",
    "This is ROUND completion, not SESSION completion.",
    "",
    "Do exactly one round-end activity:",
    "generate one 考研英语一难度 long sentence naturally using",
    "2–3 words from this completed round.",
    "",
    "Render that sentence in the existing LessonWidget, not as chat text.",
    "Call render_lesson_widget with mode=exercise, wrapup=true,",
    ...(anchor ? [`word=${anchor} (the exact final Lesson word; bookkeeping anchor only),`] : ["word set to the exact final Lesson word from the completed card,"]),
    "activity_type=sentence, multiline=true, and an instruction to",
    "identify the sentence backbone first (subject + verb + core object",
    "or predicative), then translate it.",
    "",
    "Do NOT start session-end free recall.",
    "Do NOT ask the user to list all learned words.",
    "Do NOT repeat this round-complete instruction.",
    "Do NOT render another vocabulary explain card or send the sentence",
    "only in the chat; the required wrap-up exercise must be in the card.",
    "",
    "Only when the user explicitly says:",
    "结束学习 / 今天到这里 / 不学了",
    "",
    "enter session-end free recall.",
  ].join("\n");
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
  const lastGoodPayloadRef = useRef<Payload | null>(null);
  const nextStatusRef = useRef<NextLessonStatus>("idle");
  const answerRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const speechAvailable = typeof window !== "undefined"
    && "speechSynthesis" in window
    && "SpeechSynthesisUtterance" in window;

  useEffect(() => {
    const unsubscribe = subscribeToApp((event) => {
      if (event.type !== "toolinput" && event.type !== "toolresult") return;
      const routed = routeLessonAppEvent(event, lastGoodPayloadRef.current !== null, signatureRef.current);
      if (routed.kind === "ignore") return;
      if (routed.kind === "invalid") {
        if (typeof process === "undefined" || process.env.NODE_ENV !== "production") {
          console.error(
            "LESSON_WIDGET_PAYLOAD_INVALID",
            JSON.stringify(routed.issues.map(({ code, path }) => ({ code, path }))),
          );
        }
        if (routed.blocking) setWidgetLoadError(LESSON_WIDGET_LOAD_ERROR);
        else setError(LESSON_WIDGET_REFRESH_ERROR);
        return;
      }
      if (routed.duplicate) return;
      signatureRef.current = routed.signature;
      lastGoodPayloadRef.current = routed.payload;
      setPayload(routed.payload);
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
      const message = payload.mode !== "explain" && payload.wrapup === true
        ? buildLessonWrapupSubmissionMessage({ word: currentWord, prompt: exercisePrompt, answer })
        : buildLessonSubmissionMessage({
          word: currentWord,
          activityType,
          prompt: exercisePrompt,
          answer,
        });
      await sendUserMessage(message);
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
      if (payload.mode !== "explain" && payload.wrapup === true) {
        await sendUserMessage("WordLoop 长难句收尾已完成批改。请现在调用 finish_study_session exactly once，然后立即调用 get_study_bootstrap 继续当天剩余学习；不要开始会话末自由回忆，也不要再次生成长难句。成功渲染下一张 Widget 后保持聊天区安静。");
        nextStatusRef.current = "sent";
        setNextStatus("sent");
        return;
      }
      const navigation = payload.navigation;
      if (!navigation) throw new Error("LESSON_NAVIGATION_MISSING");
      if (navigation.action === "next_word") {
        await sendUserMessage(buildNextLessonMessage(navigation.next_word));
      } else {
        if (payload.phase !== "lesson_complete" && !window.__WORDLOOP_PREVIEW__) {
          const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_complete"));
          if (result.isError) throw new Error("无法保存本轮完成状态，请重试。");
        }
        await sendUserMessage(buildRoundCompleteMessage(currentWord));
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
      if (!payload.wrapup && !window.__WORDLOOP_PREVIEW__) {
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
          <span className="eyebrow">{payload.wrapup ? "长难句收尾" : payload.title ?? "练习"}</span>
          <h1 id="lesson-exercise-title">{payload.wrapup ? "先找主干，再翻译" : payload.progress ?? "当前练习"}</h1>
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
    const wrapup = payload.wrapup === true;
    const roundComplete = payload.navigation?.action === "round_complete";
    const completed = payload.phase === "lesson_complete";
    const canContinue = wrapup ? correct || reveal : completed || roundComplete || correct || reveal;
    const nextDisabled = nextStatus === "sending" || nextStatus === "sent";
    return <section className="widget-card lesson-card" aria-labelledby="lesson-feedback-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">{wrapup ? "长难句收尾批改" : "批改"}</span>
          <h1 id="lesson-feedback-title">{wrapup ? (correct ? "收尾完成" : "需要修改") : completed ? "本轮词汇已完成" : correct ? "✓ 通过" : "需要修改"}</h1>
        </div>
        <FocusButton />
      </header>
      {feedback?.user_answer || answer ? <div className="lesson-answer"><span>你的答案</span><p>{feedback?.user_answer ?? answer}</p></div> : null}
      {!correct ? <div className="lesson-feedback">
        {feedback?.error_layer ? <p><strong>错误层：</strong>{feedback.error_layer}</p> : null}
        {feedback?.message ? <p><strong>问题：</strong>{feedback.message}</p> : null}
        {reveal && feedback?.reference_answer ? <p><strong>参考：</strong>{feedback.reference_answer}</p> : null}
        {feedback?.explanation ? <p><strong>{feedbackGuidanceLabel(reveal)}：</strong>{feedback.explanation}</p> : null}
      </div> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {canContinue
        ? <Button onClick={() => void nextLesson()} disabled={nextDisabled}>
          {nextStatus === "sending" ? "正在进入下一步…" : nextStatus === "sent" ? "已进入下一步" : wrapup ? "完成收尾并继续学习" : roundComplete || completed ? "继续本轮收尾" : "下一词"}
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
