import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { callServerTool, requestFocusMode, sampleHostText, sendUserMessage, subscribeToApp, updateModelContext } from "../mcpBridge.js";

const itemSchema = z.object({
  word: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(1000),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
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
  return direction === "cn_to_en" ? "中文 → 英文" : "英文释义";
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
  const [focusModeMessage, setFocusModeMessage] = useState("");
  const [continueStatus, setContinueStatus] = useState<AnswerStatus>("idle");
  const answerRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput"
      ? { widget: "pretest", ...event.value }
      : event.value.structuredContent;
    const parsed = payloadSchema.safeParse(candidate);
    if (!parsed.success) return;
    const nextIndex = Math.min(parsed.data.current_index ?? 0, parsed.data.items.length - 1);
    setPayload(parsed.data);
    setIndex(nextIndex);
    setAnswer("");
    setError("");
    setFeedback(null);
    setResults([]);
    setCompleted(false);
    setStatus("idle");
  }), []);

  const item = payload?.items[index];

  async function submit(): Promise<void> {
    if (!payload || !item || !answer.trim() || status === "sending" || status === "sent") return;
    const cleanAnswer = answer.trim();
    setStatus("sending");
    setError("");
    try {
      const grade = window.__WORDLOOP_PREVIEW__
        ? { result: cleanAnswer.toLocaleLowerCase() === item.word.toLocaleLowerCase() ? "known" as const : "unknown" as const, feedback: "预览模式：答案已在卡片内完成判定。" }
        : parseGrade(await sampleHostText(
          `目标词：${item.word}\n题目方向：${item.direction}\n题目：${item.prompt}\n用户答案：${cleanAnswer}\n\n判定规则：known=准确产出目标词或英文释义完整准确；uncertain=方向正确但没有产出目标词、存在轻微拼写错误或释义明显不完整；unknown=答案错误或无关。用中文写一句不超过40字的具体反馈。只返回 {"result":"known|uncertain|unknown","feedback":"..."}。`,
          gradeSystemPrompt,
        ));
      if (!window.__WORDLOOP_PREVIEW__) {
        const stored = await callServerTool("record_pretest_result", { word: item.word, result: grade.result });
        if (stored.isError) throw new Error("结果未能保存，请重试。");
      }
      const graded = { word: item.word, answer: cleanAnswer, ...grade };
      setFeedback(graded);
      setResults((current) => [...current.filter((entry) => entry.word !== item.word), graded]);
      setStatus("sent");
      if (index === payload.items.length - 1) setCompleted(true);
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Answer could not be sent.");
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

  if (!payload || !item) {
    return <section className="widget-card skeleton" aria-busy="true"><span>Loading pretest…</span></section>;
  }

  const percent = ((index + 1) / payload.items.length) * 100;
  const isLast = index === payload.items.length - 1;

  if (completed) {
    return <section className="widget-card pretest-card" aria-labelledby="pretest-complete-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">Round complete</span>
          <h1 id="pretest-complete-title">预测试完成</h1>
          <p>结果已经写入 Wordloop，不需要回到聊天记录逐条查看。</p>
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
      <Button onClick={() => void continueLearning()} disabled={continueStatus === "sending" || continueStatus === "sent"}>
        {continueStatus === "sending" ? "正在进入下一步…" : continueStatus === "sent" ? "已发送" : "进入发音阶段"}
        {continueStatus === "idle" ? <ArrowIcon className="button-icon trailing" /> : null}
      </Button>
    </section>;
  }

  return <section className="widget-card pretest-card" aria-labelledby="pretest-title">
    <header className="widget-header compact-header">
      <div>
        <span className="eyebrow">Active recall</span>
        <h1 id="pretest-title">{payload.title ?? "Quick pretest"}</h1>
        <p>答案、批改和进度都留在这张卡片里。</p>
      </div>
      <button className="focus-mode-button" type="button" onClick={() => void enterFocusMode()}>专注模式</button>
    </header>
    {focusModeMessage ? <p className="answer-hint" role="status">{focusModeMessage}</p> : null}

    <div className="pretest-meta">
      <span>Question {index + 1} of {payload.items.length}</span>
      <span>{directionLabel(item.direction)}</span>
    </div>
    <div className="pretest-progress" role="progressbar" aria-label="Pretest progress" aria-valuemin={0} aria-valuemax={payload.items.length} aria-valuenow={index + 1}>
      <span style={{ width: `${percent}%` }} />
    </div>

    <div className="question-block">
      <span className="question-label">{item.direction === "cn_to_en" ? "Translate into English" : "Explain in English"}</span>
      <p className="question-prompt">{item.prompt}</p>
    </div>

    <label className="answer-label" htmlFor="pretest-answer">Your answer</label>
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
      placeholder={item.direction === "cn_to_en" ? "Type the English word…" : "Write a short English definition…"}
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
        <Button className="secondary" onClick={nextQuestion}>Next question <ArrowIcon className="button-icon trailing" /></Button> :
        <Button onClick={() => void submit()} disabled={!answer.trim() || status === "sending" || status === "sent"}>
          {status === "sending" ? "正在卡片内批改…" : status === "sent" ? (isLast ? "本轮完成" : "已记录") : "提交答案"}
        </Button>}
    </div>
  </section>;
}
