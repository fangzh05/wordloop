import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { callServerTool, sampleHostText, sendUserMessage, subscribeToApp, updateModelContext } from "../mcpBridge.js";

const errorLayerSchema = z.enum(["meaning", "collocation", "grammar", "pronunciation", "spelling"]);
const itemSchema = z.object({
  word: z.string().trim().min(1).max(100),
  meaning_zh: z.string().trim().min(1).max(240),
  part_of_speech: z.string().trim().max(40).optional(),
  direction: z.enum(["cn_to_en", "en_definition"]).default("cn_to_en"),
  error_layers: z.array(errorLayerSchema).max(5).default([]),
  // Used only by local preview fixtures. Live cards verify due status from
  // get_learning_context before calling record_review_result.
  is_due: z.boolean().optional(),
});

const payloadSchema = z.object({
  widget: z.literal("review"),
  items: z.array(itemSchema).min(1).max(5),
  current_index: z.number().int().min(0).max(4).optional(),
  title: z.string().trim().min(1).max(100).optional(),
});

const contextSchema = z.object({
  rolling_review: z.array(z.object({ word: z.string(), next_review_at: z.string().nullable().optional() })).default([]),
  today_words: z.array(z.object({ word: z.string(), next_review_at: z.string().nullable().optional() })).default([]),
});

const gradeSchema = z.object({
  is_correct: z.boolean(),
  rating: z.enum(["again", "hard", "good", "easy"]),
  error_layer: z.enum(["meaning", "collocation", "grammar", "pronunciation", "spelling", "none"]),
  feedback: z.string().trim().min(1).max(120),
});

const gradeSystemPrompt = "你只负责批改一次独立英语词汇复习。只返回严格 JSON，不教学，不加 Markdown。";

type Payload = z.infer<typeof payloadSchema>;
type ReviewItem = Payload["items"][number];
type AnswerStatus = "idle" | "sending" | "sent" | "error";
type GradedAnswer = {
  word: string;
  answer: string;
  is_correct: boolean;
  rating: "again" | "hard" | "good" | "easy";
  error_layer: z.infer<typeof errorLayerSchema> | "none";
  feedback: string;
};

function parseGrade(raw: string): z.infer<typeof gradeSchema> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("ChatGPT 返回的批改格式无效，请重试。");
  const parsed = gradeSchema.safeParse(JSON.parse(match[0]));
  if (!parsed.success) throw new Error("ChatGPT 返回的批改格式无效，请重试。");
  return parsed.data;
}

function normalize(word: string): string {
  return word.trim().toLocaleLowerCase();
}

function resultLabel(result: GradedAnswer): string {
  return result.is_correct ? "✓ 已记住" : "× 再复习一次";
}

export function ReviewQuestion({ item }: { item: ReviewItem }): React.JSX.Element {
  return <div className="question-block">
    {item.direction === "cn_to_en" ? <>
      <span className="question-label">中 → 英</span>
      <p className="question-prompt">{item.meaning_zh}</p>
    </> : <>
      <span className="question-label">英 → 英</span>
      <p className="question-word">{item.word}</p>
      {item.part_of_speech ? <span className="part-of-speech">{item.part_of_speech}</span> : null}
    </>}
  </div>;
}

export function ReviewWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<AnswerStatus>("idle");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<GradedAnswer | null>(null);
  const [results, setResults] = useState<GradedAnswer[]>([]);
  const [completed, setCompleted] = useState(false);
  const [dueByWord, setDueByWord] = useState<Map<string, boolean>>(new Map());
  const [continueStatus, setContinueStatus] = useState<AnswerStatus>("idle");
  const answerRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const payloadSignatureRef = useRef("");

  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput"
      ? { widget: "review", ...event.value }
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
    setStatus("idle");
    setError("");
    setFeedback(null);
    setResults([]);
    setCompleted(false);
    setDueByWord(new Map());
    setContinueStatus("idle");
    void loadDueState(parsed.data);
  }), []);

  async function loadDueState(nextPayload: Payload): Promise<void> {
    const previewDue = new Map(nextPayload.items.map((item) => [normalize(item.word), item.is_due === true]));
    if (window.__WORDLOOP_PREVIEW__) {
      setDueByWord(previewDue);
      return;
    }
    try {
      const stored = await callServerTool("get_learning_context", {});
      if (stored.isError) {
        setDueByWord(new Map());
        return;
      }
      const parsed = contextSchema.safeParse(stored.structuredContent);
      if (!parsed.success) {
        setDueByWord(new Map());
        return;
      }
      const now = Date.now();
      const entries = [...parsed.data.rolling_review, ...parsed.data.today_words];
      const due = new Map<string, boolean>();
      for (const item of nextPayload.items) {
        const match = entries.find((entry) => normalize(entry.word) === normalize(item.word));
        const timestamp = match?.next_review_at ? Date.parse(match.next_review_at) : Number.NaN;
        due.set(normalize(item.word), Number.isFinite(timestamp) && timestamp <= now);
      }
      setDueByWord(due);
    } catch {
      // Failing closed keeps an active-error repair from accidentally moving FSRS.
      setDueByWord(new Map());
    }
  }

  const item = payload?.items[index];

  async function submit(): Promise<void> {
    if (!payload || !item || !answer.trim() || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    const cleanAnswer = answer.trim();
    setStatus("sending");
    setError("");
    try {
      const grade = window.__WORDLOOP_PREVIEW__
        ? {
          is_correct: item.direction === "cn_to_en"
            ? cleanAnswer.toLocaleLowerCase() === item.word.toLocaleLowerCase()
            : cleanAnswer.length > 0,
          rating: "good" as const,
          error_layer: "none" as const,
          feedback: "结果已记录在卡片中。",
        }
        : parseGrade(await sampleHostText(
          item.direction === "cn_to_en"
            ? `题型：中文核心义 → 英文单词\n目标英文单词：${item.word}\n中文核心义：${item.meaning_zh}\n用户答案：${cleanAnswer}\n\n判定：正确写出目标词为 is_correct=true；拼写明显错误、错误单词或不知道为 false。正确答案时 rating 可为 hard/good/easy，错误答案必须为 again。error_layer 在错误时选择 meaning、spelling 或其他最主要层级，正确时为 none。用中文写一句不超过30字的反馈。只返回 {"is_correct":true,"rating":"good","error_layer":"none","feedback":"..."}。`
            : `题型：英文单词 → 简单英文解释\n英文单词：${item.word}\n词性：${item.part_of_speech ?? ""}\n中文核心义（仅供判断，不要求照抄）：${item.meaning_zh}\n用户答案：${cleanAnswer}\n\n判定：用自然英文表达该词任意一个正确、常见核心义为 is_correct=true；语义方向正确但明显不完整可为 false 并标 meaning。不要要求字典原文、完整覆盖全部词义、固定句型或完整句子。正确答案时 rating 可为 hard/good/easy，错误答案必须为 again。用中文写一句不超过30字的反馈。只返回 {"is_correct":true,"rating":"good","error_layer":"none","feedback":"..."}。`,
          gradeSystemPrompt,
        ));
      const attemptErrorLayer = grade.is_correct
        ? (item.error_layers[0] ?? "none")
        : grade.error_layer === "none" ? "meaning" : grade.error_layer;
      const attempt = await callServerTool("record_attempt", {
        word: item.word,
        activity_type: "review",
        user_answer: cleanAnswer,
        is_correct: grade.is_correct,
        error_layer: attemptErrorLayer,
      });
      if (attempt.isError) throw new Error("答题记录未能保存，请重试。");

      const due = dueByWord.get(normalize(item.word)) === true;
      if (due) {
        const review = await callServerTool("record_review_result", {
          word: item.word,
          rating: grade.is_correct ? grade.rating : "again",
          source: "review",
        });
        if (review.isError) throw new Error("到期复习结果未能保存，请重试。");
      }
      const graded: GradedAnswer = { word: item.word, answer: cleanAnswer, ...grade, error_layer: attemptErrorLayer };
      setResults((current) => [...current.filter((entry) => entry.word !== item.word), graded]);
      setFeedback(graded);
      setStatus("sent");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    } finally {
      submittingRef.current = false;
    }
  }

  async function markUnknown(): Promise<void> {
    if (!payload || !item || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    setStatus("sending");
    setError("");
    try {
      const attempt = await callServerTool("record_attempt", {
        word: item.word,
        activity_type: "review",
        user_answer: "",
        is_correct: false,
        error_layer: item.error_layers[0] ?? "meaning",
      });
      if (attempt.isError) throw new Error("答题记录未能保存，请重试。");
      if (dueByWord.get(normalize(item.word)) === true) {
        const review = await callServerTool("record_review_result", { word: item.word, rating: "again", source: "review" });
        if (review.isError) throw new Error("到期复习结果未能保存，请重试。");
      }
      const graded: GradedAnswer = {
        word: item.word,
        answer: "",
        is_correct: false,
        rating: "again",
        error_layer: item.error_layers[0] ?? "meaning",
        feedback: "已标记为不会。",
      };
      setResults((current) => [...current.filter((entry) => entry.word !== item.word), graded]);
      setFeedback(graded);
      setStatus("sent");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    } finally {
      submittingRef.current = false;
    }
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

  async function continueLearning(): Promise<void> {
    if (!payload || results.length !== payload.items.length || continueStatus === "sending" || continueStatus === "sent") return;
    setContinueStatus("sending");
    setError("");
    try {
      await updateModelContext("Wordloop 复习卡片已完成。", { wordloopReviewResults: results });
      await sendUserMessage("Wordloop 复习卡片已完成，请继续下一步；不要重复汇报每题结果。");
      setContinueStatus("sent");
    } catch (caught) {
      setContinueStatus("error");
      setError(caught instanceof Error ? caught.message : "无法继续学习，请重试。");
    }
  }

  if (!payload || !item) return <section className="widget-card skeleton" aria-busy="true"><span>正在加载复习…</span></section>;

  if (completed) {
    return <section className="widget-card review-card" aria-labelledby="review-complete-title">
      <header className="widget-header compact-header">
        <div><span className="eyebrow">复习</span><h1 id="review-complete-title">复习完成</h1></div>
      </header>
      <div className="result-strip" aria-label="复习结果">
        <span><strong>{results.filter((entry) => entry.is_correct).length}</strong><small>✓ 记住</small></span>
        <span><strong>{results.filter((entry) => !entry.is_correct).length}</strong><small>× 再练</small></span>
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <Button onClick={() => void continueLearning()} disabled={continueStatus === "sending" || continueStatus === "sent"}>
        {continueStatus === "sending" ? "正在继续…" : continueStatus === "sent" ? "已发送" : "继续学习"}
        {continueStatus === "idle" ? <ArrowIcon className="button-icon trailing" /> : null}
      </Button>
    </section>;
  }

  const percent = ((index + 1) / payload.items.length) * 100;
  return <section className="widget-card review-card" aria-labelledby="review-title">
    <header className="widget-header compact-header">
      <div className="review-title-row"><h1 id="review-title">复习</h1><span className="pretest-count">{index + 1} / {payload.items.length}</span></div>
    </header>
    <div className="pretest-progress" role="progressbar" aria-label="复习进度" aria-valuemin={0} aria-valuemax={payload.items.length} aria-valuenow={index + 1}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <ReviewQuestion item={item} />
    <label className="answer-label" htmlFor="review-answer">你的答案</label>
    <input
      ref={answerRef}
      id="review-answer"
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
      placeholder={item.direction === "cn_to_en" ? "输入英文单词…" : "用简单英文解释这个词…"}
      autoCapitalize="none"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="send"
      disabled={status === "sending" || status === "sent"}
    />
    {status === "error" ? <p className="error-text" role="alert">{error}</p> : null}
    {feedback ? <div className={`inline-feedback status-only ${feedback.is_correct ? "known" : "unknown"}`} role="status">
      <strong>{resultLabel(feedback)}</strong><span>{feedback.feedback}</span>
    </div> : null}
    <div className="pretest-actions">
      {status === "sent" ? <Button onClick={nextQuestion}>{index === payload.items.length - 1 ? "查看结果" : "下一题"}{index === payload.items.length - 1 ? null : <ArrowIcon className="button-icon trailing" />}</Button> : <>
        <Button className="secondary unknown-action" onClick={() => void markUnknown()} disabled={status === "sending"}>不会</Button>
        <Button onClick={() => void submit()} disabled={!answer.trim() || status === "sending"}>{status === "sending" ? "正在保存…" : "提交"}</Button>
      </>}
    </div>
  </section>;
}
