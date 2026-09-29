import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, createCapturedNote, getCapturedNotes, newCaptureIdempotencyKey, promoteCapturedNote, UnauthorizedError, updateCapturedNote, type CaptureSelectionType, type CaptureStatus, type CapturedNote } from "./apiClient.js";

const tabs: Array<{ status: CaptureStatus; label: string }> = [
  { status: "inbox", label: "Inbox" },
  { status: "saved", label: "已收藏" },
  { status: "converted", label: "已加入学习" },
  { status: "dismissed", label: "已丢弃" },
];

const typeLabels: Record<CaptureSelectionType, string> = {
  word: "单词",
  phrase: "短语",
  collocation: "搭配",
  sentence: "句子",
  grammar: "语法",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "请求失败，请重试。";
}

function allowedToPromote(note: CapturedNote): boolean {
  return (note.selection_type === "word" || note.selection_type === "phrase" || note.selection_type === "collocation")
    && /^[\p{Script=Latin}\p{M}]+(?:[ '\u2019-][\p{Script=Latin}\p{M}]+)*$/u.test(note.selected_text.trim())
}

export function CaptureInboxPage({ onBack, onUnauthorized }: {
  onBack: () => void;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<CaptureStatus>("inbox");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CapturedNote[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [manualText, setManualText] = useState("");
  const [manualType, setManualType] = useState<CaptureSelectionType>("word");
  const [manualContext, setManualContext] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const manualIdempotencyKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchInput.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadInitial = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    try {
      const page = await getCapturedNotes({ status, q: query });
      if (sequence !== requestSequence.current) return;
      setItems(page.items);
      setNextCursor(page.next_cursor);
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      if (loadError instanceof UnauthorizedError) onUnauthorized();
      else setError(errorMessage(loadError));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [status, query, onUnauthorized]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const sequence = ++requestSequence.current;
    setLoadingMore(true);
    setError("");
    try {
      const page = await getCapturedNotes({ status, q: query, cursor: nextCursor });
      if (sequence !== requestSequence.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      if (loadError instanceof UnauthorizedError) onUnauthorized();
      else setError(errorMessage(loadError));
    } finally {
      if (sequence === requestSequence.current) setLoadingMore(false);
    }
  };

  const mutateStatus = async (item: CapturedNote, nextStatus: "inbox" | "saved" | "dismissed") => {
    setPendingId(item.id);
    setError("");
    setNotice("");
    try {
      await updateCapturedNote(item.id, { status: nextStatus });
      setNotice(nextStatus === "saved" ? "已收藏到 Notes。" : nextStatus === "dismissed" ? "已移到已丢弃，可随时撤销。" : "已恢复到 Inbox。");
      await loadInitial();
    } catch (mutationError) {
      if (mutationError instanceof UnauthorizedError) onUnauthorized();
      else setError(errorMessage(mutationError));
    } finally {
      setPendingId(null);
    }
  };

  const saveNote = async (item: CapturedNote) => {
    setPendingId(item.id);
    setError("");
    try {
      await updateCapturedNote(item.id, { note: noteDrafts[item.id] ?? item.note });
      setNotice("个人笔记已保存。");
      await loadInitial();
    } catch (mutationError) {
      if (mutationError instanceof UnauthorizedError) onUnauthorized();
      else setError(errorMessage(mutationError));
    } finally {
      setPendingId(null);
    }
  };

  const changeType = async (item: CapturedNote, selectionType: CaptureSelectionType) => {
    setPendingId(item.id);
    setError("");
    try {
      await updateCapturedNote(item.id, { selection_type: selectionType });
      setNotice("条目类型已更新。");
      await loadInitial();
    } catch (mutationError) {
      if (mutationError instanceof UnauthorizedError) onUnauthorized();
      else setError(errorMessage(mutationError));
    } finally {
      setPendingId(null);
    }
  };

  const promote = async (item: CapturedNote) => {
    setPendingId(item.id);
    setError("");
    setNotice("");
    try {
      const result = await promoteCapturedNote(item.id);
      setNotice(result.is_new
        ? "已加入当日新词流程；当前冻结轮次结束后会看到它。"
        : "已关联到已有学习卡，原有复习安排保持不变。");
      await loadInitial();
    } catch (promotionError) {
      if (promotionError instanceof UnauthorizedError) onUnauthorized();
      else setError(errorMessage(promotionError));
    } finally {
      setPendingId(null);
    }
  };

  const submitManual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selectedText = manualText.trim();
    if (!selectedText || pendingId) return;
    const fingerprint = JSON.stringify([selectedText, manualType, manualContext, manualNote]);
    const requestKey = manualIdempotencyKey.current?.fingerprint === fingerprint
      ? manualIdempotencyKey.current.key
      : newCaptureIdempotencyKey();
    manualIdempotencyKey.current = { fingerprint, key: requestKey };
    setPendingId("manual");
    setError("");
    setNotice("");
    try {
      await createCapturedNote({
        selected_text: selectedText,
        selection_type: manualType,
        context_text: manualContext,
        note: manualNote,
        source_type: "manual",
        source_title: document.title.slice(0, 200),
        source_url: window.location.href,
        idempotency_key: requestKey,
      });
      manualIdempotencyKey.current = null;
      setManualText("");
      setManualContext("");
      setManualNote("");
      setNotice("已保存到 Inbox。");
      await loadInitial();
    } catch (saveError) {
      if (saveError instanceof UnauthorizedError) onUnauthorized();
      else setError(errorMessage(saveError));
    } finally {
      setPendingId(null);
    }
  };

  return <section className="widget-card standalone-card capture-page" aria-labelledby="capture-title">
    <header className="capture-page-header">
      <button className="standalone-back capture-back" type="button" onClick={onBack}>← 返回 Dashboard</button>
      <div>
        <span className="eyebrow">WordLoop Notes</span>
        <h1 id="capture-title">划词笔记</h1>
        <p>保存表达和遇到它时的上下文；加入学习由你决定。</p>
      </div>
    </header>

    <form className="capture-manual-form" onSubmit={(event) => void submitManual(event)}>
      <h2>手动记录</h2>
      <label>表达
        <input value={manualText} maxLength={500} required onChange={(event) => setManualText(event.target.value)} placeholder="输入单词、短语或句子" />
      </label>
      <label>类型
        <select value={manualType} onChange={(event) => setManualType(event.target.value as CaptureSelectionType)}>
          {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>上下文（可选）
        <textarea value={manualContext} maxLength={1200} rows={2} onChange={(event) => setManualContext(event.target.value)} placeholder="粘贴短句或段落" />
      </label>
      <label>个人笔记（可选）
        <textarea value={manualNote} maxLength={500} rows={2} onChange={(event) => setManualNote(event.target.value)} placeholder="写下自己的理解" />
      </label>
      <button className="button primary" type="submit" disabled={!manualText.trim() || pendingId !== null}>
        {pendingId === "manual" ? "保存中…" : "保存到 Inbox"}
      </button>
    </form>

    <div className="capture-list-toolbar">
      <nav className="capture-tabs" aria-label="Notes 分类">
        {tabs.map((tab) => <button
          key={tab.status}
          type="button"
          aria-pressed={status === tab.status}
          className={status === tab.status ? "active" : ""}
          onClick={() => setStatus(tab.status)}
        >{tab.label}</button>)}
      </nav>
      <label className="capture-search">搜索表达、笔记或上下文
        <input value={searchInput} maxLength={120} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索" />
      </label>
    </div>

    {notice && <p className="capture-notice" role="status">{notice}</p>}
    {error && <p className="capture-error" role="alert">{error}</p>}
    {loading ? <p className="standalone-status" role="status">正在读取 Notes…</p> : items.length === 0
      ? <p className="capture-empty">{query ? "没有找到匹配的 Notes。" : "这里还没有条目。选中 Lesson 里的文本，或使用上方手动记录。"}</p>
      : <div className="capture-note-list">
        {items.map((item) => <article className="capture-note-card" key={item.id} aria-labelledby={`capture-note-${item.id}`}>
          <div className="capture-note-heading">
            <h2 id={`capture-note-${item.id}`}>{item.selected_text}</h2>
            <span className={`capture-status capture-status-${item.status}`}>{tabs.find((tab) => tab.status === item.status)?.label ?? "Inbox"}</span>
          </div>
          <div className="capture-note-meta">
            <label>类型
              <select aria-label={`${item.selected_text} 的类型`} value={item.selection_type} disabled={pendingId === item.id} onChange={(event) => void changeType(item, event.target.value as CaptureSelectionType)}>
                {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <span>{item.occurrence_count} 次遇到</span>
          </div>
          {item.occurrences.map((occurrence, index) => occurrence.context_text && <blockquote className="capture-context" key={`${occurrence.captured_at}-${index}`}>
            <p>{occurrence.context_text}</p>
            {occurrence.source_title && <cite>{occurrence.source_title}</cite>}
          </blockquote>)}
          <label className="capture-note-editor">个人笔记
            <textarea
              value={noteDrafts[item.id] ?? item.note}
              maxLength={500}
              rows={2}
              onChange={(event) => setNoteDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
            />
          </label>
          <div className="capture-note-actions">
            <button type="button" disabled={pendingId !== null} onClick={() => void saveNote(item)}>保存笔记</button>
            {item.status !== "converted" && <>
              {item.status === "saved"
                ? <button type="button" disabled={pendingId !== null} onClick={() => void mutateStatus(item, "inbox")}>取消收藏</button>
                : item.status === "dismissed"
                  ? <button type="button" disabled={pendingId !== null} onClick={() => void mutateStatus(item, "inbox")}>撤销丢弃</button>
                  : <button type="button" disabled={pendingId !== null} onClick={() => void mutateStatus(item, "saved")}>已经会，只想留着</button>}
              {item.status !== "dismissed" && <button type="button" disabled={pendingId !== null} onClick={() => void mutateStatus(item, "dismissed")}>不需要</button>}
              {allowedToPromote(item) && <button className="capture-promote" type="button" disabled={pendingId !== null} onClick={() => void promote(item)}>
                {pendingId === item.id ? "处理中…" : "加入学习"}
              </button>}
            </>}
            {item.status === "converted" && <p role="status">已关联学习词条。</p>}
          </div>
          {!allowedToPromote(item) && item.status !== "converted" && <p className="capture-hint">{item.selection_type === "sentence" || item.selection_type === "grammar"
            ? "句子和语法条目保存在 Notes，暂不支持 FSRS 卡。"
            : "请先把表达修正为单词或短语，再加入学习。"}</p>}
        </article>)}
      </div>}
    {nextCursor && !loading && <button className="capture-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
      {loadingMore ? "正在读取…" : "加载更多"}
    </button>}
  </section>;
}
