import { captureSavedMessage } from "../../../shared/captureContracts.js";
import { useEffect, useRef, useState } from "react";
import { newCaptureIdempotencyKey, type CaptureCreateInput, type CaptureSelectionType, type CaptureSourceType } from "./apiClient.js";

interface CaptureSelection extends CaptureCreateInput {
  left: number;
  top: number;
  selection_signature: string;
}

const sourceTypes = new Set<CaptureSourceType>(["lesson_example", "lesson_prompt", "review_question", "manual"]);
const selectionTypes = new Set<CaptureSelectionType>(["word", "phrase", "collocation", "sentence", "grammar"]);

function elementFor(node: Node | null): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-capture-text='true']") ?? null;
}

function selectionSnapshot(): Omit<CaptureSelection, "left" | "top"> | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const selectedText = selection.toString().trim();
  if (!selectedText || selectedText.length > 500) return null;

  const range = selection.getRangeAt(0);
  const start = elementFor(range.startContainer);
  const end = elementFor(range.endContainer);
  if (!start || start !== end || !start.contains(range.startContainer) || !start.contains(range.endContainer)) return null;
  if (start.closest("button,input,textarea,select,[hidden],[aria-hidden='true'],[data-capture-ignore='true'],[contenteditable]:not([contenteditable='false'])")) return null;
  if (start.getClientRects().length === 0) return null;
  const style = window.getComputedStyle(start);
  if (style.display === "none" || style.visibility === "hidden") return null;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const sourceValue = start.dataset.captureSource as CaptureSourceType | undefined;
  const sourceType = sourceValue && sourceTypes.has(sourceValue) ? sourceValue : "lesson_example";
  const typeValue = start.dataset.captureType as CaptureSelectionType | undefined;
  const selectionType = !/\s/u.test(selectedText)
    ? "word"
    : typeValue && selectionTypes.has(typeValue) ? typeValue : "phrase";
  const contextText = (start.innerText || start.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 1200);

  return {
    selected_text: selectedText,
    selection_type: selectionType,
    context_text: contextText,
    source_type: sourceType,
    source_title: document.title.slice(0, 200),
    source_url: window.location.href,
    idempotency_key: "",
    selection_signature: `${Array.from(document.querySelectorAll<HTMLElement>("[data-capture-text='true']")).indexOf(start)}:${range.startOffset}:${range.endOffset}`,
  };
}

export function CaptureSelectionToolbar({
  enabled,
  onCapture,
}: {
  enabled: boolean;
  onCapture: (input: CaptureCreateInput) => Promise<{ new_occurrence: boolean; occurrence_count: number }>;
}): React.JSX.Element | null {
  const [capture, setCapture] = useState<CaptureSelection | null>(null);
  const captureRef = useRef<CaptureSelection | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!enabled) {
      captureRef.current = null;
      setCapture(null);
      return;
    }
    let timer: number | undefined;
    const update = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = selectionSnapshot();
        if (!next) {
          setCapture(null);
          return;
        }
        const selection = window.getSelection();
        const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
        if (!rect) {
          setCapture(null);
          return;
        }
        const toolbarWidth = 144;
        const left = Math.max(8, Math.min(rect.left + rect.width / 2 - toolbarWidth / 2, window.innerWidth - toolbarWidth - 8));
        const top = rect.bottom + 8 + 48 <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 52);
        const previous = captureRef.current;
        const idempotencyKey = previous
          && previous.selection_signature === next.selection_signature
          && previous.selected_text === next.selected_text
          ? previous.idempotency_key
          : newCaptureIdempotencyKey();
        const snapshot = { ...next, idempotency_key: idempotencyKey, left, top };
        captureRef.current = snapshot;
        setCapture(snapshot);
        setMessage("");
      }, 70);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCapture(null);
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("pointerup", update);
    window.addEventListener("keyup", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("keydown", dismiss);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("pointerup", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("keydown", dismiss);
    };
  }, [enabled]);

  if (!enabled) return null;

  const save = async () => {
    if (!capture || saving) return;
    setSaving(true);
    setMessage("");
    try {
      const result = await onCapture({
        selected_text: capture.selected_text,
        selection_type: capture.selection_type,
        context_text: capture.context_text,
        source_type: capture.source_type,
        source_title: capture.source_title,
        source_url: capture.source_url,
        idempotency_key: capture.idempotency_key,
      });
      window.getSelection()?.removeAllRanges();
      captureRef.current = null;
      setCapture(null);
      setMessage(captureSavedMessage(result));
      window.setTimeout(() => setMessage(""), 2200);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "记录失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return <>
    {capture && <div
      className="capture-selection-toolbar"
      role="toolbar"
      aria-label="记录选中的文本"
      style={{ left: capture.left, top: capture.top }}
      onPointerDown={(event) => event.preventDefault()}
    >
      <span className="capture-selection-preview">{capture.selected_text}</span>
      <button type="button" disabled={saving} onClick={() => void save()} aria-label="记录到 Notes Inbox">
        {saving ? "记录中…" : "记录"}
      </button>
      {message && <span className="capture-selection-error" role="status">{message}</span>}
    </div>}
    {!capture && message && <div className="capture-toast" role="status">{message}</div>}
  </>;
}
