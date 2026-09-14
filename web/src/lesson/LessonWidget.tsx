import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowIcon, PlayIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { sendUserMessage, subscribeToApp, updateModelContext } from "../mcpBridge.js";
import { z } from "zod";

const exerciseSchema = z.object({
  type: z.string().trim().max(80).optional(),
  activity_type: z.string().trim().max(80).optional(),
  instruction: z.string().trim().max(300).optional(),
  prompt: z.string().trim().max(4000).optional(),
  prompt_en: z.string().trim().max(4000).optional(),
  multiline: z.boolean().optional(),
});

const feedbackSchema = z.object({
  is_correct: z.boolean().optional(),
  result: z.string().optional(),
  status: z.string().optional(),
  error_layer: z.string().optional(),
  message: z.string().optional(),
  user_answer: z.string().optional(),
  reference_answer: z.string().optional(),
  explanation: z.string().optional(),
  reveal_answer: z.boolean().optional(),
});

const payloadSchema = z.object({
  widget: z.literal("lesson"),
  mode: z.enum(["explain", "exercise", "feedback"]).default("explain"),
  title: z.string().trim().max(120).optional(),
  progress: z.string().trim().max(40).optional(),
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().max(120).optional(),
  part_of_speech: z.string().trim().max(40).optional(),
  meaning_zh: z.string().trim().max(240).optional(),
  collocations: z.array(z.string().trim().max(200)).max(8).optional(),
  derivations: z.array(z.string().trim().max(200)).max(8).optional(),
  collocation: z.string().trim().max(200).optional(),
  example_en: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(1000).optional(),
  activity_type: z.string().trim().max(80).optional(),
  instruction: z.string().trim().max(300).optional(),
  prompt: z.string().trim().max(4000).optional(),
  prompt_en: z.string().trim().max(4000).optional(),
  multiline: z.boolean().optional(),
  exercise: exerciseSchema.optional(),
  feedback: feedbackSchema.optional(),
});

type Payload = z.infer<typeof payloadSchema>;
type Mode = "explain" | "exercise" | "feedback";
type SubmitStatus = "idle" | "sending" | "sent" | "error";
type ExerciseContext = {
  word: string;
  title?: string;
  progress?: string;
  activityType: string;
  instruction: string;
  prompt: string;
  multiline: boolean;
};

function listValues(values: string[] | undefined, fallback: string | undefined): string[] {
  if (values?.length) return values;
  return fallback ? [fallback] : [];
}

function firstText(...values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim())) ?? "";
}

function isMultilineActivity(activityType: string): boolean {
  return activityType === "recall"
    || activityType === "free_recall"
    || activityType === "session_recall"
    || activityType === "long_sentence";
}

function extractExerciseContext(nextPayload: Payload): ExerciseContext | null {
  const nested = nextPayload.exercise;
  const activityType = firstText(nextPayload.activity_type, nested?.activity_type, nested?.type) || "sentence";
  const prompt = firstText(nextPayload.prompt, nextPayload.prompt_en, nested?.prompt, nested?.prompt_en);
  if (!prompt) return null;
  return {
    word: nextPayload.word,
    title: nextPayload.title,
    progress: nextPayload.progress,
    activityType,
    instruction: firstText(nextPayload.instruction, nested?.instruction) || `使用 ${nextPayload.word} 完成练习`,
    prompt,
    multiline: nextPayload.multiline ?? nested?.multiline ?? isMultilineActivity(activityType),
  };
}

function feedbackIsCorrect(feedback: Payload["feedback"]): boolean {
  if (!feedback) return false;
  return feedback.is_correct === true
    || feedback.result === "correct"
    || feedback.result === "known"
    || feedback.status === "correct";
}

function feedbackRevealsAnswer(feedback: Payload["feedback"]): boolean {
  return Boolean(feedback?.reveal_answer || feedback?.reference_answer);
}

export function LessonWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [localMode, setLocalMode] = useState<Mode | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const signatureRef = useRef("");
  const exerciseContextRef = useRef<ExerciseContext | null>(null);
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
      const parsed = payloadSchema.safeParse(candidate);
      if (!parsed.success) return;
      const signature = JSON.stringify(parsed.data);
      if (signatureRef.current === signature) return;
      signatureRef.current = signature;
      const nextExerciseContext = extractExerciseContext(parsed.data);
      if (parsed.data.mode === "exercise" || (parsed.data.mode === "explain" && nextExerciseContext)) {
        exerciseContextRef.current = nextExerciseContext;
      } else if (parsed.data.mode === "explain") {
        exerciseContextRef.current = null;
      }
      setPayload(parsed.data);
      setLocalMode(null);
      setAnswer("");
      setSubmitStatus("idle");
      setError("");
    });
    return unsubscribe;
  }, []);

  const mode = localMode ?? payload?.mode ?? "explain";
  const nestedExercise = payload?.exercise;
  const retainedExercise = payload?.mode === "feedback" && exerciseContextRef.current?.word === payload.word
    ? exerciseContextRef.current
    : null;
  const activityType = firstText(payload?.activity_type, nestedExercise?.activity_type, nestedExercise?.type, retainedExercise?.activityType) || "sentence";
  const exercisePrompt = firstText(payload?.prompt, payload?.prompt_en, nestedExercise?.prompt, nestedExercise?.prompt_en, retainedExercise?.prompt);
  const instruction = firstText(payload?.instruction, nestedExercise?.instruction, retainedExercise?.instruction) || (payload?.word ? "使用 " + payload.word + " 完成练习" : "");
  const multiline = payload?.multiline ?? nestedExercise?.multiline ?? retainedExercise?.multiline ?? isMultilineActivity(activityType);

  const collocations = useMemo(() => listValues(payload?.collocations, payload?.collocation), [payload?.collocations, payload?.collocation]);
  const derivations = payload?.derivations ?? [];
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

  function startExercise(): void {
    setError("");
    setAnswer("");
    setSubmitStatus("idle");
    if (exercisePrompt) {
      setLocalMode("exercise");
      return;
    }
    void requestExercise();
  }

  async function requestExercise(): Promise<void> {
    try {
      await updateModelContext("开始 WordLoop 正式练习。", { word: currentWord, lessonAction: "start_exercise" });
      await sendUserMessage("开始 WordLoop 正式练习，请直接渲染练习卡片。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法开始练习，请重试。");
    }
  }

  async function submitExercise(): Promise<void> {
    if (!payload || !exercisePrompt.trim() || !answer.trim() || submitStatus === "sending" || submitStatus === "sent") return;
    setSubmitStatus("sending");
    setError("");
    try {
      await updateModelContext("WordLoop 正式学习答案已提交。", {
        word: currentWord,
        activity_type: activityType,
        exercise_prompt: exercisePrompt,
        user_answer: answer.trim(),
      });
      await sendUserMessage("提交 WordLoop 正式学习答案。");
      setSubmitStatus("sent");
    } catch (caught) {
      setSubmitStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    }
  }

  async function nextLesson(): Promise<void> {
    if (!payload) return;
    try {
      await updateModelContext("WordLoop 当前单词已完成，请进入下一个词。", { lessonAction: "next_word", word: currentWord });
      await sendUserMessage("开始下一个 WordLoop 单词。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法进入下一个词，请重试。");
    }
  }

  function retryExercise(): void {
    setLocalMode("exercise");
    setAnswer("");
    setSubmitStatus("idle");
    setError("");
  }

  if (!payload) {
    return <section className="widget-card skeleton" aria-busy="true"><span>正在加载学习内容…</span></section>;
  }

  if (mode === "exercise") {
    return <section className="widget-card lesson-card" aria-labelledby="lesson-exercise-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">{payload.title ?? "练习"}</span>
          <h1 id="lesson-exercise-title">{payload.progress ?? "当前练习"}</h1>
        </div>
      </header>
      <div className="lesson-exercise-heading">
        <strong>{instruction}</strong>
      </div>
      <div className="lesson-prompt">{exercisePrompt || "请等待练习题目。"}</div>
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

  if (mode === "feedback") {
    const feedback = payload.feedback;
    const correct = feedbackIsCorrect(feedback);
    const reveal = feedbackRevealsAnswer(feedback);
    return <section className="widget-card lesson-card" aria-labelledby="lesson-feedback-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">批改</span>
          <h1 id="lesson-feedback-title">{correct ? "✓ 通过" : "需要修改"}</h1>
        </div>
      </header>
      {feedback?.user_answer || answer ? <div className="lesson-answer"><span>你的答案</span><p>{feedback?.user_answer ?? answer}</p></div> : null}
      {!correct ? <div className="lesson-feedback">
        {feedback?.error_layer ? <p><strong>错误层：</strong>{feedback.error_layer}</p> : null}
        {feedback?.message ? <p>{feedback.message}</p> : null}
        {reveal && feedback?.reference_answer ? <p><strong>参考：</strong>{feedback.reference_answer}</p> : null}
        {reveal && feedback?.explanation ? <p><strong>解释：</strong>{feedback.explanation}</p> : null}
      </div> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {correct || reveal
        ? <Button onClick={() => void nextLesson()}>下一词 <ArrowIcon className="button-icon trailing" /></Button>
        : <Button className="secondary" onClick={retryExercise}>再试一次</Button>}
    </section>;
  }

  return <section className="widget-card lesson-card" aria-labelledby="lesson-explain-title">
    <header className="widget-header compact-header">
      <div>
        <span className="eyebrow">新词</span>
        <h1 id="lesson-explain-title">{payload.progress ?? "单词学习"}</h1>
      </div>
    </header>
    <div className="lesson-word-heading">
      <strong>{payload.word}</strong>
      {payload.part_of_speech ? <span className="part-of-speech">{payload.part_of_speech}</span> : null}
    </div>
    {payload.ipa ? <div className="lesson-ipa">{payload.ipa}</div> : null}
    {payload.meaning_zh ? <section className="lesson-section"><h2>核心义</h2><p>{payload.meaning_zh}</p></section> : null}
    {collocations.length ? <section className="lesson-section"><h2>高频搭配</h2><ul>{collocations.map((entry) => <li key={entry}>{entry}</li>)}</ul></section> : null}
    {derivations.length ? <section className="lesson-section"><h2>词族</h2><ul>{derivations.map((entry) => <li key={entry}>{entry}</li>)}</ul></section> : null}
    {payload.example_en ? <section className="lesson-section"><h2>例句</h2><p className="lesson-example">{payload.example_en}</p></section> : null}
    {payload.note ? <section className="lesson-section"><h2>补充</h2><p>{payload.note}</p></section> : null}
    <button className="play-button lesson-audio" type="button" onClick={play} disabled={!speechAvailable} aria-label={"播放 " + payload.word}>
      <span className="play-icon"><PlayIcon /></span>{speechAvailable ? (playing ? "正在播放" : "播放") : "当前设备无法播放"}
    </button>
    <Button onClick={startExercise}>开始练习 <ArrowIcon className="button-icon trailing" /></Button>
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </section>;
}
