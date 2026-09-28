import { useEffect, useRef, useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ArrowIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { FocusButton } from "../components/FocusButton.js";
import { gradeTargetWord } from "../grading/deterministic.js";
import { callServerTool, sendUserMessage, subscribeToApp } from "../mcpBridge.js";
import {
  advanceStudySessionSchema,
  errorLayerSchema,
  fsrsRatingSchema,
  normalizeReviewWidgetPayload,
  recordAttemptSchema,
  recordReviewSubmissionSchema,
  reviewAnswerSchema,
  reviewWidgetPayloadSchema,
  type ErrorLayer,
  type FsrsRating,
  type RecordAttemptInput,
  type RecordReviewSubmissionInput,
  type ReviewAnswerInput,
  type ReviewWidgetPayload,
} from "../../../shared/toolContracts.js";

const payloadSchema = reviewWidgetPayloadSchema;
const REVIEW_AUTO_ADVANCE_MS = 450;
const REVIEW_CORRECT_AUTO_ADVANCE_MS = 150;
const REVIEW_SPELLING_AUTO_ADVANCE_MS = 900;

type Payload = ReviewWidgetPayload;
export type ReviewItem = Payload["items"][number];
type AnswerStatus = "idle" | "sending" | "sent" | "error";
type GradedAnswer = {
  word: string;
  answer: string;
  is_correct: boolean;
  rating: FsrsRating;
  error_layer: ErrorLayer;
  feedback: string;
  correct_spelling?: string;
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

export function buildReviewAnswerSubmission(
  item: Pick<ReviewItem, "word">,
  isCorrect: boolean,
  currentIndex: number,
): ReviewAnswerInput {
  const answer = reviewAnswerSchema.parse({
    event: "review_answer",
    word: item.word,
    is_correct: isCorrect,
    current_index: currentIndex,
  });
  advanceStudySessionSchema.parse(answer);
  return answer;
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

/** The deterministic grader keeps the near miss correct, but the UI must
 * teach the exact target spelling before advancing to the next card. */
export function correctSpellingForReview(
  item: Pick<ReviewItem, "word" | "direction">,
  errorLayer: ErrorLayer,
): string | undefined {
  return item.direction === "cn_to_en" && errorLayer === "spelling" ? item.word : undefined;
}

export function reviewAutoAdvanceDelay(isCorrect: boolean, errorLayer: ErrorLayer): number;
export function reviewAutoAdvanceDelay(errorLayer: ErrorLayer): number;
export function reviewAutoAdvanceDelay(isCorrectOrErrorLayer: boolean | ErrorLayer, maybeErrorLayer?: ErrorLayer): number {
  const isCorrect = typeof isCorrectOrErrorLayer === "boolean" ? isCorrectOrErrorLayer : true;
  const errorLayer = typeof isCorrectOrErrorLayer === "boolean" ? maybeErrorLayer : isCorrectOrErrorLayer;
  if (errorLayer === "spelling") return REVIEW_SPELLING_AUTO_ADVANCE_MS;
  return isCorrect ? REVIEW_CORRECT_AUTO_ADVANCE_MS : REVIEW_AUTO_ADVANCE_MS;
}

function reviewErrorMessage(caught: unknown): string {
  if (caught instanceof Error && /FSRS_CARD_NOT_DUE|FSRS card is not due/i.test(caught.message)) return "这张卡已经完成复习。";
  return caught instanceof Error ? caught.message : "答案未能提交，请重试。";
}

function resultLabel(result: GradedAnswer): string {
  return result.is_correct ? "✓ 已记住" : "× 再复习一次";
}

export function ReviewQuestion({ item }: { item: ReviewItem }): React.JSX.Element {
  return <div className="question-block">
    <span className="question-label">中 → 英</span>
    {item.part_of_speech ? <span className="part-of-speech">{item.part_of_speech}</span> : null}
    <p className="question-prompt">{item.meaning_zh}</p>
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
  const answerRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const payloadSignatureRef = useRef("");

  function initializePayload(nextPayload: Payload, signature: string): void {
    const safePayload = normalizeReviewWidgetPayload(nextPayload);
    const persistedIndex = safePayload.current_index ?? 0;
    const isComplete = safePayload.phase === "review_complete" || persistedIndex >= safePayload.items.length;
    setPayload(safePayload);
    setIndex(Math.min(persistedIndex, safePayload.items.length - 1));
    setAnswer("");
    setStatus("idle");
    setError("");
    setFeedback(null);
    setResults([]);
    setCompleted(isComplete);
    setContinueStatus("idle");

  }

  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput"
      ? { widget: "review", ...event.value }
      : event.value.structuredContent;
    const parsed = payloadSchema.safeParse(candidate);
    if (!parsed.success) return;
    const safePayload = normalizeReviewWidgetPayload(parsed.data);
    const signature = JSON.stringify(safePayload);
    if (payloadSignatureRef.current === signature) return;
    payloadSignatureRef.current = signature;
    setPayload(null);
    setIndex(0);
    setAnswer("");
    setStatus("idle");
    setError("");
    setFeedback(null);
    setResults([]);
    setCompleted(false);
    setContinueStatus("idle");
    void initializePayload(safePayload, signature);
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
    }, reviewAutoAdvanceDelay(feedback.is_correct, feedback.error_layer));
    return () => clearTimeout(timer);
  }, [status, feedback, index, payload]);

  useEffect(() => {
    if (!completed || !payload || continueStatus !== "idle") return;
    const timer = setTimeout(() => void continueLearning(), 0);
    return () => clearTimeout(timer);
  }, [completed, payload, continueStatus]);

  const item = payload?.items[index];

  async function persistReviewDraft(
    reviewItem: ReviewItem,
    reviewIndex: number,
    draft: {
      user_answer: string;
      is_correct: boolean;
      error_layer: ErrorLayer;
      rating: FsrsRating;
      feedback: string;
      correct_spelling?: string;
    },
  ): Promise<GradedAnswer> {
    const reviewCall = buildReviewSubmission(reviewItem, draft);
    let alreadyPersisted = false;
    const result = await callServerTool(reviewCall.name, reviewCall.arguments);
    if (result.isError) {
      if (!isReviewCardAlreadyCompleteResult(result)) {
        throw new Error(reviewCall.name === "record_review_submission"
          ? "到期复习结果未能保存，请重试。"
          : "答题记录未能保存，请重试。");
      }
      alreadyPersisted = true;
    }

    if (!window.__WORDLOOP_PREVIEW__ && !shouldAdvanceFsrs(reviewItem.review_kind)) {
      const cursor = buildReviewAnswerSubmission(reviewItem, draft.is_correct, reviewIndex);
      const advanced = await callServerTool("advance_study_session", cursor);
      if (advanced.isError) throw new Error("复习进度未能保存，请重试。");
    }

    return {
      word: reviewItem.word,
      answer: draft.user_answer,
      is_correct: draft.is_correct,
      rating: draft.rating,
      error_layer: reviewCall.arguments.error_layer,
      feedback: alreadyPersisted ? "这张卡已经完成复习。" : draft.feedback,
      ...(draft.correct_spelling ? { correct_spelling: draft.correct_spelling } : {}),
    };
  }

  async function submit(): Promise<void> {
    if (!payload || !item || !answer.trim() || status === "sending" || status === "sent" || submittingRef.current) return;
    submittingRef.current = true;
    const cleanAnswer = answer.trim();
    setStatus("sending");
    setError("");
    try {
      const grade = gradeReviewCnToEn(cleanAnswer, item.word);
      const graded = await persistReviewDraft(item, index, {
        user_answer: cleanAnswer,
        is_correct: grade.is_correct,
        error_layer: grade.error_layer,
        rating: grade.rating,
        feedback: grade.feedback,
        correct_spelling: correctSpellingForReview(item, grade.error_layer),
      });
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
      const graded = await persistReviewDraft(item, index, {
        user_answer: "",
        is_correct: false,
        error_layer: "meaning",
        rating: "again",
        feedback: "已标记为不会。",
      });
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
    if (!payload || !completed || continueStatus === "sending" || continueStatus === "sent") return;
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
      placeholder="输入英文单词…"
      autoCapitalize="none"
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="send"
      disabled={status === "sending" || status === "sent"}
    />
    {status === "error" ? <p className="error-text" role="alert">{error}</p> : null}
    {feedback ? <div className={`inline-feedback status-only ${feedback.is_correct ? "known" : "unknown"}`} role="status">
      <strong>{resultLabel(feedback)}</strong><span>{feedback.feedback}</span>
      {feedback.correct_spelling ? <span className="correct-spelling"><strong>正确拼法：</strong>{feedback.correct_spelling}</span> : null}
    </div> : null}
    <div className="pretest-actions">
      {status === "sent" ? <Button onClick={nextQuestion}>{index === payload.items.length - 1 ? "查看结果" : "下一题"}{index === payload.items.length - 1 ? null : <ArrowIcon className="button-icon trailing" />}</Button> : <>
        <Button className="secondary unknown-action" onClick={() => void markUnknown()} disabled={status === "sending"}>不会</Button>
        <Button onClick={() => void submit()} disabled={!answer.trim() || status === "sending"}>{status === "sending" ? "正在保存…" : "提交"}</Button>
      </>}
    </div>
  </section>;
}
