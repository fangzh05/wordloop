import { useEffect, useRef, useState } from "react";
import { getVocabularyPage, type VocabularyListItem } from "../apiClient.js";
import { WordDetailPanel } from "../components/WordDetailPanel.js";
import { ShanbayImportPanel } from "../components/ShanbayImportPanel.js";

const filterOptions = [
  ["not_started", "未开始"], ["in_memory", "已进入记忆"], ["active_error", "有活动错误"], ["due", "到期"],
] as const;

function statusLabel(value: string): string {
  return ({ new: "未开始", known: "认识", uncertain: "不确定", unknown: "不认识", review: "学习中", mastered: "已掌握" } as Record<string, string>)[value] ?? value;
}

export function VocabularyPage({ tokenKey, initialUserWordId = null, onDetailChange = () => undefined }: {
  tokenKey: string | null;
  initialUserWordId?: string | null;
  onDetailChange?: (userWordId: string | null) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [importRevision, setImportRevision] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filters, setFilters] = useState<string[]>([]);
  const [items, setItems] = useState<VocabularyListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialUserWordId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const listScrollRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setDebouncedQuery(""); return; }
    const timer = window.setTimeout(() => setDebouncedQuery(q), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setItems([]);
    setCursor(null);
    void getVocabularyPage(debouncedQuery, filters, "", 50, controller.signal).then((page) => {
      if (id !== requestId.current) return;
      setItems(page.data.items);
      setCursor(page.next_cursor ?? null);
    }).catch(() => {
      if (!controller.signal.aborted && id === requestId.current) setError("词库结果暂时无法读取。");
    }).finally(() => {
      if (id === requestId.current) setLoading(false);
    });
    return () => controller.abort();
  }, [debouncedQuery, filters, tokenKey, importRevision]);

  useEffect(() => {
    if (!selected) return;
    onDetailChange(selected);
  }, [selected, onDetailChange]);

  const toggleFilter = (value: string) => {
    setFilters((current) => current.includes(value) ? current.filter((filter) => filter !== value) : [...current, value]);
  };

  const loadMore = async () => {
    if (!cursor || loading) return;
    const id = requestId.current;
    const controller = new AbortController();
    setLoading(true);
    setLoadMoreError("");
    try {
      const page = await getVocabularyPage(debouncedQuery, filters, cursor, 50, controller.signal);
      if (id !== requestId.current) return;
      setItems((current) => [...current, ...page.data.items]);
      setCursor(page.next_cursor ?? null);
    } catch {
      if (!controller.signal.aborted) setLoadMoreError("加载更多词条失败，请重试。");
    } finally { setLoading(false); }
  };

  const closeDetail = () => {
    setSelected(null);
    onDetailChange(null);
  };

  return <section className={`vocabulary-page${selected ? " has-word-detail" : ""}`} aria-labelledby="vocabulary-title">
    <header className="page-heading"><span className="eyebrow">Vocabulary</span><h1 id="vocabulary-title">词库</h1><p>保存每一个词，也保留每一次理解。</p></header>
    <ShanbayImportPanel key={tokenKey} onImported={() => setImportRevision((revision) => revision + 1)} />
    <div className="vocabulary-toolbar">
      <label className="vocabulary-search-label" htmlFor="vocabulary-search">搜索词条</label>
      <div className="vocabulary-search-row"><input id="vocabulary-search" type="search" value={query} maxLength={120} placeholder="输入英文单词或短语" onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" className="secondary-button" onClick={() => { setQuery(""); setDebouncedQuery(""); }}>清除</button>}</div>
      <fieldset className="vocabulary-filter-group"><legend>筛选</legend>{filterOptions.map(([value, label]) => <label key={value}><input type="checkbox" checked={filters.includes(value)} onChange={() => toggleFilter(value)} />{label}</label>)}</fieldset>
    </div>
    <div className="vocabulary-content-grid">
      <div className="vocabulary-list-pane" ref={listScrollRef} aria-label="词库结果" aria-busy={loading}>
        {error && <p className="standalone-status error" role="alert">{error}</p>}
        {loading && items.length === 0 && <p role="status">正在搜索词库…</p>}
        {!loading && !error && items.length === 0 && <p>没有匹配的词条。</p>}
        <ul className="vocabulary-list">{items.map((item) => <li key={item.user_word_id}><button type="button" className="vocabulary-list-item" aria-current={selected === item.user_word_id ? "true" : undefined} onClick={() => setSelected(item.user_word_id)}>
          <span className="vocabulary-word-main"><strong>{item.display_word}</strong><small>{item.ipa_us ?? ""}</small></span>
          <span className="vocabulary-word-state"><span>{statusLabel(item.status)}</span>{item.fsrs_reps > 0 && <small>D {item.fsrs_difficulty?.toFixed(1) ?? "—"} · S {item.fsrs_stability?.toFixed(1) ?? "—"} 天</small>}{item.active_error_layers.length > 0 && <small>活动错误 {item.active_error_layers.length}</small>}</span>
        </button></li>)}</ul>
        {loadMoreError && <p className="standalone-status error" role="alert">{loadMoreError}</p>}
        {cursor && <button type="button" className="secondary-button vocabulary-load-more" disabled={loading} onClick={() => void loadMore()}>{loading ? "正在加载…" : "加载更多"}</button>}
      </div>
      {selected && <WordDetailPanel userWordId={selected} tokenKey={tokenKey} onClose={closeDetail} />}
    </div>
  </section>;
}
