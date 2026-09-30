import { useEffect, useRef, useState } from "react";
import { createCaptureNote, type CaptureNote, type CaptureSelectionType, type CaptureSourceType } from "./apiClient.js";

interface Candidate {
  selectedText: string;
  contextText: string;
  selectionType: CaptureSelectionType;
  x: number;
  y: number;
}

function clean(value: string, max: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

function inferType(value: string): CaptureSelectionType {
  const text = clean(value, 500);
  const tokens = text ? text.split(" ") : [];
  if (tokens.length <= 1 && !/[.!?。！？;；:]$/u.test(text)) return "word";
  if (tokens.length <= 7 && !/[.!?。！？]$/u.test(text)) return "phrase";
  return "sentence";
}

function asElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function selectionCandidate(): Candidate | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const selectedText = clean(selection.toString(), 500);
  if (!selectedText) return null;

  const range = selection.getRangeAt(0);
  const element = asElement(range.commonAncestorContainer);
  if (!element) return null;
  const root = element.closest('[data-capture-root="true"]');
  if (!root) return null;
  if (element.closest("input, textarea, button, [contenteditable='true']")) return null;

  const rect = range.getBoundingClientRect();
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return null;
  const contextElement = element.closest('[data-capture-context="true"], .lesson-section, .lesson-prompt, .question-block, .standalone-feedback, p, li');
  const contextText = clean(contextElement?.textContent ?? element.textContent ?? "", 4000);

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

  useEffect(() => {
    if (!enabled) {
      setCandidate(null);
      return;
    }
    const refresh = () => {
      window.setTimeout(() => setCandidate(selectionCandidate()), 0);
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

  const capture = async () => {
    if (!candidate || busy) return;
    setBusy(true);
    try {
      const response = await createCaptureNote({
        selected_text: candidate.selectedText,
        context_text: candidate.contextText,
        selection_type: candidate.selectionType,
        source_type: sourceType,
        source_ref: sourceRef ?? null,
      });
      onCaptured?.(response.item);
      setToast(response.item.occurrence_count > 1 ? `已记录 · 第 ${response.item.occurrence_count} 次遇到` : "已记录到划词笔记");
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
      onClick={() => void capture()}
    >
      {busy ? "记录中…" : "记录"}
    </button>}
    {toast && <div className="capture-toast" role="status">{toast}</div>}
  </>;
}
