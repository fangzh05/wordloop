import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button.js";
import {
  ApiError,
  addCaptureNoteToLearning,
  getCaptureNotes,
  updateCaptureNote,
  type CaptureListResponse,
  type CaptureNote,
  type CaptureStatus,
} from "./apiClient.js";

const tabs: Array<{ status: CaptureStatus; label: string }> = [
  { status: "inbox", label: "待整理" },
  { status: "saved", label: "收藏" },
  { status: "learning", label: "已加入" },
  { status: "archived", label: "归档" },
];

function canJoinLearning(item: CaptureNote): boolean {
  return /^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*)?$/u.test(item.selected_text.trim());
}

function sourceLabel(value: string): string {
  if (value === "lesson") return "Lesson";
  if (value === "review") return "复习";
  if (value === "pretest") return "预测试";
  if (value === "dashboard") return "Dashboard";
  return "手动";
}

export function CaptureNotesPage({ onBack, onCountsChange }: {
  onBack: () => void;
  onCountsChange?: (counts: CaptureListResponse["counts"]) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<CaptureStatus>("inbox");
  const [items, setItems] = useState<CaptureNote[]>([]);
  const [counts, setCounts] = useState<CaptureListResponse["counts"]>({ inbox: 0, saved: 0, learning: 0, archived: 0 });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (nextStatus = status) => {
    setLoading(true);
    setError("");
    try {
      const response = await getCaptureNotes(nextStatus, 120);
      setItems(response.items);
      setCounts(response.counts);
      onCountsChange?.(response.counts);
      setDrafts(Object.fromEntries(response.items.map((item) => [item.id, item.note])));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "划词笔记加载失败，请重试。");
    } finally {
      setLoading(false);
    }
  }, [onCountsChange, status]);

  useEffect(() => {
    void load(status);
  }, [load, status]);

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) => [
      item.selected_text,
      item.note,
      item.latest_occurrence?.context_text ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [items, query]);

  const mutateStatus = async (item: CaptureNote, nextStatus: CaptureStatus) => {
    setBusyId(item.id);
    setMessage("");
    setError("");
    try {
      await updateCaptureNote(item.id, { status: nextStatus, note: drafts[item.id] ?? item.note });
      await load(status);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "更新失败，请重试。");
    } finally {
      setBusyId(null);
    }
  };

  const saveNote = async (item: CaptureNote) => {
    setBusyId(item.id);
    setMessage("");
    setError("");
    try {
      const response = await updateCaptureNote(item.id, { note: drafts[item.id] ?? "" });
      setItems((current) => current.map((value) => value.id === item.id ? response.item : value));
      setMessage("笔记已保存。");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "笔记保存失败，请重试。");
    } finally {
      setBusyId(null);
    }
  };

  const joinLearning = async (item: CaptureNote) => {
    setBusyId(item.id);
    setMessage("");
    setError("");
    try {
      await updateCaptureNote(item.id, { note: drafts[item.id] ?? item.note });
      const response = await addCaptureNoteToLearning(item.id);
      setMessage(response.learning_update?.scheduled_today
        ? "已加入 WordLoop，今天会作为新词出现。"
        : "已连接到已有 WordLoop 词条，不会重置现有 FSRS 进度。");
      await load(status);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "加入学习失败，请重试。");
    } finally {
      setBusyId(null);
    }
  };

  return <section className="widget-card standalone-card capture-notes-page" aria-labelledby="capture-notes-title">
    <header className="widget-header compact-header">
      <div className="standalone-study-heading">
        <button className="standalone-back" type="button" onClick={onBack}>← 返回</button>
        <div><span className="eyebrow">Capture</span><h1 id="capture-notes-title">划词笔记</h1></div>
      </div>
      <span className="standalone-count">{counts.inbox} 待整理</span>
    </header>

    <div className="capture-tabs" role="tablist" aria-label="划词笔记状态">
      {tabs.map((tab) => <button
        key={tab.status}
        type="button"
        role="tab"
        aria-selected={status === tab.status}
        className={status === tab.status ? "active" : ""}
        onClick={() => setStatus(tab.status)}
      >
        {tab.label}<span>{counts[tab.status]}</span>
      </button>)}
    </div>

    <div className="capture-toolbar">
      <input
        className="answer-input standalone-input"
        type="search"
        placeholder="搜索单词、笔记或原句"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>

    {message && <p className="standalone-status" role="status">{message}</p>}
    {error && <p className="standalone-status error" role="alert">{error}</p>}
    {loading && <p className="standalone-status" role="status">正在加载划词笔记…</p>}

    {!loading && visibleItems.length === 0 && <div className="capture-empty">
      <strong>{query ? "没有匹配项" : status === "inbox" ? "待整理箱是空的" : "这里还没有内容"}</strong>
      <p>{status === "inbox" && !query ? "在 WordLoop 里长按或拖选文本，然后点“记录”。捕获不会自动进入 FSRS。" : "可以切换其他状态继续查看。"}</p>
    </div>}

    <div className="capture-note-list">
      {visibleItems.map((item) => {
        const busy = busyId === item.id;
        const learnable = canJoinLearning(item);
        return <article key={item.id} className="capture-note-card">
          <div className="capture-note-heading">
            <div>
              <strong>{item.selected_text}</strong>
              <div className="capture-meta">
                <span>{item.selection_type === "word" ? "单词" : item.selection_type === "phrase" ? "短语" : "句子"}</span>
                <span>遇到 {item.occurrence_count} 次</span>
                {item.latest_occurrence && <span>{sourceLabel(item.latest_occurrence.source_type)}</span>}
              </div>
            </div>
            {item.status === "learning" && <span className="capture-state-badge">已加入</span>}
          </div>

          {item.latest_occurrence?.context_text && <blockquote className="capture-context" data-capture-context="true">
            {item.latest_occurrence.context_text}
          </blockquote>}

          <label className="answer-label" htmlFor={`capture-note-${item.id}`}>我的一句话理解</label>
          <textarea
            id={`capture-note-${item.id}`}
            className="standalone-input capture-note-input"
            rows={2}
            maxLength={2000}
            value={drafts[item.id] ?? ""}
            placeholder="可选。只记你以后需要想起的那一点。"
            onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
          />

          <div className="capture-note-actions">
            <Button className="secondary" type="button" disabled={busy || (drafts[item.id] ?? "") === item.note} onClick={() => void saveNote(item)}>
              保存笔记
            </Button>

            {item.status === "inbox" && <Button className="secondary" type="button" disabled={busy} onClick={() => void mutateStatus(item, "saved")}>仅收藏</Button>}
            {item.status === "archived" && <Button className="secondary" type="button" disabled={busy} onClick={() => void mutateStatus(item, "inbox")}>移回待整理</Button>}
            {item.status !== "archived" && item.status !== "learning" && <Button
              type="button"
              disabled={busy || !learnable}
              title={learnable ? "显式加入 WordLoop 学习池" : "现有学习队列暂只支持单词或两词短语"}
              onClick={() => void joinLearning(item)}
            >加入学习</Button>}
            {(item.status === "saved" || item.status === "learning") && <Button className="secondary" type="button" disabled={busy} onClick={() => void mutateStatus(item, "archived")}>归档</Button>}
          </div>

          {!learnable && item.status !== "learning" && <p className="capture-note-hint">更长的搭配或整句先作为笔记保留，不会被硬塞进现有单词 FSRS。</p>}
        </article>;
      })}
    </div>
  </section>;
}
