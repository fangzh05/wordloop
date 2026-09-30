import { useEffect, useRef, useState } from "react";
import { createCaptureNote, type CaptureNote, type CaptureSelectionType, type CaptureSourceType } from "./apiClient.js";

type Candidate = { text: string; context: string; element: HTMLElement; type: CaptureSelectionType };
const eventName = "wordloop:inline-capture";
const clean = (text: string) => text.replace(/\s+/gu, " ").trim();
export function inferCaptureType(text: string): CaptureSelectionType {
  const count = text.split(/\s+/u).length;
  return count <= 1 && !/[.!?。！？;；:]$/u.test(text) ? "word" : count <= 7 && !/[.!?。！？]$/u.test(text) ? "phrase" : "sentence";
}
function elementFor(node: Node | null): HTMLElement | null {
  return node instanceof HTMLElement ? node : node?.parentElement ?? null;
}
function selectedCandidate(): Candidate | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const start = elementFor(range.startContainer)?.closest<HTMLElement>("[data-inline-capture-text]");
  const end = elementFor(range.endContainer)?.closest<HTMLElement>("[data-inline-capture-text]");
  if (!start || start !== end || !start.getClientRects().length) return null;
  if (start.closest("input,textarea,button,[hidden],[contenteditable='true']")) return null;
  const text = clean(selection.toString());
  if (!text) return null;
  return { text, context: clean(start.textContent ?? "").slice(0, 1200), element: start, type: inferCaptureType(text) };
}
/** Always in document flow, outside selectable text. Never placed at selection coordinates. */
export function InlineCaptureButton(): React.JSX.Element {
  return <button type="button" className="inline-capture-button" aria-label="记录选中文字或整句"
    onPointerDown={(event) => event.preventDefault()}
    onClick={(event) => { const element = event.currentTarget.parentElement?.querySelector<HTMLElement>("[data-inline-capture-text]"); if (element) window.dispatchEvent(new CustomEvent(eventName, { detail: element })); }}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/><path d="M9 7h6M9 10h6"/></svg>记录
  </button>;
}
export function SelectionCapture({ enabled, sourceType, sourceRef, onCaptured }: {
  enabled: boolean; sourceType: CaptureSourceType; sourceRef?: string | null; onCaptured?: (note: CaptureNote) => void;
}): React.JSX.Element | null {
  const [toast, setToast] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const last = useRef<Candidate | null>(null);
  const pending = useRef<{ candidate: Candidate; key: string; fingerprint: string } | null>(null);
  const lock = useRef(false);
  const timer = useRef<number | null>(null);
  const handler = useRef<(element: HTMLElement) => void>(() => undefined);
  const retry = useRef<() => void>(() => undefined);
  const announce = (message: string, error = false) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast(message); setFailed(error);
    if (!error) timer.current = window.setTimeout(() => setToast(""), 2400);
  };
  const save = async (candidate: Candidate) => {
    if (lock.current) return;
    if (!candidate.text || candidate.text.length > 500) { pending.current = null; announce("最多记录 500 字，请先缩小选区。", true); return; }
    const fingerprint = JSON.stringify([candidate.text, candidate.context, sourceType, sourceRef]);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { candidate, key: crypto.randomUUID(), fingerprint };
    const request = pending.current;
    lock.current = true; setBusy(true); announce("记录中…");
    // Snapshot first, then dismiss native selection UI; never intercept copy/paste/contextmenu.
    window.getSelection()?.removeAllRanges();
    try {
      const response = await createCaptureNote({ selected_text: candidate.text, context_text: candidate.context,
        selection_type: candidate.type, source_type: sourceType, source_ref: sourceRef ?? null, idempotency_key: request.key });
      onCaptured?.(response.item); last.current = null; pending.current = null;
      announce(response.item.occurrence_count > 1 ? `已记录 · 第 ${response.item.occurrence_count} 次遇到` : "已记录到划词笔记");
    } catch { announce("记录失败，已保留选中文字。", true); }
    finally { lock.current = false; setBusy(false); }
  };
  handler.current = (element) => {
    const current = selectedCandidate();
    const cached = last.current?.element === element && element.isConnected ? last.current : null;
    const text = clean(element.textContent ?? "");
    const candidate = current?.element === element ? current : cached ?? { text, context: text.slice(0, 1200), element, type: inferCaptureType(text) };
    void save(candidate);
  };
  retry.current = () => { if (pending.current) void save(pending.current.candidate); };
  useEffect(() => {
    last.current = null; pending.current = null; setToast(""); setFailed(false);
    if (!enabled) return;
    const selectionChange = () => { const next = selectedCandidate(); if (next) last.current = next; else if (window.getSelection()?.isCollapsed === false) last.current = null; };
    const reset = (event: PointerEvent) => {
      const element = elementFor(event.target as Node);
      if (element?.closest(".inline-capture-button,.inline-capture-status")) return;
      last.current = null;
    };
    const capture = (event: Event) => {
      const element = (event as CustomEvent<HTMLElement>).detail;
      if (element instanceof HTMLElement && element.matches("[data-inline-capture-text]") && element.isConnected) handler.current(element);
    };
    document.addEventListener("selectionchange", selectionChange);
    document.addEventListener("pointerdown", reset);
    window.addEventListener(eventName, capture);
    return () => { document.removeEventListener("selectionchange", selectionChange); document.removeEventListener("pointerdown", reset); window.removeEventListener(eventName, capture); if (timer.current !== null) window.clearTimeout(timer.current); };
  }, [enabled, sourceType, sourceRef]);
  if (!enabled || !toast) return null;
  return <div className="inline-capture-status" role={failed ? "alert" : "status"}><span>{toast}</span>{failed && pending.current && <button type="button" disabled={busy} onClick={() => retry.current()}>重试</button>}<button type="button" aria-label="关闭记录提示" onClick={() => setToast("")}>×</button></div>;
}
