import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import {
  ApiError,
  getNoteReviews,
  newNoteReviewIdempotencyKey,
  rateNoteReview,
  type NoteReviewItem,
  type NoteReviewRating,
} from "./apiClient.js";

function sourceLabel(value: string, title: string | null): string {
  if (value === "lesson_example" || value === "lesson_prompt") return "Lesson";
  if (value === "review_question") return "复习";
  return title || "手动记录";
}

export function NoteReviewCard({
  item,
  revealed,
  busy,
  onReveal,
  onRate,
}: {
  item: NoteReviewItem;
  revealed: boolean;
  busy: boolean;
  onReveal: () => void;
  onRate: (rating: NoteReviewRating) => void;
}): React.JSX.Element {
  return <article className="note-review-card" aria-labelledby={`note-review-${item.note_id}`}>
    <div className="note-review-front">
      <span className="eyebrow">回忆</span>
      <h2 id={`note-review-${item.note_id}`}>{item.selected_text}</h2>
      <p className="note-review-prompt">回忆它的含义或用法。</p>
      {!revealed && <Button type="button" disabled={busy} onClick={onReveal}>查看理解</Button>}
    </div>
    {revealed && <div className="note-review-answer" aria-live="polite">
      <section>
        <span className="eyebrow">我的理解</span>
        <p className="note-review-note">{item.note}</p>
      </section>
      {item.latest_occurrence?.context_text && <section className="note-review-context">
        <span className="eyebrow">最近原文</span>
        <blockquote>{item.latest_occurrence.context_text}</blockquote>
        <div className="capture-meta">
          <span>{sourceLabel(item.latest_occurrence.source_type, item.latest_occurrence.source_title)}</span>
          <time dateTime={item.latest_occurrence.captured_at}>{new Date(item.latest_occurrence.captured_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</time>
        </div>
        {item.latest_occurrence.source_url && <a href={item.latest_occurrence.source_url} target="_blank" rel="noreferrer">打开来源</a>}
      </section>}
      <div className="note-review-actions" aria-label="笔记复习评分">
        <Button className="secondary" type="button" disabled={busy} onClick={() => onRate("again")}>Again</Button>
        <Button type="button" disabled={busy} onClick={() => onRate("good")}>Good</Button>
      </div>
    </div>}
  </article>;
}

export function NoteReviewPage({ onBack, onCountChange }: {
  onBack: () => void;
  onCountChange?: (count: number) => void;
}): React.JSX.Element {
  const [items, setItems] = useState<NoteReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ratingKeys = useRef(new Map<string, string>());

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await getNoteReviews(signal);
      if (signal?.aborted) return;
      setItems(response.items);
      setTotal(response.total);
      setRevealed(false);
      onCountChange?.(response.total);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof ApiError ? caught.message : "笔记复习加载失败，请重试。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const rate = async (rating: NoteReviewRating) => {
    const item = items[0];
    if (!item || busy) return;
    const idempotencyKey = ratingKeys.current.get(item.note_id) ?? newNoteReviewIdempotencyKey();
    ratingKeys.current.set(item.note_id, idempotencyKey);
    setBusy(true);
    setError("");
    try {
      await rateNoteReview(item.note_id, {
        rating,
        expected_revision: item.revision,
        expected_note_updated_at: item.note_updated_at,
        idempotency_key: idempotencyKey,
      });
      ratingKeys.current.delete(item.note_id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "评分未保存，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const current = items[0] ?? null;

  return <section className="widget-card standalone-card note-review-page" aria-labelledby="note-review-title">
    <header className="widget-header compact-header">
      <div className="standalone-study-heading">
        <button className="standalone-back" type="button" onClick={onBack}>← 划词笔记</button>
        <div><span className="eyebrow">Capture</span><h1 id="note-review-title">笔记复习</h1></div>
      </div>
      <span className="standalone-count">{total} 项待复习</span>
    </header>
    {error && <div className="note-review-status"><p className="standalone-status error" role="alert">{error}</p><Button className="secondary" type="button" disabled={busy} onClick={() => void load()}>重新加载</Button></div>}
    {loading && <p className="standalone-status" role="status">正在加载到期笔记…</p>}
    {!loading && !error && !current && <div className="capture-empty note-review-empty">
      <strong>现在没有到期的笔记</strong>
      <p>在划词详情中填写“我的理解”，再明确加入笔记复习。</p>
      <Button className="secondary" type="button" onClick={onBack}>返回划词笔记</Button>
    </div>}
    {!loading && current && <NoteReviewCard item={current} revealed={revealed} busy={busy} onReveal={() => setRevealed(true)} onRate={(rating) => void rate(rating)} />}
    {!loading && !error && current && total > items.length && <p className="standalone-status note-review-batch-hint" role="status">本轮最多显示 10 项，完成后会继续下一批。</p>}
  </section>;
}
