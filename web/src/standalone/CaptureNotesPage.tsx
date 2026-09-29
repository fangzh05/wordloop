import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { CaptureDetail } from "./components/CaptureDetail.js";
import {
  ApiError,
  getCaptureNotes,
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

export function CaptureNotesPage({ onBack, onCountsChange }: {
  onBack: () => void;
  onCountsChange?: (counts: CaptureListResponse["counts"]) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<CaptureStatus>("inbox");
  const [items, setItems] = useState<CaptureNote[]>([]);
  const [selectedNote, setSelectedNote] = useState<CaptureNote | null>(null);
  const [counts, setCounts] = useState<CaptureListResponse["counts"]>({ inbox: 0, saved: 0, learning: 0, archived: 0 });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (nextStatus: CaptureStatus, nextQuery: string, cursor = "", append = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const currentRequest = ++requestId.current;
    setError("");
    setLoading(!append);
    setLoadingMore(append);
    if (!append) {
      setItems([]);
      setNextCursor(null);
    }
    try {
      const response = await getCaptureNotes(nextStatus, 50, nextQuery, cursor, controller.signal);
      if (currentRequest !== requestId.current) return;
      setItems((current) => {
        const merged = append ? [...current, ...response.items] : response.items;
        return [...new Map(merged.map((item) => [item.id, item])).values()];
      });
      setCounts(response.counts);
      setNextCursor(response.next_cursor);
      onCountsChange?.(response.counts);
      setDrafts((current) => {
        const next = { ...current };
        for (const item of response.items) next[item.id] ??= item.note;
        return next;
      });
    } catch (caught) {
      if (controller.signal.aborted || currentRequest !== requestId.current) return;
      setError(caught instanceof ApiError ? caught.message : "划词笔记加载失败，请重试。");
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [onCountsChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void load(status, debouncedQuery);
    return () => abortRef.current?.abort();
  }, [debouncedQuery, load, status]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reload = useCallback(() => load(status, debouncedQuery), [debouncedQuery, load, status]);
  const onNoteChange = useCallback((note: CaptureNote) => {
    setSelectedNote(note);
    setItems((current) => current.map((item) => item.id === note.id ? note : item));
  }, []);
  const onMutation = useCallback((nextMessage: string) => {
    setMessage(nextMessage);
    void reload();
  }, [reload]);

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
      <label className="sr-only" htmlFor="capture-search">搜索划词笔记</label>
      <input
        id="capture-search"
        className="answer-input standalone-input"
        type="search"
        placeholder="搜索文本、笔记或原句"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>

    {message && <p className="standalone-status" role="status">{message}</p>}
    {error && <p className="standalone-status error" role="alert">{error}</p>}

    <div className={`capture-content-grid${selectedNote ? " capture-detail-open" : ""}`}>
      <div className="capture-list-pane">
        {loading && <p className="standalone-status" role="status">正在加载划词笔记…</p>}
        {!loading && items.length === 0 && <div className="capture-empty">
          <strong>{debouncedQuery ? "没有匹配项" : status === "inbox" ? "待整理箱是空的" : "这里还没有内容"}</strong>
          <p>{status === "inbox" && !debouncedQuery ? "在 WordLoop 里长按或拖选文本，然后点“记录”。捕获不会自动进入 FSRS。" : "可以切换其他状态继续查看。"}</p>
        </div>}
        <div className="capture-note-list">
          {items.map((item) => <button
            key={item.id}
            type="button"
            className={`capture-note-card capture-note-open${selectedNote?.id === item.id ? " active" : ""}`}
            aria-current={selectedNote?.id === item.id ? "true" : undefined}
            onClick={() => setSelectedNote(item)}
          >
            <span className="capture-note-heading">
              <span className="capture-note-list-copy">
                <strong>{item.selected_text}</strong>
                <span className="capture-meta">
                  <span>{selectionLabel(item.selection_type)}</span>
                  <span>遇到 {item.occurrence_count} 次</span>
                  {item.latest_occurrence && <span>{sourceLabel(item.latest_occurrence.source_type, item.latest_occurrence.source_title)}</span>}
                </span>
                {item.latest_occurrence?.context_text && <span className="capture-context capture-context-preview">{item.latest_occurrence.context_text}</span>}
              </span>
              {item.user_word_id && <span className="capture-state-badge">{item.status === "archived" ? "已加入 · 已归档" : "已加入"}</span>}
            </span>
          </button>)}
        </div>
        {nextCursor && <div className="capture-load-more">
          <Button className="secondary" type="button" disabled={loadingMore} onClick={() => void load(status, debouncedQuery, nextCursor, true)}>
            {loadingMore ? "正在加载…" : "加载更多"}
          </Button>
        </div>}
      </div>
      {selectedNote && <CaptureDetail
        note={selectedNote}
        draft={drafts[selectedNote.id] ?? selectedNote.note}
        onDraftChange={(id, value) => setDrafts((current) => ({ ...current, [id]: value }))}
        onBack={() => setSelectedNote(null)}
        onNoteChange={onNoteChange}
        onMutation={onMutation}
      />}
    </div>
  </section>;
}
