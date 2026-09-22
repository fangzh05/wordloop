import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playPronunciation, pronunciationButtonLabel } from "../web/src/pronunciation/audio.js";

type SpeechMocks = {
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

class FakeAudio {
  static instances: FakeAudio[] = [];
  onplay: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  preload = "";

  constructor(public readonly src: string) {
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    this.onplay?.();
    return Promise.resolve();
  }
}

class RejectingAudio extends FakeAudio {
  play(): Promise<void> {
    return Promise.reject(new Error("audio blocked"));
  }
}

class ErroringAudio extends FakeAudio {
  play(): Promise<void> {
    queueMicrotask(() => this.onerror?.(new Event("error")));
    return Promise.reject(new Error("audio blocked"));
  }
}

const originalWindow = globalThis.window;
const originalAudio = (globalThis as typeof globalThis & { Audio?: typeof Audio }).Audio;
const originalUtterance = (globalThis as typeof globalThis & {
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
}).SpeechSynthesisUtterance;

function installSpeechMocks(): SpeechMocks {
  const speak = vi.fn();
  const cancel = vi.fn();
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => [{ lang: "en-US" }],
      speak,
      cancel,
    },
    SpeechSynthesisUtterance: class {},
  } as unknown as Window & typeof globalThis;
  const utteranceConstructor = class {
    voice: SpeechSynthesisVoice | null = null;
    lang = "";
    rate = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(public readonly text: string) {}
  };
  globalThis.SpeechSynthesisUtterance = utteranceConstructor as unknown as typeof SpeechSynthesisUtterance;
  (globalThis.window as Window & { SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance = utteranceConstructor as unknown as typeof SpeechSynthesisUtterance;
  return { speak, cancel };
}

function installAudio(audioConstructor: typeof FakeAudio): void {
  globalThis.Audio = audioConstructor as unknown as typeof Audio;
}

beforeEach(() => {
  FakeAudio.instances = [];
});

afterEach(() => {
  if (originalWindow) globalThis.window = originalWindow;
  else Reflect.deleteProperty(globalThis, "window");
  if (originalAudio) globalThis.Audio = originalAudio;
  else Reflect.deleteProperty(globalThis, "Audio");
  if (originalUtterance) globalThis.SpeechSynthesisUtterance = originalUtterance;
  else Reflect.deleteProperty(globalThis, "SpeechSynthesisUtterance");
});

describe("pronunciation playback fallback", () => {
  it("prefers dictionary audio when a URL exists", () => {
    const speech = installSpeechMocks();
    installAudio(FakeAudio);
    const onStart = vi.fn();
    const onEnd = vi.fn();

    playPronunciation("vibrate", "https://media.merriam-webster.com/audio.mp3", onStart, onEnd);

    expect(FakeAudio.instances[0]?.src).toBe("https://media.merriam-webster.com/audio.mp3");
    expect(speech.speak).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("falls back to speech when Audio.play rejects", async () => {
    const speech = installSpeechMocks();
    installAudio(RejectingAudio);

    playPronunciation("vibrate", "https://media.merriam-webster.com/audio.mp3", vi.fn(), vi.fn());
    await Promise.resolve();

    expect(speech.speak).toHaveBeenCalledOnce();
  });

  it("uses speech directly when dictionary audio is missing", () => {
    const speech = installSpeechMocks();
    installAudio(FakeAudio);

    playPronunciation("vibrate", undefined, vi.fn(), vi.fn());

    expect(speech.speak).toHaveBeenCalledOnce();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("starts speech only once when audio error and play rejection both occur", async () => {
    const speech = installSpeechMocks();
    installAudio(ErroringAudio);

    playPronunciation("vibrate", "https://media.merriam-webster.com/audio.mp3", vi.fn(), vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(speech.speak).toHaveBeenCalledOnce();
  });
});

describe("pronunciation source labels", () => {
  it("labels dictionary audio", () => {
    expect(pronunciationButtonLabel(true, true, true, false)).toBe("词典发音");
  });

  it("labels Web Speech fallback", () => {
    expect(pronunciationButtonLabel(false, true, true, false)).toBe("系统发音");
  });

  it("labels lookup pending and unavailable states", () => {
    expect(pronunciationButtonLabel(false, true, false, false)).toBe("正在准备");
    expect(pronunciationButtonLabel(false, false, true, false)).toBe("当前设备无法播放");
  });

  it("uses the same playing label for either source", () => {
    expect(pronunciationButtonLabel(true, false, true, true)).toBe("正在播放");
    expect(pronunciationButtonLabel(false, true, true, true)).toBe("正在播放");
  });
});
