import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowIcon, PlayIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import {
  callServerTool,
  getSamplingAvailability,
  requestFocusMode,
  sampleHostText,
  sendUserMessage,
  subscribeToApp,
  updateModelContext,
} from "../mcpBridge.js";

const itemSchema = z.object({
  word: z.string().trim().min(1).max(100),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(40),
  meaning_zh: z.string().trim().min(1).max(240),
  // Compatibility only. The fixed card never renders prompt.
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
export type PretestItem = Payload["items"][number];
export type PretestResult = "known" | "uncertain" | "unknown";
type AnswerStatus = "idle" | "sending" | "sent" | "error";
type PronunciationStage = "result" | "listen_repeat" | "listen_recall" | "ready";
type RecallStatus = "idle" | "correct" | "wrong";
type GradedAnswer = { word: string; answer: string; result: PretestResult; feedback: string };

const gradeSchema = z.object({
  result: z.enum(["known", "uncertain", "unknown"]),
  feedback: z.string().trim().min(1).max(180),
});

const gradeSystemPrompt = "You grade one English vocabulary pretest answer. Return strict JSON only. Do not teach or add markdown.";

export function normalizePretestWord(value: string): string {
  return value.trim().toLowerCase();
}

export function editDistance(left: string, right: string): number {
  const source = normalizePretestWord(left);
  const target = normalizePretestWord(right);
  let previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let row = 1; row <= source.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= target.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[column] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[column - 1] ?? Number.POSITIVE_INFINITY) + (source[row - 1] === target[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[target.length] ?? source.length;
}

export function gradeCnToEn(answer: string, target: string): { result: PretestResult; feedback: string } {
  const normalizedAnswer = normalizePretestWord(answer);
  const normalizedTarget = normalizePretestWord(target);
  if (normalizedAnswer && normalizedAnswer === normalizedTarget) {
    return { result: "known", feedback: "答案正确。" };
  }
  if (normalizedTarget.length > 3 && editDistance(normalizedAnswer, normalizedTarget) === 1) {
    return { result: "uncertain", feedback: "拼写接近目标词。" };
  }
  return { result: "unknown", feedback: "答案与目标词不匹配。" };
}

export function effectivePretestDirection(
  direction: PretestItem["direction"],
  samplingAvailable: boolean,
): PretestItem["direction"] {
  return direction === "en_definition" && !samplingAvailable ? "cn_to_en" : direction;
}

export function pretestActivityType(direction: PretestItem["direction"]): "pretest_cn_to_en" | "pretest_en_definition" {
  return direction === "cn_to_en" ? "pretest_cn_to_en" : "pretest_en_definition";
}

type SamplingFunction = (prompt: string, systemPrompt: string) => Promise<string>;

function semanticGradePrompt(
  item: Pick<PretestItem, "word" | "meaning_zh" | "part_of_speech">,
  answer: string,
): string {
  return [
    "题型：英文单词 → 简单英文解释",
    "英文单词：" + item.word,
    "词性：" + item.part_of_speech,
    "中文核心义（仅供判断，不要求照抄）：" + item.meaning_zh,
    "用户答案：" + answer,
    "",
    "判定规则：known=用自然英文表达出该词任意一个正确、常见的核心义，短语也可以；uncertain=语义方向正确但过于模糊或不完整；unknown=意义错误、混淆其他词或与题目无关。不要要求字典式措辞、完整覆盖全部词义、特定句型或完整句子。用中文写一句不超过40字的简短反馈，不要教学。只返回 {\"result\":\"known|uncertain|unknown\",\"feedback\":\"...\"}。",
  ].join("\n");
}

export async function gradePretestAnswer(
  item: Pick<PretestItem, "word" | "meaning_zh" | "part_of_speech" | "direction">,
  answer: string,
  samplingAvailable: boolean,
  sample: SamplingFunction = sampleHostText,
): Promise<{ result: PretestResult; feedback: string }> {
  if (item.direction === "cn_to_en" || !samplingAvailable) {
    return gradeCnToEn(answer, item.word);
  }
  try {
    return parseGrade(await sample(semanticGradePrompt(item, answer), gradeSystemPrompt));
  } catch (caught) {
    if (caught instanceof Error && caught.message === "Sampling unavailable.") {
      return gradeCnToEn(answer, item.word);
    }
    throw caught;
  }
}

export function schedulePretestAdvance(
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  callback: () => void,
  delayMs = 600,
): void {
  if (timerRef.current !== null) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    callback();
  }, delayMs);
}

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
      <span className="part-of-speech">{item.part_of_speech}</span>
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
  const [finished, setFinished] = useState(false);
  const [stage, setStage] = useState<PronunciationStage>("result");
  const [pronunciationIndex, setPronunciationIndex] = useState(0);
  const [recallAnswer, setRecallAnswer] = useState("");
  const [recallStatus, setRecallStatus] = useState<RecallStatus>("idle");
  const [playing, setPlaying] = useState<string | null>(null);
  const [focusModeMessage, setFocusModeMessage] = useState("");
  const [continueStatus, setContinueStatus] = useState<AnswerStatus>("idle");
  const [samplingAvailable, setSamplingAvailable] = useState<boolean | null>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const recallInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const interactionStartedRef = useRef(false);
  const payloadSignatureRef = useRef("");
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechAvailable = typeof window !== "undefined"
    && "speechSynthesis" in window
    && "SpeechSynthesisUtterance" in window;

  function clearAdvanceTimer(): void {
    if (advanceTimerRef.current !== null) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }

  function focusInput(input: HTMLInputElement | null): void {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => input?.focus());
    } else {
      input?.focus();
    }
  }

  async function initializePayload(nextPayload: Payload, signature: string): Promise<void> {
    const available = await getSamplingAvailability();
    if (payloadSignatureRef.current !== signature) return;
    const effectivePayload: Payload = {
      ...nextPayload,
      items: nextPayload.items.map((entry) => ({
        ...entry,
        direction: effectivePretestDirection(entry.direction, available),
      })),
    };
    setSamplingAvailable(available);
    setPayload(effectivePayload);
    setIndex(Math.min(effectivePayload.current_index ?? 0, effectivePayload.items.length - 1));
    setAnswer("");
    setError("");
    setFeedback(null);
    setResults([]);
    setFinished(false);
    setStage("result");
    setPronunciationIndex(0);
    setRecallAnswer("");
    setRecallStatus("idle");
    setContinueStatus("idle");
    setStatus("idle");
    interactionStartedRef.current = false;
    if (!window.__WORDLOOP_PREVIEW__) {
      void restoreSavedProgress(effectivePayload);
    }
  }

  useEffect(() => {
    const unsubscribe = subscribeToApp((event) => {
      if (event.type !== "toolinput" && event.type !== "toolresult") return;
      const candidate = event.type === "toolinput"
        ? { widget: "pretest", ...event.value }
        : event.value.structuredContent;
      const parsed = payloadSchema.safeParse(candidate);
      if (!parsed.success) return;
      const signature = JSON.stringify(parsed.data);
      if (payloadSignatureRef.current === signature) return;
      clearAdvanceTimer();
      payloadSignatureRef.current = signature;
      setPayload(null);
      setSamplingAvailable(null);
      setIndex(0);
      setAnswer("");
      setError("");
      setFeedback(null);
      setResults([]);
      setFinished(false);
      setStage("result");
      setPronunciationIndex(0);
      setRecallAnswer("");
      setRecallStatus("idle");
      setStatus("idle");
      setContinueStatus("idle");
      interactionStartedRef.current = false;
      void initializePayload(parsed.data, signature);
    });
    return () => {
      unsubscribe();
      clearAdvanceTimer();
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

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
      const statusByWord = new Map(context.data.today_words.map((entry) => [normalizePretestWord(entry.word), entry.status]));
      const restored = nextPayload.items.flatMap((entry): GradedAnswer[] => {
        const saved = statusByWord.get(normalizePretestWord(entry.word));
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
        setFinished(true);
        setStage("result");
      } else {
        setIndex(pendingIndex);
        setAnswer("");
        setFeedback(null);
        setStatus("idle");
        focusInput(answerRef.current);
      }
    } catch {
      // A transient restore failure must not block the card.
    }
  }

  async function submit(): Promise<void> {
    const item = payload?.items[index];
    if (!payload || !item || !answer.trim() || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    interactionStartedRef.current = true;
    const cleanAnswer = answer.trim();
    setStatus("sending");
    setError("");
    try {
      const itemForGrade = item;
      const grade = window.__WORDLOOP_PREVIEW__
        ? await gradePretestAnswer(
          itemForGrade,
          cleanAnswer,
          samplingAvailable === true,
          async () => "{\"result\":\"known\",\"feedback\":\"预览模式：答案已在卡片内完成判定。\"}",
        )
        : await gradePretestAnswer(itemForGrade, cleanAnswer, samplingAvailable === true);
      await saveGrade(itemForGrade, cleanAnswer, grade);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    } finally {
      submittingRef.current = false;
    }
  }

  async function saveGrade(
    item: Payload["items"][number],
    cleanAnswer: string,
    grade: { result: PretestResult; feedback: string },
  ): Promise<void> {
    if (!payload) return;
    if (!window.__WORDLOOP_PREVIEW__) {
      const stored = await callServerTool("record_pretest_result", {
        word: item.word,
        result: grade.result,
        user_answer: cleanAnswer,
        // The item direction has already been downgraded when sampling is unavailable.
        activity_type: pretestActivityType(item.direction),
      });
      if (stored.isError) throw new Error("结果未能保存，请重试。");
    }
    const graded: GradedAnswer = { word: item.word, answer: cleanAnswer, ...grade };
    setResults((current) => [...current.filter((entry) => entry.word !== item.word), graded]);
    setFeedback(graded);
    setStatus("sent");
    const isLast = index === payload.items.length - 1;
    schedulePretestAdvance(advanceTimerRef, () => {
      setFeedback(null);
      setAnswer("");
      setStatus("idle");
      if (isLast) {
        setFinished(true);
        setStage("result");
        return;
      }
      setIndex((value) => value + 1);
      focusInput(answerRef.current);
    });
  }

  async function markUnknown(): Promise<void> {
    const item = payload?.items[index];
    if (!payload || !item || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    interactionStartedRef.current = true;
    setStatus("sending");
    setError("");
    try {
      await saveGrade(item, "", { result: "unknown", feedback: "已直接标记为不会。" });
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

  function submitRecall(): void {
    const current = pronunciationWordsForRecall();
    if (!current || !recallAnswer.trim() || recallStatus === "correct") return;
    if (normalizePretestWord(recallAnswer) === normalizePretestWord(current.word)) {
      setRecallStatus("correct");
      const isLast = pronunciationIndex === pronunciationWordsForRecall().length - 1;
      schedulePretestAdvance(advanceTimerRef, () => {
        setRecallAnswer("");
        setRecallStatus("idle");
        if (isLast) {
          setStage("ready");
          return;
        }
        setPronunciationIndex((value) => value + 1);
        setStage("listen_repeat");
      });
    } else {
      setRecallStatus("wrong");
    }
  }

  function pronunciationWordsForRecall(): Payload["items"][number][] {
    if (!payload) return [];
    return payload.items.filter((candidate) =>
      results.some((entry) => entry.word === candidate.word && entry.result !== "known"),
    );
  }

  async function continueLearning(): Promise<void> {
    if (!payload || !finished || results.length !== payload.items.length || continueStatus === "sending" || continueStatus === "sent") return;
    setContinueStatus("sending");
    setError("");
    try {
      const needsLearning = results.filter((entry) => entry.result !== "known").map((entry) => entry.word);
      await updateModelContext("WordLoop 发音与听音还原已完成。", {
        pronunciationCompleted: true,
        listeningRecallCompleted: true,
        needsLearning,
      });
      await sendUserMessage("WordLoop 发音与听音还原已完成。请直接开始 needsLearning 的正式学习，不要再次调用发音卡片。");
      setContinueStatus("sent");
    } catch (caught) {
      setContinueStatus("error");
      setError(caught instanceof Error ? caught.message : "无法开始正式学习，请重试。");
    }
  }

  if (!payload) {
    return <section className="widget-card skeleton" aria-busy="true"><span>正在加载预测试…</span></section>;
  }

  const currentItem = payload.items[index];
  const resultCounts = {
    known: results.filter((entry) => entry.result === "known").length,
    uncertain: results.filter((entry) => entry.result === "uncertain").length,
    unknown: results.filter((entry) => entry.result === "unknown").length,
  };
  const pronunciationWords = payload.items.filter((candidate) =>
    results.some((entry) => entry.word === candidate.word && entry.result !== "known"),
  );
  const currentPronunciation = pronunciationWords[pronunciationIndex];
  const percent = ((index + 1) / payload.items.length) * 100;

  if (finished) {
    if (stage === "result") {
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
        <Button onClick={() => {
          if (pronunciationWords.length) {
            setPronunciationIndex(0);
            setRecallAnswer("");
            setRecallStatus("idle");
            setStage("listen_repeat");
          } else {
            void continueLearning();
          }
        }}>
          {pronunciationWords.length ? "听音跟读" : "开始正式学习"} <ArrowIcon className="button-icon trailing" />
        </Button>
      </section>;
    }

    if (stage === "listen_repeat" && currentPronunciation) {
      return <section className="widget-card pretest-card pronunciation-stage" aria-labelledby="listen-repeat-title">
        <header className="widget-header compact-header">
          <div>
            <span className="eyebrow">听音跟读</span>
            <h1 id="listen-repeat-title">{pronunciationIndex + 1} / {pronunciationWords.length}</h1>
          </div>
        </header>
        <div className="pronunciation-focus">
          <div className="pronunciation-heading"><strong>{currentPronunciation.word}</strong><span className="part-of-speech">{currentPronunciation.part_of_speech}</span></div>
          <span className="ipa">{currentPronunciation.ipa}</span>
          <span className="meaning-zh">{currentPronunciation.meaning_zh}</span>
        </div>
        <button className="play-button pronunciation-play" type="button" onClick={() => play(currentPronunciation.word)} disabled={!speechAvailable} aria-label={"播放 " + currentPronunciation.word}>
          <span className="play-icon"><PlayIcon /></span>{speechAvailable ? (playing === currentPronunciation.word ? "正在播放" : "播放") : "当前设备无法播放"}
        </button>
        <Button onClick={() => {
          setRecallAnswer("");
          setRecallStatus("idle");
          setStage("listen_recall");
          focusInput(recallInputRef.current);
        }}>我已听读 <ArrowIcon className="button-icon trailing" /></Button>
      </section>;
    }

    if (stage === "listen_recall" && currentPronunciation) {
      return <section className="widget-card pretest-card pronunciation-stage" aria-labelledby="listen-recall-title">
        <header className="widget-header compact-header">
          <div>
            <span className="eyebrow">听音还原</span>
            <h1 id="listen-recall-title">{pronunciationIndex + 1} / {pronunciationWords.length}</h1>
          </div>
        </header>
        <div className="pronunciation-focus">
          <span className="part-of-speech">{currentPronunciation.part_of_speech}</span>
          <span className="meaning-zh">{currentPronunciation.meaning_zh}</span>
        </div>
        <button className="play-button pronunciation-play" type="button" onClick={() => play(currentPronunciation.word)} disabled={!speechAvailable} aria-label={"播放 " + currentPronunciation.word}>
          <span className="play-icon"><PlayIcon /></span>{speechAvailable ? (playing === currentPronunciation.word ? "正在播放" : "播放") : "当前设备无法播放"}
        </button>
        <label className="answer-label" htmlFor="pronunciation-recall-answer">你的答案</label>
        <input
          ref={recallInputRef}
          id="pronunciation-recall-answer"
          className="answer-input"
          type="text"
          value={recallAnswer}
          onChange={(event) => {
            setRecallAnswer(event.target.value);
            if (recallStatus !== "idle") setRecallStatus("idle");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitRecall();
            }
          }}
          placeholder="输入听到的单词…"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
        />
        {recallStatus === "correct" ? <p className="answer-status" role="status">✓ 正确</p> : null}
        {recallStatus === "wrong" ? <p className="error-text" role="status">× 再听一次</p> : null}
        <Button onClick={submitRecall} disabled={!recallAnswer.trim()}>提交</Button>
      </section>;
    }

    if (stage === "ready") {
      return <section className="widget-card pretest-card" aria-labelledby="listening-complete-title">
        <header className="widget-header compact-header">
          <div>
            <h1 id="listening-complete-title">听音完成</h1>
          </div>
        </header>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        <Button onClick={() => void continueLearning()} disabled={continueStatus === "sending" || continueStatus === "sent"}>
          {continueStatus === "sending" ? "正在开始…" : continueStatus === "sent" ? "已发送" : "开始正式学习"}
          {continueStatus === "idle" ? <ArrowIcon className="button-icon trailing" /> : null}
        </Button>
      </section>;
    }
  }

  if (!currentItem) {
    return <section className="widget-card skeleton" aria-busy="true"><span>正在加载题目…</span></section>;
  }

  const isChineseToEnglish = currentItem.direction === "cn_to_en";
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
      <span style={{ width: String(percent) + "%" }} />
    </div>
    <PretestQuestion item={currentItem} />
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
    {feedback ? <div className={"inline-feedback status-only " + feedback.result} role="status"><strong>{resultStatus(feedback.result)}</strong></div> : null}
    <div className="pretest-actions">
      {status !== "sent" ? <>
        <Button className="secondary unknown-action" onClick={() => void markUnknown()} disabled={status === "sending"}>不会</Button>
        <Button onClick={() => void submit()} disabled={!answer.trim() || status === "sending"}>
          {status === "sending" ? "正在保存…" : "提交"}
        </Button>
      </> : null}
    </div>
  </section>;
}

