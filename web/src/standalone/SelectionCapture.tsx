import { useEffect, useRef, useState } from "react";
import { createCaptureNote, type CaptureNote, type CaptureSelectionType, type CaptureSourceType } from "./apiClient.js";

interface Candidate {
  selectedText: string;
  contextText: string;
  selectionType: CaptureSelectionType;
  x: number;
  y: number;
}

interface PendingCaptureKey {
  fingerprint: string;
  idempotencyKey: string;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function inferType(value: string): CaptureSelectionType {
  const text = normalize(value);
  const tokens = text ? text.split(" ") : [];
  if (tokens.length <= 1 && !/[.!?。！？;；:]$/u.test(text)) return "word";
  if (tokens.length <= 7 && !/[.!?。！？]$/u.test(text)) return "phrase";
  return "sentence";
}

function asElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function selectionCandidate(): Candidate | "too-long" | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const selectedText = normalize(selection.toString());
  if (!selectedText) return null;

  const range = selection.getRangeAt(0);
  const startElement = asElement(range.startContainer);
  const endElement = asElement(range.endContainer);
  const startRoot = startElement?.closest('[data-capture-root="true"]') ?? null;
  const endRoot = endElement?.closest('[data-capture-root="true"]') ?? null;
  if (!startRoot || startRoot !== endRoot) return null;
  const element = asElement(range.commonAncestorContainer);
  if (!element) return null;
  if (startElement?.closest("input, textarea, button, [contenteditable='true']")
    || endElement?.closest("input, textarea, button, [contenteditable='true']")) return null;
  try {
    for (const interactive of Array.from(startRoot.querySelectorAll("input, textarea, button, [contenteditable='true']"))) {
      if (range.intersectsNode(interactive)) return null;
    }
  } catch { return null; }
  if (selectedText.length > 500) return "too-long";

  const rect = range.getBoundingClientRect();
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return null;
  const contextElement = element.closest('[data-capture-context="true"], .lesson-section, .lesson-prompt, .question-block, .standalone-feedback, p, li');
  const contextText = normalize(contextElement?.textContent ?? element.textContent ?? "").slice(0, 1200);

  return {
    selectedText,
    contextText,
    selectionType: inferType(selectedText),
    x: Math.min(Math.max(rect.left + rect.width / 2, 72), window.innerWidth - 72),
    y: Math.min(Math.max(rect.bottom + 10, 56), window.innerHeight - 56),
  };
}

export function SelectionCapture({ enabled, sourceType, sourceRef, onCaptured }: {
  enabled: boolean;
  sourceType: CaptureSourceType;
  sourceRef?: string | null;
  onCaptured?: (note: CaptureNote) => void;
}): React.JSX.Element | null {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);
  const pendingKey = useRef<PendingCaptureKey | null>(null);

  const captureKeyFor = (value: Candidate): string => {
    const fingerprint = JSON.stringify([value.selectedText, value.contextText, sourceType, sourceRef ?? null]);
    if (pendingKey.current?.fingerprint === fingerprint) return pendingKey.current.idempotencyKey;
    const idempotencyKey = crypto.randomUUID();
    pendingKey.current = { fingerprint, idempotencyKey };
    return idempotencyKey;
  };

  useEffect(() => {
    if (!enabled) {
      setCandidate(null);
      pendingKey.current = null;
      return;
    }
    const refresh = () => {
      window.setTimeout(() => {
        const next = selectionCandidate();
        if (next === "too-long") {
          setCandidate(null);
          pendingKey.current = null;
          setToast("选中文本超过 500 字，请缩小选区");
          if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
          toastTimer.current = window.setTimeout(() => setToast(""), 2200);
          return;
        }
        if (!next) pendingKey.current = null;
        setCandidate(next);
      }, 0);
    };
    document.addEventListener("selectionchange", refresh);
    document.addEventListener("pointerup", refresh);
    document.addEventListener("keyup", refresh);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      document.removeEventListener("pointerup", refresh);
      document.removeEventListener("keyup", refresh);
    };
  }, [enabled]);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const capture = async (requested: Candidate | "too-long" | null = candidate) => {
    if (requested === "too-long") {
      setToast("选中文本超过 500 字，请缩小选区");
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(""), 2200);
      return;
    }
    if (!requested) {
      setToast("请先选择讲解、例句或反馈中的文字");
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(""), 2200);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const response = await createCaptureNote({
        selected_text: requested.selectedText,
        context_text: requested.contextText,
        selection_type: requested.selectionType,
        source_type: sourceType,
        source_ref: sourceRef ?? null,
        idempotency_key: captureKeyFor(requested),
      });
      onCaptured?.(response.item);
      setToast(response.item.occurrence_count > 1 ? `已记录 · 第 ${response.item.occurrence_count} 次遇到` : "已记录到划词笔记");
      pendingKey.current = null;
      setCandidate(null);
      window.getSelection()?.removeAllRanges();
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(""), 1800);
    } catch {
      setToast("记录失败，请重试");
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(""), 2200);
    } finally {
      setBusy(false);
    }
  };

  if (!enabled && !toast) return null;
  return <>
    {candidate && <button
      type="button"
      className="capture-selection-action"
      style={{ left: candidate.x, top: candidate.y }}
      disabled={busy}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => void capture(candidate)}
    >
      {busy ? "记录中…" : "记录"}
    </button>}
    {toast && <div className="capture-toast" role="status">{toast}</div>}
  </>;
}
