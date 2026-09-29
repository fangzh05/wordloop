import { useEffect, useState } from "react";
import { Button } from "../../components/Button.js";
import {
  ApiError,
  addCaptureNoteToLearning,
  getCaptureNote,
  getCaptureNoteOccurrences,
  updateCaptureNote,
  type CaptureNote,
  type CaptureOccurrence,
} from "../apiClient.js";

function canJoinLearning(item: CaptureNote): boolean {
  return item.selected_text.trim().split(/\s+/u).length <= 2
    && /^[\p{Script=Latin}\p{M}]+(?:[ '\u2019-][\p{Script=Latin}\p{M}]+)*$/u.test(item.selected_text.trim())
    && ["word", "phrase", "collocation"].includes(item.selection_type);
}

function sourceLabel(value: string, title: string | null): string {
  if (value === "lesson_example" || value === "lesson_prompt") return "Lesson";
  if (value === "review_question") return "复习";
  return title || "手动记录";
}

function selectionLabel(value: string): string {
  if (value === "word") return "单词";
  if (value === "phrase" || value === "collocation") return "短语 / 搭配";
  if (value === "sentence") return "句子";
  if (value === "grammar") return "语法笔记";
  return "笔记";
}

export function CaptureDetail({
  note: listedNote,
  draft,
  onDraftChange,
  onBack,
  onNoteChange,
  onMutation,
}: {
  note: CaptureNote;
  draft: string;
  onDraftChange: (id: string, value: string) => void;
  onBack: () => void;
  onNoteChange: (note: CaptureNote) => void;
  onMutation: (message: string) => void;
}): React.JSX.Element {
  const [note, setNote] = useState(listedNote);
  const [occurrences, setOccurrences] = useState<CaptureOccurrence[]>(listedNote.occurrences);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(listedNote.occurrence_count);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void Promise.all([
      getCaptureNote(listedNote.id),
      getCaptureNoteOccurrences(listedNote.id, 50, "", controller.signal),
    ]).then(([detail, page]) => {
      if (controller.signal.aborted) return;
      setNote(detail.item);
      onNoteChange(detail.item);
      setOccurrences(page.items);
      setNextCursor(page.next_cursor);
      setTotal(page.total);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(caught instanceof ApiError ? caught.message : "笔记详情加载失败，请重试。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [listedNote.id, onNoteChange]);

  const persistDraft = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await updateCaptureNote(note.id, { note: draft });
      setNote(result.item);
      onNoteChange(result.item);
      onDraftChange(note.id, result.item.note);
      onMutation("笔记已保存。");
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "笔记保存失败，请重试。");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const updateStatus = async (status: "inbox" | "saved" | "archived") => {
    setBusy(true);
    setError("");
    try {
      const result = await updateCaptureNote(note.id, { note: draft, status });
      setNote(result.item);
      onNoteChange(result.item);
      onDraftChange(note.id, result.item.note);
      onMutation(status === "archived" ? "已归档。" : status === "saved" ? "已收藏。" : "已移回待整理。 ");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "更新失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const joinLearning = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await updateCaptureNote(note.id, { note: draft });
      setNote(saved.item);
      onNoteChange(saved.item);
      onDraftChange(note.id, saved.item.note);
      const result = await addCaptureNoteToLearning(note.id);
      setNote(result.item);
      onNoteChange(result.item);
      onMutation(result.learning_update?.scheduled_today
        ? "已加入今日计划，会作为新词出现。"
        : "已连接到已有词库；现有学习状态和下次复习时间已保留。");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "加入学习失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    const controller = new AbortController();
    setLoadingMore(true);
    setError("");
    try {
      const page = await getCaptureNoteOccurrences(note.id, 50, nextCursor, controller.signal);
      setOccurrences((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
      setTotal(page.total);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "出现记录加载失败，请重试。");
    } finally {
      setLoadingMore(false);
    }
  };

  return <section className="capture-detail" aria-labelledby="capture-detail-title">
    <header className="capture-detail-header">
      <button className="standalone-back capture-detail-back" type="button" onClick={onBack}>← 列表</button>
      <span className="eyebrow">划词详情</span>
      {note.user_word_id && <span className="capture-state-badge">{note.status === "archived" ? "已连接词库 · 已归档" : "已连接词库"}</span>}
    </header>
    <h2 id="capture-detail-title">{note.selected_text}</h2>
    <div className="capture-meta">
      <span>{selectionLabel(note.selection_type)}</span>
      <span>出现 {total} 次</span>
      <span>首次记录 {new Date(note.first_seen_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>
    </div>
    {note.status === "learning" && <p className="capture-note-hint">已加入表示笔记已链接词库，不代表单词已学完或掌握。</p>}
    {loadError && <p className="standalone-status error" role="alert">{loadError}</p>}
    {loading && <p className="standalone-status" role="status">正在加载全部出现记录…</p>}

    <section className="capture-detail-section" aria-labelledby="capture-occurrences-title">
      <div className="capture-detail-section-heading">
        <h3 id="capture-occurrences-title">全部出现记录</h3>
        <span>{total}</span>
      </div>
      {occurrences.map((occurrence, index) => <article className="capture-occurrence" key={`${occurrence.created_at}-${index}`}>
        <div className="capture-meta">
          <span>{sourceLabel(occurrence.source_type, occurrence.source_title)}</span>
          <time dateTime={occurrence.created_at}>{new Date(occurrence.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</time>
        </div>
        {occurrence.context_text && <blockquote>{occurrence.context_text}</blockquote>}
        {occurrence.source_url && <a href={occurrence.source_url} target="_blank" rel="noreferrer">打开来源</a>}
      </article>)}
      {nextCursor && <Button className="secondary" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
        {loadingMore ? "正在加载…" : "加载更早记录"}
      </Button>}
    </section>

    <section className="capture-detail-section" aria-labelledby="capture-my-note-title">
      <label className="answer-label" id="capture-my-note-title" htmlFor={`capture-detail-note-${note.id}`}>我的理解</label>
      <textarea
        id={`capture-detail-note-${note.id}`}
        className="standalone-input capture-note-input"
        rows={4}
        maxLength={500}
        value={draft}
        placeholder="最多 500 字。"
        onChange={(event) => onDraftChange(note.id, event.target.value)}
      />
      <div className="capture-detail-actions">
        <Button className="secondary" type="button" disabled={busy || draft === note.note} onClick={() => void persistDraft()}>保存理解</Button>
        {note.status === "inbox" && <Button className="secondary" type="button" disabled={busy} onClick={() => void updateStatus("saved")}>仅收藏</Button>}
        {note.status === "archived" && <Button className="secondary" type="button" disabled={busy} onClick={() => void updateStatus("inbox")}>{note.user_word_id ? "恢复已加入" : "移回待整理"}</Button>}
        {note.status !== "archived" && note.status !== "learning" && !note.user_word_id && <Button type="button" disabled={busy || !canJoinLearning(note)} onClick={() => void joinLearning()}>加入学习</Button>}
        {(note.status === "saved" || note.status === "learning" || note.user_word_id) && note.status !== "archived" && <Button className="secondary" type="button" disabled={busy} onClick={() => void updateStatus("archived")}>归档</Button>}
      </div>
      {!canJoinLearning(note) && !note.user_word_id && note.status !== "learning" && <p className="capture-note-hint">这类内容可继续保存在笔记中；当前学习队列仅接收单词和受支持的短语。</p>}
      {error && <p className="standalone-status error" role="alert">{error}</p>}
    </section>
  </section>;
}
