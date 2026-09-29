import { useEffect, useRef, useState } from "react";
import { getVocabularyDetail } from "../apiClient.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.map(object) : []; }
function text(value: unknown, fallback = "—"): string { return typeof value === "string" && value ? value : fallback; }
function num(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? String(value) : "—"; }

export function WordDetailPanel({ userWordId, onClose, tokenKey }: { userWordId: string; onClose: () => void; tokenKey: string | null }): React.JSX.Element {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [updated, setUpdated] = useState("");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeHandlerRef = useRef(onClose);
  closeHandlerRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHandlerRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), audio[controls], [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [userWordId]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setDetail(null);
    setError("");
    void getVocabularyDetail<Record<string, unknown>>(userWordId, controller.signal).then((envelope) => {
      if (!active) return;
      setDetail(envelope.data);
      setUpdated(envelope.as_of);
      setTimeZone(envelope.timezone);
    }).catch(() => { if (active && !controller.signal.aborted) setError("词条详情暂时无法读取。"); });
    return () => { active = false; controller.abort(); };
  }, [userWordId, tokenKey]);

  const word = object(detail);
  const memory = object(word.memory);
  const senses = Array.isArray(word.senses) ? word.senses.map(object) : [];
  const reviews = list(word.recent_formal_reviews);
  const errors = list(word.recent_error_attempts);
  const notes = list(word.captured_notes);
  const occurrences = list(word.capture_occurrences);
  const reasons = Array.isArray(word.focus_reasons) ? word.focus_reasons.map(String) : [];
  const layers = Array.isArray(word.active_error_layers) ? word.active_error_layers.map(String) : [];

  return <section ref={panelRef} className="word-detail-panel" role="dialog" aria-modal="true" aria-labelledby="word-detail-title" tabIndex={-1}>
    <header className="word-detail-header">
      <div><span className="eyebrow">词条详情</span><h2 id="word-detail-title">{text(word.display_word, "正在加载…")}</h2></div>
      <button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭词条详情" onClick={onClose}>×</button>
    </header>
    <div className="word-detail-scroll">
      {error && <p className="standalone-status error" role="alert">{error}</p>}
      {!detail && !error && <p role="status">正在读取词条详情…</p>}
      {detail && <>
        <div className="word-pronunciation-row"><span>美 {text(word.ipa_us)}</span><span>英 {text(word.ipa_uk)}</span>
          {typeof word.audio_url === "string" && word.audio_url
            ? <audio controls preload="none" src={word.audio_url} aria-label={`${text(word.display_word)} 发音`} />
            : <button type="button" className="secondary-button" onClick={() => speak(text(word.display_word, ""))}>朗读</button>}
        </div>
        <section className="word-detail-section"><h3>词义</h3>{senses.length ? <ul>{senses.map((sense, index) => <li key={index}><b>{text(sense.pos, "词性未标注")}</b> · {text(sense.definition_cn, "释义未录入")}</li>)}</ul> : <p>暂无保存的词义。</p>}</section>
        <section className="word-detail-section"><h3>当前记忆</h3><dl className="word-memory-grid">
          <div><dt>难度 D</dt><dd>{num(memory.difficulty)}</dd></div>
          <div><dt>稳定性 S</dt><dd>{typeof memory.stability_days === "number" ? `${memory.stability_days.toFixed(2)} 天` : "—"}</dd></div>
          <div><dt>可回忆率 R</dt><dd>{typeof memory.retrievability === "number" ? `${(memory.retrievability * 100).toFixed(1)}%` : "—"}</dd></div>
          <div><dt>遗忘次数</dt><dd>{num(memory.lapses)}</dd></div>
          <div><dt>下次复习</dt><dd>{text(memory.next_review_at)}</dd></div>
        </dl><p className="muted-copy">R 为 FSRS 模型估计，更新于 {updated ? new Date(updated).toLocaleString("zh-CN", { timeZone }) : "—"}。打开详情不会安排复习。</p></section>
        <section className="word-detail-section"><h3>关注原因</h3><p>{[...reasons, ...layers.map((layer) => `活动错误 · ${layer}`)].join(" · ") || "当前没有活动关注原因。"}</p></section>
        <section className="word-detail-section"><h3>最近 10 次正式 review</h3>{reviews.length ? <ol className="word-history-list">{reviews.map((review, index) => <li key={String(review.id ?? index)}><span>{text(review.reviewed_at)}</span><b>评分 {text(review.rating)}</b><small>复习前计划间隔 {text(review.scheduled_days)} 天</small></li>)}</ol> : <p>暂无正式 review 记录。</p>}</section>
        <section className="word-detail-section"><h3>错误练习</h3>{errors.length ? <ol className="word-history-list">{errors.map((attempt, index) => <li key={String(attempt.id ?? index)}><span>{text(attempt.created_at)}</span><b>{text(attempt.activity_type)} · {text(attempt.error_layer)}</b><p>{text(attempt.user_answer, "未保存作答文本")}</p></li>)}</ol> : <p>暂无错误练习记录。</p>}</section>
        <section className="word-detail-section"><h3>划词笔记与原句</h3>{notes.length ? notes.map((note) => <article className="word-capture-note" key={String(note.id)}><strong>{text(note.selected_text)}</strong><p>{text(note.note, "暂无个人笔记")}</p>{occurrences.filter((occurrence) => occurrence.captured_note_id === note.id).map((occurrence, index) => <blockquote key={index}>{text(occurrence.context_text)}<small>{text(occurrence.source_title)} · {text(occurrence.captured_at)}</small></blockquote>)}</article>) : <p>暂无关联的划词笔记。</p>}</section>
      </>}
    </div>
  </section>;
}

function speak(value: string): void {
  if (typeof window === "undefined" || !value || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = "en-US";
  window.speechSynthesis.speak(utterance);
}
