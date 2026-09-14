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
  // Kept only for compatibility with older tool calls. The card never renders it.
  prompt: z.string().trim().max(1000).optional(),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
});

const payloadSchema = z.object({
  widget: z.literal("pretest"),
  items: z.array(itemSchema).min(1).max(7),
  current_index: z.number().int().min(0).max(6).optional(),
  title: z.string().trim().min(1).max(100).optional(),
});

type Payload = z.infer<typeof payloadSchema>;
type PretestItem = Payload["items"][number];
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

function resultStatus(result: PretestResult): string {
  if (result === "known") return "✓ 已会";
  if (result === "uncertain") return "△ 模糊";
  return "× 不会";
}

export function PretestQuestion({ item }: { item: PretestItem }): React.JSX.Element {
  return <div className="question-block">
    {item.direction === "cn_to_en" ? <>
      <span className="question-label">中 → 英</span>
      <p className="question-prompt">{item.meaning_zh}</p>
    </> : <>
      <span className="question-label">英 → 英</span>
      <p className="question-word">{item.word}</p>
      <span className="part-of-speech">{item.part_of_speech}</span>
    </>}
  </div>;
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
  const isChineseToEnglish = item?.direction === "cn_to_en";

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
            : cleanAnswer.length > 0) ? "known" as const : "unknown" as const, feedback: "预览模式：答案已在卡片内完成判定。" }
        : parseGrade(await sampleHostText(
          isChineseToEnglish
            ? `题型：中文核心义 → 英文单词\n目标英文单词：${item.word}\n中文核心义：${item.meaning_zh}\n用户答案：${cleanAnswer}\n\n判定规则：known=正确写出目标英文单词，大小写不影响判定；uncertain=明显知道目标词，但只有轻微拼写错误；unknown=错误单词、无关答案或不知道。用中文写一句不超过40字的简短反馈，不要教学。只返回 {"result":"known|uncertain|unknown","feedback":"..."}。`
            : `题型：英文单词 → 简单英文解释\n英文单词：${item.word}\n词性：${item.part_of_speech}\n中文核心义（仅供判断，不要求照抄）：${item.meaning_zh}\n用户答案：${cleanAnswer}\n\n判定规则：known=用自然英文表达出该词任意一个正确、常见的核心义，短语也可以；uncertain=语义方向正确但过于模糊或不完整；unknown=意义错误、混淆其他词或与题目无关。不要要求字典式措辞、完整覆盖全部词义、特定句型或完整句子。用中文写一句不超过40字的简短反馈，不要教学。只返回 {"result":"known|uncertain|unknown","feedback":"..."}。`,
          gradeSystemPrompt,
        ));
      await saveGrade(cleanAnswer, grade);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    } finally {
      submittingRef.current = false;
    }
  }

  async function saveGrade(cleanAnswer: string, grade: { result: PretestResult; feedback: string }): Promise<void> {
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
    setFeedback(graded);
    setStatus("sent");
  }

  function nextQuestion(): void {
    if (!payload || !item || status !== "sent") return;
    if (index === payload.items.length - 1) {
      setFeedback(null);
      setCompleted(true);
      return;
    }
    setIndex((value) => value + 1);
    setAnswer("");
    setFeedback(null);
    setStatus("idle");
    requestAnimationFrame(() => answerRef.current?.focus());
  }

  async function markUnknown(): Promise<void> {
    if (!payload || !item || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    interactionStartedRef.current = true;
    setStatus("sending");
    setError("");
    try {
      await saveGrade("", { result: "unknown", feedback: "已直接标记为不会。" });
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "结果未能保存，请重试。");
    } finally {
      submittingRef.current = false;
    }
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
  const pronunciationWords = results
    .filter((entry) => entry.result !== "known")
    .map((entry) => payload.items.find((candidate) => candidate.word === entry.word))
    .filter((entry): entry is Payload["items"][number] => Boolean(entry));
  const resultCounts = {
    known: results.filter((entry) => entry.result === "known").length,
    uncertain: results.filter((entry) => entry.result === "uncertain").length,
    unknown: results.filter((entry) => entry.result === "unknown").length,
  };

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
          <h1 id="pretest-complete-title">预测试完成</h1>
        </div>
      </header>
      <div className="result-strip" aria-label="本轮预测试结果">
        <span><strong>{resultCounts.known}</strong><small>✓ 已会</small></span>
        <span><strong>{resultCounts.uncertain}</strong><small>△ 模糊</small></span>
        <span><strong>{resultCounts.unknown}</strong><small>× 不会</small></span>
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <Button onClick={() => setShowPronunciation(true)}>
        听音跟读 <ArrowIcon className="button-icon trailing" />
      </Button>
    </section>;
  }

  return <section className="widget-card pretest-card" aria-labelledby="pretest-title">
    <header className="widget-header compact-header">
      <div className="pretest-title-row">
        <h1 id="pretest-title">预测试</h1>
        <span className="pretest-count">{index + 1} / {payload.items.length}</span>
      </div>
      <button className="focus-mode-button" type="button" onClick={() => void enterFocusMode()}>⛶ 专注</button>
    </header>
    {focusModeMessage ? <p className="answer-hint" role="status">{focusModeMessage}</p> : null}

    <div className="pretest-progress" role="progressbar" aria-label="预测试进度" aria-valuemin={0} aria-valuemax={payload.items.length} aria-valuenow={index + 1}>
      <span style={{ width: `${percent}%` }} />
    </div>

    <PretestQuestion item={item} />

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
      placeholder={isChineseToEnglish ? "输入英文单词…" : "用简单英文解释这个词…"}
      autoCapitalize="none"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="send"
      disabled={status === "sending" || status === "sent"}
    />

    {status === "error" ? <p className="error-text" role="alert">{error}</p> : null}
    {feedback ? <div className={`inline-feedback status-only ${feedback.result}`} role="status">
      <strong>{resultStatus(feedback.result)}</strong>
    </div> : null}

    <div className="pretest-actions">
      {status === "sent" ? <Button onClick={nextQuestion}>
        {index === payload.items.length - 1 ? "查看结果" : "下一题"}
        {index === payload.items.length - 1 ? null : <ArrowIcon className="button-icon trailing" />}
      </Button> : <>
        <Button className="secondary unknown-action" onClick={() => void markUnknown()} disabled={status === "sending"}>不会</Button>
        <Button onClick={() => void submit()} disabled={!answer.trim() || status === "sending"}>
          {status === "sending" ? "正在保存…" : "提交"}
        </Button>
      </>}
    </div>
  </section>;
}
