import { useEffect, useState } from "react";
import { z } from "zod";
import { ArrowIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { sendUserMessage, subscribeToApp, updateModelContext } from "../mcpBridge.js";

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

function directionLabel(direction: Payload["items"][number]["direction"]): string {
  return direction === "cn_to_en" ? "中文 → 英文" : "英文释义";
}

export function PretestWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<AnswerStatus>("idle");
  const [error, setError] = useState("");

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
    setStatus("idle");
  }), []);

  const item = payload?.items[index];

  async function submit(): Promise<void> {
    if (!payload || !item || !answer.trim() || status === "sending" || status === "sent") return;
    const cleanAnswer = answer.trim();
    setStatus("sending");
    setError("");
    const answerContext = {
      word: item.word,
      prompt: item.prompt,
      direction: item.direction,
      answer: cleanAnswer,
      index: index + 1,
      total: payload.items.length,
    };
    try {
      if (!window.__WORDLOOP_PREVIEW__) {
        await updateModelContext("A Wordloop pretest answer is ready for grading.", { wordloopPretestAnswer: answerContext });
        await sendUserMessage(
          `Wordloop 预测试答题（第 ${index + 1}/${payload.items.length} 题）。目标词：${item.word}。题目：${item.prompt}。我的答案：${cleanAnswer}。请只批改这一题，判断 known、uncertain 或 unknown，并调用 record_pretest_result。不要再次调用 render_pretest_widget；当前 Widget 已包含本轮后续题目。`,
        );
      }
      setStatus("sent");
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
    setStatus("idle");
  }

  if (!payload || !item) {
    return <section className="widget-card skeleton" aria-busy="true"><span>Loading pretest…</span></section>;
  }

  const percent = ((index + 1) / payload.items.length) * 100;
  const isLast = index === payload.items.length - 1;

  return <section className="widget-card pretest-card" aria-labelledby="pretest-title">
    <header className="widget-header">
      <span className="eyebrow">Active recall</span>
      <h1 id="pretest-title">{payload.title ?? "Quick pretest"}</h1>
      <p>Answer one question, then let ChatGPT grade it and save your learning state.</p>
    </header>

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
    <textarea
      id="pretest-answer"
      className="answer-input"
      value={answer}
      onChange={(event) => setAnswer(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
      }}
      placeholder={item.direction === "cn_to_en" ? "Type the English word…" : "Write a short English definition…"}
      rows={3}
      disabled={status === "sending" || status === "sent"}
      aria-describedby="pretest-hint"
    />
    <p className="answer-hint" id="pretest-hint">Press ⌘↵ or Ctrl↵ to submit.</p>

    {status === "error" ? <p className="error-text" role="alert">{error}</p> : null}
    {status === "sent" ? <p className="answer-status" role="status">Submitted. ChatGPT is grading this answer.</p> : null}

    <div className="pretest-actions">
      {status === "sent" && !isLast ?
        <Button className="secondary" onClick={nextQuestion}>Next question <ArrowIcon className="button-icon trailing" /></Button> :
        <Button onClick={() => void submit()} disabled={!answer.trim() || status === "sending" || status === "sent"}>
          {status === "sending" ? "Sending…" : status === "sent" ? (isLast ? "Round submitted" : "Submitted") : "Submit answer"}
        </Button>}
    </div>
  </section>;
}
