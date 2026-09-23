import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement } from "react";
import { Button } from "../web/src/components/Button.js";

const harness = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
  const pending: Array<() => void> = [];
  let cursor = 0;
  let effectCursor = 0;
  let listener: ((event: unknown) => void) | undefined;
  return {
    slots, effects, pending,
    reset() {
      for (const effect of effects) effect.cleanup?.();
      slots.length = 0; effects.length = 0; pending.length = 0;
      cursor = 0; effectCursor = 0; listener = undefined;
    },
    begin() { cursor = 0; effectCursor = 0; },
    useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void] {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index] as T, (value) => {
        slots[index] = typeof value === "function" ? (value as (current: T) => T)(slots[index] as T) : value;
      }];
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useEffect(callback: () => void | (() => void), deps: readonly unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: callback() || undefined };
      });
    },
    flush() { for (const effect of pending.splice(0)) effect(); },
    subscribe(callback: (event: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
    send(value: Record<string, unknown>) { listener?.({ type: "toolresult", value: { structuredContent: value } }); },
    sendToolInput(value: Record<string, unknown>) { listener?.({ type: "toolinput", value }); },
  };
});

vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useState: harness.useState, useRef: harness.useRef, useEffect: harness.useEffect }));
vi.mock("../web/src/mcpBridge.js", () => ({ subscribeToApp: harness.subscribe }));
vi.mock("../web/src/pronunciation/audio.js", () => ({
  loadDictionaryPronunciationAudio: vi.fn(),
  playPronunciation: vi.fn(),
}));

import { DictationWidget } from "../web/src/dictation/DictationWidget.js";
import { loadDictionaryPronunciationAudio, playPronunciation } from "../web/src/pronunciation/audio.js";
import { gradeExactRecall } from "../web/src/grading/deterministic.js";
import { dictationInputSchema } from "../server/tools/renderWidgets.js";

type Node = ReactElement<{ children?: unknown; className?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; onSubmit?: (event: { preventDefault: () => void }) => void; disabled?: boolean; value?: string; type?: string; id?: string }>;
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...nodes(element.props.children)];
}
function visibleText(node: unknown): string {
  if (Array.isArray(node)) return node.map(visibleText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return visibleText((node as Node).props.children);
}
function render(): ReactElement {
  harness.begin();
  const root = DictationWidget();
  harness.flush();
  return root;
}
function button(root: unknown, className?: string): Node {
  const wrapped = nodes(root).find((node) => node.type === Button && (!className || node.props.className?.includes(className)));
  if (!wrapped) throw new Error("Expected Dictation button was not rendered");
  return Button(wrapped.props as ComponentProps<typeof Button>) as Node;
}
function input(root: unknown): Node {
  const found = nodes(root).find((node) => node.type === "input" && node.props.id === "dictation-word-answer");
  if (!found) throw new Error("Word dictation input was not rendered");
  return found;
}
function form(root: unknown): Node {
  const found = nodes(root).find((node) => node.type === "form");
  if (!found) throw new Error("Word dictation form was not rendered");
  return found;
}
function publishWords(words: string[], current_index = 0) {
  harness.send({ widget: "dictation", mode: "words", words, title: "单词听写", current_index });
  return render();
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

afterEach(() => { harness.reset(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("word Dictation mode", () => {
  it("hides target words before submission and preloads the batch with one lookup", async () => {
    const words = ["constrain", "plausible", "subtle", "viable", "coherent"];
    vi.mocked(loadDictionaryPronunciationAudio).mockResolvedValue({ constrain: "https://media.merriam-webster.com/constrain.mp3" });
    render();
    harness.sendToolInput({ mode: "words", words });
    let root = render();
    harness.send({ widget: "dictation", mode: "words", words, title: "单词听写", current_index: 0 });
    root = render();
    expect(visibleText(root)).toContain("1 / 5");
    expect(visibleText(root)).not.toContain("constrain");
    expect(visibleText(root)).not.toContain("meaning");
    expect(visibleText(root)).not.toContain("IPA");
    expect(visibleText(root)).not.toContain("显示原文");
    expect(input(root).props.value).toBe("");
    await settle();
    root = render();
    expect(loadDictionaryPronunciationAudio).toHaveBeenCalledTimes(1);
    expect(loadDictionaryPronunciationAudio).toHaveBeenCalledWith(words);
    button(root, "round-play").props.onClick?.();
    expect(playPronunciation).toHaveBeenCalledWith("constrain", "https://media.merriam-webster.com/constrain.mp3", expect.any(Function), expect.any(Function));
  });

  it("uses the shared player for a missing dictionary URL and advances after deterministic feedback", async () => {
    vi.stubGlobal("window", { speechSynthesis: { getVoices: () => [], cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }, SpeechSynthesisUtterance: class {} });
    vi.mocked(loadDictionaryPronunciationAudio).mockResolvedValue({});
    const words = ["constrain", "plausible", "subtle", "viable", "coherent"];
    render();
    let root = publishWords(words);
    await settle();
    root = render();
    button(root, "round-play").props.onClick?.();
    expect(playPronunciation).toHaveBeenCalledWith("constrain", undefined, expect.any(Function), expect.any(Function));

    expect(gradeExactRecall("constrain", "constrain")).toMatchObject({ is_correct: true, error_layer: "none" });
    expect(gradeExactRecall("constrin", "constrain")).toMatchObject({ is_correct: true, error_layer: "spelling" });
    expect(gradeExactRecall("plausible", "constrain")).toMatchObject({ is_correct: false });

    vi.useFakeTimers();
    input(root).props.onChange?.({ target: { value: "constrin" } });
    root = render();
    form(root).props.onSubmit?.({ preventDefault: () => {} });
    root = render();
    expect(visibleText(root)).toContain("拼写：constrin → constrain");
    expect(visibleText(root)).toContain("1 / 5");
    vi.advanceTimersByTime(1500);
    root = render();
    expect(visibleText(root)).toContain("2 / 5");
    expect(visibleText(root)).not.toContain("plausible");

    for (const target of words.slice(1)) {
      input(root).props.onChange?.({ target: { value: target } });
      root = render();
      form(root).props.onSubmit?.({ preventDefault: () => {} });
      root = render();
      expect(visibleText(root)).toContain("✓ 正确");
      vi.advanceTimersByTime(1500);
      root = render();
    }
    expect(visibleText(root)).toContain("本轮听写完成");
  });

  it("accepts the seven-word limit, rejects larger batches, and keeps legacy text mode playable", () => {
    expect(dictationInputSchema.safeParse({ mode: "words", words: ["one", "two", "three", "four"] }).success).toBe(false);
    expect(dictationInputSchema.safeParse({ mode: "words", words: ["one", "two", "three", "four", "five", "six", "seven"] }).success).toBe(true);
    expect(dictationInputSchema.safeParse({ mode: "words", words: Array.from({ length: 8 }, (_, i) => `word${i}`) }).success).toBe(false);
    expect(dictationInputSchema.safeParse({ text: "A short dictation.", title: "听写" }).success).toBe(true);

    const cancel = vi.fn();
    const speak = vi.fn();
    let spoken = "";
    class Utterance { lang = ""; rate = 0; onstart?: () => void; onend?: () => void; onerror?: () => void; constructor(text: string) { spoken = text; } }
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    vi.stubGlobal("window", { speechSynthesis: { cancel, speak, getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance, configurable: true });
    render();
    harness.send({ widget: "dictation", text: "A short dictation.", title: "旧版听写" });
    let root = render();
    expect(visibleText(root)).toContain("旧版听写");
    expect(visibleText(root)).not.toContain("A short dictation.");
    expect(button(root, "round-play").props.disabled).toBe(false);
    button(root, "round-play").props.onClick?.();
    expect(spoken).toBe("A short dictation.");
    expect(speak).toHaveBeenCalledTimes(1);
    button(root, "transcript-button").props.onClick?.();
    root = render();
    expect(visibleText(root)).toContain("A short dictation.");
  });
});
