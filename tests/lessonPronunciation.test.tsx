import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const harness = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effectCursor = 0;
  const pending: Array<() => void> = [];
  let listener: ((event: unknown) => void) | undefined;
  return {
    slots, effects, pending,
    reset() {
      for (const effect of effects) effect.cleanup?.();
      slots.length = 0; effects.length = 0; pending.length = 0;
      cursor = 0; effectCursor = 0; listener = undefined;
    },
    begin() { cursor = 0; effectCursor = 0; },
    useState<T>(initial: T): [T, (value: T) => void] {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index] as T, (value) => { slots[index] = value; }];
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
    send(word: string, mode: "explain" | "exercise" = "explain") {
      const base = { widget: "lesson", word };
      const data = mode === "explain"
        ? { ...base, mode, ipa: "/a/", part_of_speech: "v.", meaning_zh: "振动", collocations: [], derivations: [], example_en: "It vibrates.", note: "Example note", exercise: { activity_type: "listening", instruction: "Listen", prompt: "Listen", multiline: false } }
        : { ...base, mode, progress: "1/1", activity_type: "listening", instruction: "Listen", prompt: "Listen", multiline: false };
      listener?.({ type: "toolresult", value: { structuredContent: data } });
    },
  };
});

vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useState: harness.useState, useRef: harness.useRef, useEffect: harness.useEffect }));
vi.mock("../web/src/mcpBridge.js", () => ({ subscribeToApp: harness.subscribe, callServerTool: vi.fn(), sendUserMessage: vi.fn() }));
vi.mock("../web/src/pronunciation/audio.js", () => ({
  loadDictionaryPronunciationAudio: vi.fn(),
  playPronunciation: vi.fn(),
  selectEnglishVoice: vi.fn(() => ({ lang: "en-US" })),
  pronunciationButtonLabel: (dictionary: boolean, speech: boolean, ready: boolean, playing: boolean) =>
    !ready ? "正在准备" : playing && (dictionary || speech) ? "正在播放" : dictionary ? "词典发音" : speech ? "系统发音" : "当前设备无法播放",
}));

import { LessonWidget } from "../web/src/lesson/LessonWidget.js";
import { loadDictionaryPronunciationAudio, playPronunciation } from "../web/src/pronunciation/audio.js";

type Node = ReactElement<{ children?: unknown; className?: string; onClick?: () => void; disabled?: boolean }>;
function descendants(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Node;
  return [element, ...descendants(element.props.children)];
}
function label(node: unknown): string {
  if (Array.isArray(node)) return node.map(label).join("");
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return label((node as Node).props.children);
}
function render() {
  harness.begin();
  const root = LessonWidget();
  harness.flush();
  return root;
}
function button(root: unknown) {
  const found = descendants(root).find((node) => node.type === "button" && node.props.className === "play-button lesson-audio");
  if (!found) throw new Error("Lesson playback button missing");
  return found;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

afterEach(() => { harness.reset(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Lesson pronunciation", () => {
  it("preloads dictionary audio and uses the shared player in explain and listening", async () => {
    const audio = "https://media.merriam-webster.com/audio/prons/en/us/mp3/v/vibrate001.mp3";
    vi.mocked(loadDictionaryPronunciationAudio).mockResolvedValue({ vibrate: audio });
    render();
    harness.send("vibrate");
    render();
    let root = render();
    expect(label(button(root))).toContain("正在准备");
    expect(button(root).props.disabled).toBe(true);
    await settle();
    root = render();
    expect(label(button(root))).toContain("词典发音");
    expect(label(root)).toContain("Merriam-Webster's Learner's Dictionary");
    button(root).props.onClick?.();
    expect(playPronunciation).toHaveBeenCalledWith("vibrate", audio, expect.any(Function), expect.any(Function));
    vi.mocked(playPronunciation).mock.calls.at(-1)?.[2]();
    expect(label(button(render()))).toContain("正在播放");
    vi.mocked(playPronunciation).mock.calls.at(-1)?.[3]();
    harness.send("vibrate", "exercise");
    root = render();
    expect(label(button(root))).toContain("词典发音");
    button(root).props.onClick?.();
    expect(playPronunciation).toHaveBeenLastCalledWith("vibrate", audio, expect.any(Function), expect.any(Function));
    expect(loadDictionaryPronunciationAudio).toHaveBeenCalledTimes(1);
  });

  it("shows system playback without dictionary attribution when lookup misses", async () => {
    vi.stubGlobal("window", { speechSynthesis: { getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {} }, SpeechSynthesisUtterance: class {} });
    vi.mocked(loadDictionaryPronunciationAudio).mockResolvedValue({});
    render(); harness.send("vibrate"); render(); await settle();
    const root = render();
    expect(label(button(root))).toContain("系统发音");
    expect(label(root)).not.toContain("Merriam-Webster's Learner's Dictionary");
    button(root).props.onClick?.();
    expect(playPronunciation).toHaveBeenCalledWith("vibrate", undefined, expect.any(Function), expect.any(Function));
  });

  it("ignores an old lookup after the next word resolves", async () => {
    const first = deferred<Record<string, string>>();
    const second = deferred<Record<string, string>>();
    vi.mocked(loadDictionaryPronunciationAudio).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(); harness.send("apple"); render();
    harness.send("vibrate"); render();
    second.resolve({ vibrate: "https://media.merriam-webster.com/vibrate.mp3" });
    await settle();
    expect(label(button(render()))).toContain("词典发音");
    first.resolve({ apple: "https://media.merriam-webster.com/apple.mp3" });
    await settle();
    const root = render();
    expect(label(button(root))).toContain("词典发音");
    button(root).props.onClick?.();
    expect(playPronunciation).toHaveBeenLastCalledWith("vibrate", "https://media.merriam-webster.com/vibrate.mp3", expect.any(Function), expect.any(Function));
  });

  it("never constructs SpeechSynthesisUtterance inside LessonWidget", () => {
    const source = readFileSync(new URL("../web/src/lesson/LessonWidget.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("new SpeechSynthesisUtterance(");
    expect(source).toContain("playPronunciation(currentWord, dictionaryAudio[currentWord]");
  });
});
