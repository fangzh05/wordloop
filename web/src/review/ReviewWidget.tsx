import { useEffect, useRef, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ArrowIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { FocusButton } from "../components/FocusButton.js";
import { gradeTargetWord } from "../grading/deterministic.js";
import { callServerTool, getSamplingAvailability, sampleHostText, sendUserMessage, subscribeToApp } from "../mcpBridge.js";
import {
  activeErrorLayerSchema,
  directionSchema,
  errorLayerSchema,
  fsrsRatingSchema,
  recordAttemptSchema,
  recordReviewSubmissionSchema,
  reviewKindSchema,
  type ErrorLayer,
  type FsrsRating,
  type RecordAttemptInput,
  type RecordReviewSubmissionInput,
} from "../../../shared/toolContracts.js";

const itemSchema = z.object({
  word: z.string().trim().min(1).max(100),
  meaning_zh: z.string().trim().min(1).max(240),
  part_of_speech: z.string().trim().max(40).optional(),
  direction: directionSchema.default("cn_to_en"),
  error_layers: z.array(activeErrorLayerSchema).max(5).default([]),
  is_due: z.boolean(),
  review_kind: reviewKindSchema,
  next_review_at: z.string().nullable(),
});

const payloadSchema = z.object({
  widget: z.literal("review"),
  items: z.array(itemSchema).min(1).max(5),
  current_index: z.number().int().min(0).max(4).optional(),
  title: z.string().trim().min(1).max(100).optional(),
});

const gradeSchema = z.object({
  is_correct: z.boolean(),
  rating: fsrsRatingSchema,
  error_layer: errorLayerSchema,
  feedback: z.string().trim().min(1).max(120),
});

const gradeSystemPrompt = "你只负责批改一次独立英语词汇复习。只返回严格 JSON，不教学，不加 Markdown。";
const REVIEW_AUTO_ADVANCE_MS = 600;

type Payload = z.infer<typeof payloadSchema>;
export type ReviewItem = Payload["items"][number];
type AnswerStatus = "idle" | "sending" | "sent" | "error";
type GradedAnswer = {
  word: string;
  answer: string;
  is_correct: boolean;
  rating: FsrsRating;
  error_layer: ErrorLayer;
  feedback: string;
};

export type ReviewToolCall =
  | { name: "record_review_submission"; arguments: RecordReviewSubmissionInput }
  | { name: "record_attempt"; arguments: RecordAttemptInput };

/**
 * Build every Review persistence call from one validated verdict. The
 * error-repair route only removes the FSRS-only rating after the common review
 * submission has been validated; it does not get a second hand-written shape.
 */
export function buildReviewSubmission(
  item: Pick<ReviewItem, "word" | "direction" | "review_kind">,
  draft: {
    user_answer: string;
    is_correct: boolean;
    error_layer: ErrorLayer;
    rating: FsrsRating;
  },
): ReviewToolCall {
  const submission = recordReviewSubmissionSchema.parse({
    word: item.word,
    user_answer: draft.user_answer,
    is_correct: draft.is_correct,
    error_layer: draft.is_correct ? draft.error_layer : draft.error_layer === "none" ? "meaning" : draft.error_layer,
    rating: draft.is_correct ? draft.rating : "again",
    direction: item.direction,
  });
  if (shouldAdvanceFsrs(item.review_kind)) {
    return { name: "record_review_submission", arguments: submission };
  }
  const { rating: _rating, ...attempt } = submission;
  return {
    name: "record_attempt",
    arguments: recordAttemptSchema.parse({ ...attempt, activity_type: "review" }),
  };
}

function parseGrade(raw: string): z.infer<typeof gradeSchema> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("ChatGPT 返回的批改格式无效，请重试。");
  const parsed = gradeSchema.safeParse(JSON.parse(match[0]));
  if (!parsed.success) throw new Error("ChatGPT 返回的批改格式无效，请重试。");
  return parsed.data;
}

export function effectiveReviewDirection(
  direction: ReviewItem["direction"],
  samplingAvailable: boolean,
): ReviewItem["direction"] {
  return direction === "en_definition" && !samplingAvailable ? "cn_to_en" : direction;
}

export function shouldAdvanceFsrs(reviewKind: ReviewItem["review_kind"]): boolean {
  return reviewKind === "fsrs_due" || reviewKind === "both";
}

export function isReviewCardAlreadyCompleteResult(result: Pick<CallToolResult, "isError" | "content">): boolean {
  if (!result.isError) return false;
  const text = result.content
    .filter((entry): entry is Extract<CallToolResult["content"][number], { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join(" ");
  return /FSRS_CARD_NOT_DUE|FSRS card is not due/i.test(text);
}

export function gradeReviewCnToEn(answer: string, target: string): {
  is_correct: boolean;
  rating: "again" | "hard" | "good";
  error_layer: "none" | "spelling" | "meaning";
  feedback: string;
} {
  return gradeTargetWord(answer, target);
}

function isSamplingCapabilityError(caught: unknown): boolean {
  return caught instanceof Error
    && /sampling unavailable|host capability missing|createSamplingMessage|sampling undefined/i.test(caught.message);
}

function reviewErrorMessage(caught: unknown): string {
  if (isSamplingCapabilityError(caught)) return "暂时无法完成智能批改，请重试。";
  if (caught instanceof Error && /FSRS_CARD_NOT_DUE|FSRS card is not due/i.test(caught.message)) return "这张卡已经完成复习。";
  return caught instanceof Error ? caught.message : "答案未能提交，请重试。";
}

function resultLabel(result: GradedAnswer): string {
  return result.is_correct ? "✓ 已记住" : "× 再复习一次";
}

export function ReviewQuestion({ item }: { item: ReviewItem }): React.JSX.Element {
  return <div className="question-block">
    {item.direction === "cn_to_en" ? <>
      <span className="question-label">中 → 英</span>
      {item.part_of_speech ? <span className="part-of-speech">{item.part_of_speech}</span> : null}
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
  const [continueStatus, setContinueStatus] = useState<AnswerStatus>("idle");
  const [samplingAvailable, setSamplingAvailable] = useState<boolean | null>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const payloadSignatureRef = useRef("");

  async function initializePayload(nextPayload: Payload, signature: string): Promise<void> {
    const available = await getSamplingAvailability();
    if (payloadSignatureRef.current !== signature) return;
    const effectivePayload: Payload = {
      ...nextPayload,
      items: nextPayload.items.map((entry) => ({
        ...entry,
        direction: effectiveReviewDirection(entry.direction, available),
      })),
    };
    setSamplingAvailable(available);
    setPayload(effectivePayload);
    setIndex(Math.min(effectivePayload.current_index ?? 0, effectivePayload.items.length - 1));
    setAnswer("");
    setStatus("idle");
    setError("");
    setFeedback(null);
    setResults([]);
    setCompleted(false);
    setContinueStatus("idle");
  }

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
    setPayload(null);
    setSamplingAvailable(null);
    setIndex(0);
    setAnswer("");
    setStatus("idle");
    setError("");
    setFeedback(null);
    setResults([]);
    setCompleted(false);
    setContinueStatus("idle");
    void initializePayload(parsed.data, signature);
  }), []);

  useEffect(() => {
    if (status !== "sent" || !feedback || !payload) return;
    const timer = setTimeout(() => {
      if (index === payload.items.length - 1) {
        setFeedback(null);
        setStatus("idle");
        setCompleted(true);
        return;
      }
      setIndex((value) => value + 1);
      setAnswer("");
      setFeedback(null);
      setStatus("idle");
      requestAnimationFrame(() => answerRef.current?.focus());
    }, REVIEW_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [status, feedback, index, payload]);

  const item = payload?.items[index];

  function switchCurrentToChineseTest(): void {
    setPayload((current) => current ? {
      ...current,
      items: current.items.map((entry, entryIndex) => entryIndex === index ? { ...entry, direction: "cn_to_en" } : entry),
    } : current);
    setSamplingAvailable(false);
    setAnswer("");
    setFeedback(null);
    setStatus("idle");
    setError("当前环境已切换为中→英测试。");
  }

  async function submit(): Promise<void> {
    if (!payload || !item || !answer.trim() || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    const cleanAnswer = answer.trim();
    setStatus("sending");
    setError("");
    try {
      let grade: z.infer<typeof gradeSchema> | ReturnType<typeof gradeReviewCnToEn>;
      if (item.direction === "cn_to_en") {
        grade = gradeReviewCnToEn(cleanAnswer, item.word);
      } else if (window.__WORDLOOP_PREVIEW__) {
        grade = {
          is_correct: cleanAnswer.length > 0,
          rating: "good" as const,
          error_layer: "none" as const,
          feedback: "结果已记录在卡片中。",
        };
      } else {
        try {
          grade = parseGrade(await sampleHostText(
            `题型：英文单词 → 简单英文解释\n英文单词：${item.word}\n词性：${item.part_of_speech ?? ""}\n中文核心义（仅供判断，不要求照抄）：${item.meaning_zh}\n用户答案：${cleanAnswer}\n\n判定：用自然英文表达该词任意一个正确、常见核心义为 is_correct=true；语义方向正确但明显不完整可为 false 并标 meaning。不要要求字典原文、完整覆盖全部词义、固定句型或完整句子。正确答案时 rating 可为 hard/good/easy，错误答案必须为 again。用中文写一句不超过30字的反馈。只返回 {"is_correct":true,"rating":"good","error_layer":"none","feedback":"..."}。`,
            gradeSystemPrompt,
          ));
        } catch (caught) {
          if (isSamplingCapabilityError(caught)) {
            switchCurrentToChineseTest();
            return;
          }
          throw caught;
        }
      }
      const reviewCall = buildReviewSubmission(item, {
        user_answer: cleanAnswer,
        is_correct: grade.is_correct,
        error_layer: grade.error_layer,
        rating: grade.rating,
      });
      const attemptErrorLayer = reviewCall.arguments.error_layer;
      if (reviewCall.name === "record_review_submission") {
        const submission = await callServerTool(reviewCall.name, reviewCall.arguments);
        if (submission.isError) {
          if (isReviewCardAlreadyCompleteResult(submission)) {
            const completed: GradedAnswer = {
              word: item.word,
              answer: cleanAnswer,
              is_correct: true,
              rating: "good",
              error_layer: "none",
              feedback: "这张卡已经完成复习。",
            };
            setResults((current) => [...current.filter((entry) => entry.word !== item.word), completed]);
            setFeedback(completed);
            setStatus("sent");
            return;
          }
          throw new Error("到期复习结果未能保存，请重试。");
        }
      } else {
        const attempt = await callServerTool(reviewCall.name, reviewCall.arguments);
        if (attempt.isError) throw new Error("答题记录未能保存，请重试。");
      }
      const graded: GradedAnswer = { word: item.word, answer: cleanAnswer, ...grade, error_layer: attemptErrorLayer };
      setResults((current) => [...current.filter((entry) => entry.word !== item.word), graded]);
      setFeedback(graded);
      setStatus("sent");
    } catch (caught) {
      setStatus("error");
      setError(reviewErrorMessage(caught));
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
      const reviewCall = buildReviewSubmission(item, {
        user_answer: "",
        is_correct: false,
        error_layer: item.error_layers[0] ?? "meaning",
        rating: "again",
      });
      if (reviewCall.name === "record_review_submission") {
        const submission = await callServerTool(reviewCall.name, reviewCall.arguments);
        if (submission.isError) {
          if (isReviewCardAlreadyCompleteResult(submission)) {
            const completed: GradedAnswer = {
              word: item.word,
              answer: "",
              is_correct: true,
              rating: "good",
              error_layer: "none",
              feedback: "这张卡已经完成复习。",
            };
            setResults((current) => [...current.filter((entry) => entry.word !== item.word), completed]);
            setFeedback(completed);
            setStatus("sent");
            return;
          }
          throw new Error("到期复习结果未能保存，请重试。");
        }
      } else {
        const attempt = await callServerTool(reviewCall.name, reviewCall.arguments);
        if (attempt.isError) throw new Error("答题记录未能保存，请重试。");
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
      setError(reviewErrorMessage(caught));
    } finally {
      submittingRef.current = false;
    }
  }

  function nextQuestion(): void {
    if (!payload || !item || status !== "sent") return;
    if (index === payload.items.length - 1) {
      setFeedback(null);
      setStatus("idle");
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
        <FocusButton />
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
      <FocusButton />
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
