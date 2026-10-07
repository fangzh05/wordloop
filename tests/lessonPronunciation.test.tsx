import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    sendPayload(data: Record<string, unknown>) {
      listener?.({ type: "toolresult", value: { structuredContent: data } });
    },
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
vi.mock("../web/src/mcpBridge.js", () => ({
  subscribeToApp: harness.subscribe,
  callServerTool: vi.fn(),
  sendUserMessage: vi.fn(),
  toolResultData(result: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }) {
    if (result.structuredContent !== undefined) return result.structuredContent;
    for (const block of result.content ?? []) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      try { return JSON.parse(block.text) as unknown; } catch { /* Keep checking later text blocks. */ }
    }
    return undefined;
  },
}));
vi.mock("../web/src/pronunciation/audio.js", () => ({
  loadDictionaryPronunciationAudio: vi.fn(),
  playPronunciation: vi.fn(),
  selectEnglishVoice: vi.fn(() => ({ lang: "en-US" })),
  pronunciationButtonLabel: (dictionary: boolean, speech: boolean, ready: boolean, playing: boolean) =>
    !ready ? "正在准备" : playing && (dictionary || speech) ? "正在播放" : dictionary ? "词典发音" : speech ? "系统发音" : "当前设备无法播放",
}));

import { LessonWidget } from "../web/src/lesson/LessonWidget.js";
import { LessonExercisePrompt } from "../web/src/lesson/LessonExercisePrompt.js";
import { callServerTool, sendUserMessage } from "../web/src/mcpBridge.js";
import { loadDictionaryPronunciationAudio, playPronunciation } from "../web/src/pronunciation/audio.js";

type TestWindow = EventTarget & { __WORDLOOP_PREVIEW__?: Record<string, unknown> };
type TestDocument = EventTarget & { visibilityState: string };

function stubBrowser(preview = false): { documentTarget: TestDocument; windowTarget: TestWindow } {
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const windowTarget = new EventTarget() as TestWindow;
  if (preview) windowTarget.__WORDLOOP_PREVIEW__ = {};
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", windowTarget);
  return { documentTarget, windowTarget };
}

function exercisePayload(word: string, prompt: string) {
  return {
    widget: "lesson",
    widget_version: 3,
    mode: "exercise",
    phase: "lesson_exercise",
    word,
    progress: "1 / 1",
    activity_type: "cloze",
    instruction: "Complete the sentence.",
    prompt,
    multiline: false,
  };
}

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
  const element = node as Node;
  return element.type === LessonExercisePrompt
    ? label(LessonExercisePrompt(element.props as Parameters<typeof LessonExercisePrompt>[0]))
    : label(element.props.children);
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

afterEach(() => {
  harness.reset();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => { vi.mocked(loadDictionaryPronunciationAudio).mockResolvedValue({}); });

describe("Lesson pronunciation", () => {
  it("uses the combined question for a cloze without rendering the target word", () => {
    render();
    harness.sendPayload({ widget: "lesson", mode: "exercise", word: "water", progress: "1 / 1",
      activity_type: "exact_cloze", instruction: "填入正确词形。",
      prompt: "Remember to ___ the plants before leaving.", multiline: false,
      cloze_hint: "n. 水　v. 灌溉" });
    const root = render();
    const question = descendants(root).find((node) => node.type === LessonExercisePrompt);
    if (!question) throw new Error("Lesson question missing");
    const text = renderToStaticMarkup(question);
    expect(text).toContain("Remember to ___ the plants before leaving.");
    expect(text).toContain("n. 水　v. 灌溉");
    expect(text.match(/class="lesson-prompt"/g)).toHaveLength(1);
    expect(text).not.toContain("water");
  });

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

  it("automatically resumes a remounted Lesson through render_lesson_widget without chat messages", async () => {
    vi.useFakeTimers();
    stubBrowser();
    const payload = exercisePayload("resume", "RESUMED EXERCISE");
    vi.mocked(callServerTool).mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(payload) }] });

    expect(label(render())).toContain("正在加载学习内容");
    await vi.advanceTimersByTimeAsync(599);
    expect(callServerTool).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(callServerTool).toHaveBeenCalledTimes(1);
    expect(callServerTool).toHaveBeenCalledWith("render_lesson_widget", { resume: true });
    expect(callServerTool).not.toHaveBeenCalledWith("get_study_bootstrap", expect.anything());
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(label(render())).toContain("RESUMED EXERCISE");
  });

  it("does not resume when the original host payload arrives before the mount timer", async () => {
    vi.useFakeTimers();
    stubBrowser();
    render();
    harness.sendPayload(exercisePayload("host", "ORIGINAL HOST EXERCISE"));
    expect(label(render())).toContain("ORIGINAL HOST EXERCISE");
    await vi.advanceTimersByTimeAsync(600);
    expect(callServerTool).not.toHaveBeenCalled();
  });

  it("recovers after visibility returns and coalesces it with the mount timer", async () => {
    vi.useFakeTimers();
    const { documentTarget } = stubBrowser();
    vi.mocked(callServerTool).mockResolvedValue({ content: [], structuredContent: exercisePayload("visible", "VISIBLE EXERCISE") });
    render();

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    await settle();

    expect(callServerTool).toHaveBeenCalledTimes(1);
    expect(callServerTool).toHaveBeenCalledWith("render_lesson_widget", { resume: true });
    expect(label(render())).toContain("VISIBLE EXERCISE");
  });

  it("preserves the live exercise and typed answer across hidden and visible events", async () => {
    vi.useFakeTimers();
    const { documentTarget } = stubBrowser();
    render();
    harness.sendPayload(exercisePayload("live", "LIVE EXERCISE"));
    let root = render();
    const answerControl = descendants(root).find((node) => node.type === "input" && node.props.className === "answer-input");
    if (!answerControl) throw new Error("Lesson answer input missing");
    (answerControl.props as { onChange?: (event: { target: { value: string } }) => void }).onChange?.({ target: { value: "my answer" } });
    root = render();

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1000);
    root = render();

    const retainedAnswer = descendants(root).find((node) => node.type === "input" && node.props.className === "answer-input");
    expect((retainedAnswer?.props as { value?: string } | undefined)?.value).toBe("my answer");
    expect(label(root)).toContain("LIVE EXERCISE");
    expect(callServerTool).not.toHaveBeenCalled();
  });

  it("uses pageshow as one delayed recovery trigger and lets the host result win a race", async () => {
    vi.useFakeTimers();
    const { documentTarget, windowTarget } = stubBrowser();
    const pending = deferred<Awaited<ReturnType<typeof callServerTool>>>();
    vi.mocked(callServerTool).mockReturnValueOnce(pending.promise);
    render();
    await vi.advanceTimersByTimeAsync(100);
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(callServerTool).toHaveBeenCalledTimes(1);
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(0);

    harness.sendPayload(exercisePayload("host", "HOST RESULT WINS"));
    render();
    pending.resolve({ content: [], structuredContent: exercisePayload("resume", "LATE RESUME MUST NOT REPLACE") });
    await settle();
    const root = render();
    expect(label(root)).toContain("HOST RESULT WINS");
    expect(label(root)).not.toContain("LATE RESUME MUST NOT REPLACE");
    expect(callServerTool).toHaveBeenCalledTimes(1);
  });

  it("shows a load error after resume failure and retries only on a later visible event", async () => {
    vi.useFakeTimers();
    const { documentTarget } = stubBrowser();
    vi.mocked(callServerTool).mockResolvedValue({ content: [], isError: true });
    render();
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(label(render())).toContain("WordLoop 学习卡数据不完整，请重新进入学习。");

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(callServerTool).toHaveBeenCalledTimes(2);
  });

  it("shows the existing load error when a resume result fails Lesson validation", async () => {
    vi.useFakeTimers();
    stubBrowser();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(callServerTool).mockResolvedValue({ content: [], structuredContent: { widget: "lesson", mode: "exercise" } });
    try {
      render();
      await vi.advanceTimersByTimeAsync(600);
      await settle();
      expect(label(render())).toContain("WordLoop 学习卡数据不完整，请重新进入学习。");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not recover in preview and cleans its timer and listeners on unmount", async () => {
    vi.useFakeTimers();
    const { documentTarget, windowTarget } = stubBrowser(true);
    render();
    await vi.advanceTimersByTimeAsync(1000);
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(callServerTool).not.toHaveBeenCalled();

    Object.assign(windowTarget, { __WORDLOOP_PREVIEW__: undefined });
    harness.reset();
    vi.useRealTimers();
    vi.useFakeTimers();
    render();
    expect(vi.getTimerCount()).toBe(1);
    harness.reset();
    expect(vi.getTimerCount()).toBe(0);
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never constructs SpeechSynthesisUtterance inside LessonWidget", () => {
    const source = readFileSync(new URL("../web/src/lesson/LessonWidget.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("new SpeechSynthesisUtterance(");
    expect(source).toContain("playPronunciation(currentWord, dictionaryAudio[currentWord]");
  });
});
