import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowIcon, PlayIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { callServerTool, requestFocusMode, sampleHostText, sendUserMessage, subscribeToApp, updateModelContext } from "../mcpBridge.js";

const itemSchema = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(40),
  meaning_zh: z.string().trim().min(1).max(240),
  // `prompt` and `en_definition` are accepted as compatibility aliases for
  // older cards, but the product now has only two deterministic directions.
  prompt: z.string().trim().max(1000).default(""),
  direction: z.enum(["cn_to_en", "en_to_cn", "en_definition"]).default("cn_to_en"),
});

const payloadSchema = z.object({
  widget: z.literal("pretest"),
  items: z.array(itemSchema).min(1).max(7),
  current_index: z.number().int().min(0).max(6).optional(),
  title: z.string().trim().min(1).max(100).optional(),
});

type Payload = z.infer<typeof payloadSchema>;
type AnswerStatus = "idle" | "sending" | "sent" | "error";
type PretestResult = "known" | "uncertain" | "unknown";
type GradedAnswer = { word: string; answer: string; result: PretestResult; feedback: string };

const gradeSchema = z.object({
  result: z.enum(["known", "uncertain", "unknown"]),
  feedback: z.string().trim().min(1).max(180),
});

const gradeSystemPrompt = "You grade one English vocabulary pretest answer. Return strict JSON only. Do not teach or add markdown.";

function parseGrade(raw: string): z.infer<typeof gradeSchema> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("ChatGPT 返回的批改格式无效，请重试。");
  const parsed = gradeSchema.safeParse(JSON.parse(match[0]));
  if (!parsed.success) throw new Error("ChatGPT 返回的批改格式无效，请重试。");
  return parsed.data;
}

function resultLabel(result: PretestResult): string {
  if (result === "known") return "已会";
  if (result === "uncertain") return "模糊";
  return "不会";
}

function directionLabel(direction: Payload["items"][number]["direction"]): string {
  return direction === "cn_to_en" ? "中文 → 英文" : "英文 → 中文";
}

export function PretestWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<AnswerStatus>("idle");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<GradedAnswer | null>(null);
  const [results, setResults] = useState<GradedAnswer[]>([]);
  const [completed, setCompleted] = useState(false);
  const [showPronunciation, setShowPronunciation] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [focusModeMessage, setFocusModeMessage] = useState("");
  const [continueStatus, setContinueStatus] = useState<AnswerStatus>("idle");
  const answerRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const interactionStartedRef = useRef(false);
  const payloadSignatureRef = useRef("");
  const speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput"
      ? { widget: "pretest", ...event.value }
      : event.value.structuredContent;
    const parsed = payloadSchema.safeParse(candidate);
    if (!parsed.success) return;
    const signature = JSON.stringify(parsed.data);
    if (payloadSignatureRef.current === signature) return;
    payloadSignatureRef.current = signature;
    const nextIndex = Math.min(parsed.data.current_index ?? 0, parsed.data.items.length - 1);
    setPayload(parsed.data);
    setIndex(nextIndex);
    setAnswer("");
    setError("");
    setFeedback(null);
    setResults([]);
    setCompleted(false);
    setShowPronunciation(false);
    setStatus("idle");

    if (!window.__WORDLOOP_PREVIEW__) {
      void restoreSavedProgress(parsed.data);
    }
  }), []);

  async function restoreSavedProgress(nextPayload: Payload): Promise<void> {
    try {
      const stored = await callServerTool("get_learning_context", {});
      if (stored.isError) return;
      const context = z.object({
        today_words: z.array(z.object({
          word: z.string(),
          status: z.enum(["new", "known", "uncertain", "unknown", "review", "mastered"]),
        })),
      }).safeParse(stored.structuredContent);
      if (!context.success || interactionStartedRef.current) return;
      const statusByWord = new Map(context.data.today_words.map((entry) => [entry.word, entry.status]));
      const restored = nextPayload.items.flatMap((entry): GradedAnswer[] => {
        const saved = statusByWord.get(entry.word.toLocaleLowerCase());
        if (!saved || saved === "new") return [];
        const result: PretestResult = saved === "known" || saved === "mastered"
          ? "known"
          : saved === "uncertain" ? "uncertain" : "unknown";
        return [{ word: entry.word, answer: "", result, feedback: "已从 Wordloop 恢复。" }];
      });
      if (restored.length === 0) return;
      setResults(restored);
      const pendingIndex = nextPayload.items.findIndex((entry) => !restored.some((saved) => saved.word === entry.word));
      if (pendingIndex === -1) {
        setIndex(nextPayload.items.length - 1);
        setFeedback(restored.at(-1) ?? null);
        setStatus("sent");
        setCompleted(true);
      } else {
        setIndex(pendingIndex);
        setAnswer("");
        setFeedback(null);
        setStatus("idle");
        requestAnimationFrame(() => answerRef.current?.focus());
      }
    } catch {
      // The card remains usable if a transient restore read fails.
    }
  }

  const item = payload?.items[index];

  // Keep the card deterministic: Chinese → English shows the Chinese meaning;
  // English → Chinese shows the English word. `prompt` is only a legacy field
  // and must never change the direction of the question.
  const isChineseToEnglish = item?.direction === "cn_to_en";
  const questionPrompt = item ? (isChineseToEnglish ? item.meaning_zh : item.word) : "";

  async function submit(): Promise<void> {
    if (!payload || !item || !answer.trim() || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    interactionStartedRef.current = true;
    const cleanAnswer = answer.trim();
    setStatus("sending");
    setError("");
    try {
      const grade = window.__WORDLOOP_PREVIEW__
        ? { result: (isChineseToEnglish
            ? cleanAnswer.toLocaleLowerCase() === item.word.toLocaleLowerCase()
            : cleanAnswer === item.meaning_zh) ? "known" as const : "unknown" as const, feedback: "预览模式：答案已在卡片内完成判定。" }
        : parseGrade(await sampleHostText(
          `目标词：${item.word}\n题目方向：${item.direction}\n题面：${questionPrompt}\n目标中文核心义：${item.meaning_zh}\n用户答案：${cleanAnswer}\n\n判定规则：中文→英文时，答案应准确写出目标英文单词；英文→中文时，答案应准确表达目标中文核心义。known=独立且准确；uncertain=方向正确但有轻微拼写或释义不完整；unknown=答案错误、无关或没有完成对应方向。用中文写一句不超过40字的具体反馈。只返回 {"result":"known|uncertain|unknown","feedback":"..."}。`,
          gradeSystemPrompt,
        ));
      await saveGrade(cleanAnswer, grade, false);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    } finally {
      submittingRef.current = false;
    }
  }

  async function saveGrade(cleanAnswer: string, grade: { result: PretestResult; feedback: string }, advanceImmediately: boolean): Promise<void> {
    if (!payload || !item) return;
    if (!window.__WORDLOOP_PREVIEW__) {
      const stored = await callServerTool("record_pretest_result", {
        word: item.word,
        result: grade.result,
        user_answer: cleanAnswer,
        // Keep the persisted activity enum backward-compatible while the UI
        // exposes the corrected English → Chinese direction.
        activity_type: item.direction === "cn_to_en" ? "pretest_cn_to_en" : "pretest_en_definition",
      });
      if (stored.isError) throw new Error("结果未能保存，请重试。");
    }
    const graded = { word: item.word, answer: cleanAnswer, ...grade };
    setResults((current) => [...current.filter((entry) => entry.word !== item.word), graded]);
    if (index === payload.items.length - 1) {
      setFeedback(graded);
      setStatus("sent");
      setCompleted(true);
      return;
    }
    if (advanceImmediately) {
      setIndex((value) => value + 1);
      setAnswer("");
      setFeedback(null);
      setStatus("idle");
      requestAnimationFrame(() => answerRef.current?.focus());
      return;
    }
    setFeedback(graded);
    setStatus("sent");
  }

  async function markUnknown(): Promise<void> {
    if (!payload || !item || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    interactionStartedRef.current = true;
    setStatus("sending");
    setError("");
    try {
      await saveGrade("", { result: "unknown", feedback: "已直接标记为不会。" }, true);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "结果未能保存，请重试。");
    } finally {
      submittingRef.current = false;
    }
  }

  function nextQuestion(): void {
    if (!payload || status !== "sent" || index >= payload.items.length - 1) return;
    setIndex((value) => value + 1);
    setAnswer("");
    setError("");
    setFeedback(null);
    setStatus("idle");
    requestAnimationFrame(() => answerRef.current?.focus());
  }

  async function enterFocusMode(): Promise<void> {
    setFocusModeMessage("");
    try {
      const changed = await requestFocusMode();
      if (!changed) setFocusModeMessage("当前客户端暂不支持全屏，仍可在卡片内答题。");
    } catch {
      setFocusModeMessage("暂时无法进入全屏，仍可在卡片内答题。");
    }
  }

  async function continueLearning(): Promise<void> {
    if (!payload || results.length !== payload.items.length || continueStatus === "sending" || continueStatus === "sent") return;
    setContinueStatus("sending");
    setError("");
    try {
      const needsLearning = results.filter((entry) => entry.result !== "known").map((entry) => entry.word);
      await updateModelContext("Wordloop pretest round completed inside the widget.", { wordloopPretestResults: results, needsLearning });
      await sendUserMessage(`Wordloop 预测试已在卡片内完成并保存。需要学习的词：${needsLearning.join("、") || "无"}。请继续下一步；不要重复汇报每题结果。`);
      setContinueStatus("sent");
    } catch (caught) {
      setContinueStatus("error");
      setError(caught instanceof Error ? caught.message : "无法继续学习，请重试。");
    }
  }

  function play(word: string): void {
    if (!speechAvailable) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = 0.9;
    utterance.onstart = () => setPlaying(word);
    utterance.onend = () => setPlaying(null);
    utterance.onerror = () => setPlaying(null);
    window.speechSynthesis.speak(utterance);
  }

  if (!payload || !item) {
    return <section className="widget-card skeleton" aria-busy="true"><span>正在加载预测试…</span></section>;
  }

  const percent = ((index + 1) / payload.items.length) * 100;
  const isLast = index === payload.items.length - 1;
  const pronunciationWords = results
    .filter((entry) => entry.result !== "known")
    .map((entry) => payload.items.find((candidate) => candidate.word === entry.word))
    .filter((entry): entry is Payload["items"][number] => Boolean(entry));

  if (completed) {
    if (showPronunciation) {
      return <section className="widget-card pretest-card" aria-labelledby="embedded-pronunciation-title">
        <header className="widget-header compact-header">
          <div>
            <span className="eyebrow">先听再读</span>
            <h1 id="embedded-pronunciation-title">本轮发音</h1>
            <p>美式英语 · 点击播放后跟读一遍。</p>
          </div>
          <button className="focus-mode-button" type="button" onClick={() => setShowPronunciation(false)}>返回结果</button>
        </header>
        {pronunciationWords.length ? <div className="pronunciation-list">
          {pronunciationWords.map((entry) => <div className="pronunciation-row" key={entry.word}>
            <div className="pronunciation-copy">
              <div className="pronunciation-heading"><strong>{entry.word}</strong><span className="part-of-speech">{entry.part_of_speech}</span></div>
              <span className="ipa">{entry.ipa}</span>
              <span className="meaning-zh">{entry.meaning_zh}</span>
            </div>
            <button className="play-button" type="button" onClick={() => play(entry.word)} disabled={!speechAvailable} aria-label={`播放 ${entry.word}`}>
              <span className="play-icon"><PlayIcon /></span>{speechAvailable ? (playing === entry.word ? "正在播放" : "播放") : "当前设备无法播放"}
            </button>
          </div>)}
        </div> : <div className="inline-feedback known"><strong>全部已会</strong><span>本轮没有需要补发音的词。</span></div>}
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        <Button onClick={() => void continueLearning()} disabled={continueStatus === "sending" || continueStatus === "sent"}>
          {continueStatus === "sending" ? "正在进入下一步…" : continueStatus === "sent" ? "已发送" : "我已跟读，开始学习"}
          {continueStatus === "idle" ? <ArrowIcon className="button-icon trailing" /> : null}
        </Button>
      </section>;
    }
    return <section className="widget-card pretest-card" aria-labelledby="pretest-complete-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">本轮完成</span>
          <h1 id="pretest-complete-title">预测试完成</h1>
        </div>
      </header>
      {feedback ? <div className={`inline-feedback ${feedback.result}`} role="status">
        <strong>{resultLabel(feedback.result)}</strong>
        <span>{feedback.feedback}</span>
      </div> : null}
      <div className="pretest-results" aria-label="本轮预测试结果">
        {payload.items.map((entry) => {
          const graded = results.find((result) => result.word === entry.word);
          return <div key={entry.word}><span>{entry.word}</span><strong className={graded?.result}>{graded ? resultLabel(graded.result) : "未完成"}</strong></div>;
        })}
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <Button onClick={() => setShowPronunciation(true)}>
        打开本轮发音 <ArrowIcon className="button-icon trailing" />
      </Button>
    </section>;
  }

  return <section className="widget-card pretest-card" aria-labelledby="pretest-title">
    <header className="widget-header compact-header">
      <div>
        <span className="eyebrow">主动回忆</span>
        <h1 id="pretest-title">{payload.title ?? "快速预测试"}</h1>
      </div>
      <button className="focus-mode-button" type="button" onClick={() => void enterFocusMode()}>专注模式</button>
    </header>
    {focusModeMessage ? <p className="answer-hint" role="status">{focusModeMessage}</p> : null}

    <div className="pretest-meta">
      <span>第 {index + 1} 题，共 {payload.items.length} 题</span>
      <span>{directionLabel(item.direction)}</span>
    </div>
    <div className="pretest-progress" role="progressbar" aria-label="预测试进度" aria-valuemin={0} aria-valuemax={payload.items.length} aria-valuenow={index + 1}>
      <span style={{ width: `${percent}%` }} />
    </div>

    <div className="question-block">
      <span className="question-label">{isChineseToEnglish ? "翻译成英文" : "翻译成中文"}</span>
      <p className="question-prompt">{questionPrompt}</p>
    </div>

    <label className="answer-label" htmlFor="pretest-answer">你的答案</label>
    <input
      ref={answerRef}
      id="pretest-answer"
      className="answer-input"
      type="text"
      value={answer}
      onChange={(event) => setAnswer(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
      placeholder={isChineseToEnglish ? "输入英文单词…" : "输入中文词义…"}
      autoCapitalize="none"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="send"
      disabled={status === "sending" || status === "sent"}
      aria-describedby="pretest-hint"
    />
    <p className="answer-hint" id="pretest-hint">按回车直接提交，输入焦点不会跳到聊天框。</p>

    {status === "error" ? <p className="error-text" role="alert">{error}</p> : null}
    {feedback ? <div className={`inline-feedback ${feedback.result}`} role="status">
      <strong>{resultLabel(feedback.result)}</strong>
      <span>{feedback.feedback}</span>
    </div> : null}

    <div className="pretest-actions">
      {status === "sent" && !isLast ?
        <Button className="secondary" onClick={nextQuestion}>下一题 <ArrowIcon className="button-icon trailing" /></Button> :
        <>
          <Button className="unknown-action" onClick={() => void markUnknown()} disabled={status === "sending" || status === "sent"}>不会</Button>
          <Button onClick={() => void submit()} disabled={!answer.trim() || status === "sending" || status === "sent"}>
            {status === "sending" ? "正在保存…" : status === "sent" ? (isLast ? "本轮完成" : "已记录") : "提交答案"}
          </Button>
        </>}
    </div>
  </section>;
}
