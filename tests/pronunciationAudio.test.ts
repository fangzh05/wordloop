import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabaseForTests } from "../server/db.js";
import {
  buildMerriamWebsterAudioUrl,
  getPronunciationAudio,
  resetPronunciationAudioStateForTests,
} from "../server/tools/getPronunciationAudio.js";

const originalApiKey = process.env.MERRIAM_WEBSTER_API_KEY;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function exactEntry(audio = "vibrate01"): object {
  return {
    meta: { id: "vibrate" },
    hwi: { prs: [{ sound: { audio } }] },
  };
}

beforeEach(() => {
  resetDatabaseForTests();
  resetPronunciationAudioStateForTests();
  delete process.env.MERRIAM_WEBSTER_API_KEY;
});

afterEach(() => {
  resetDatabaseForTests();
  resetPronunciationAudioStateForTests();
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.MERRIAM_WEBSTER_API_KEY;
  else process.env.MERRIAM_WEBSTER_API_KEY = originalApiKey;
});

describe("Merriam-Webster pronunciation audio URL", () => {
  it("uses the documented standard directory rule", () => {
    expect(buildMerriamWebsterAudioUrl("vibrate01")).toBe(
      "https://media.merriam-webster.com/audio/prons/en/us/mp3/v/vibrate01.mp3",
    );
  });

  it("handles documented special directories", () => {
    expect(buildMerriamWebsterAudioUrl("bixfoo")).toContain("/bix/bixfoo.mp3");
    expect(buildMerriamWebsterAudioUrl("ggbar")).toContain("/gg/ggbar.mp3");
    expect(buildMerriamWebsterAudioUrl("3d000001")).toContain("/number/3d000001.mp3");
  });
});

describe("Merriam-Webster pronunciation lookup", () => {
  it("fails soft without an API key and does not fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPronunciationAudio(["vibrate"]);

    expect(result).toEqual({
      provider: "speech-synthesis",
      available: false,
      words: [{ word: "vibrate", audio_url: null }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the audio URL from an exact entry", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([exactEntry()]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPronunciationAudio(["Vibrate"]);

    expect(result.provider).toBe("merriam-webster-learners");
    expect(result.available).toBe(true);
    expect(result.words).toEqual([{
      word: "Vibrate",
      audio_url: "https://media.merriam-webster.com/audio/prons/en/us/mp3/v/vibrate01.mp3",
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat suggestion strings as dictionary entries", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(["vibration", "vibrated"]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPronunciationAudio(["vibrate"]);

    expect(result.available).toBe(false);
    expect(result.words[0]?.audio_url).toBeNull();
  });

  it("does not use the first object when no exact entry exists", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([{
      meta: { id: "vibration" },
      hwi: { prs: [{ sound: { audio: "vibration01" } }] },
    }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPronunciationAudio(["vibrate"]);

    expect(result.words[0]?.audio_url).toBeNull();
  });

  it("returns null when the exact entry has no sound", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([{ meta: { id: "vibrate" }, hwi: { prs: [] } }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPronunciationAudio(["vibrate"]);

    expect(result.words[0]?.audio_url).toBeNull();
  });

  it.each([500, 429])("fails soft for HTTP %s", async (status) => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({}, status));
    vi.stubGlobal("fetch", fetchMock);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await getPronunciationAudio(["vibrate"]);

    expect(result.available).toBe(false);
    expect(result.words[0]?.audio_url).toBeNull();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("does not cache network failures and retries the next request", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockImplementationOnce(async () => jsonResponse([exactEntry()]));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = await getPronunciationAudio(["vibrate"]);
    const second = await getPronunciationAudio(["vibrate"]);

    expect(first.words[0]?.audio_url).toBeNull();
    expect(second.words[0]?.audio_url).toContain("/v/vibrate01.mp3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a cached result for normalized words", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([exactEntry()]));
    vi.stubGlobal("fetch", fetchMock);

    await getPronunciationAudio(["Vibrate"]);
    const result = await getPronunciationAudio([" vibrate "]);

    expect(result.words[0]?.audio_url).toContain("/v/vibrate01.mp3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent lookups with one in-flight promise", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn().mockReturnValue(pendingResponse);
    vi.stubGlobal("fetch", fetchMock);

    const first = getPronunciationAudio(["vibrate"]);
    const second = getPronunciationAudio(["VIBRATE"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse(jsonResponse([exactEntry()]));
    const results = await Promise.all([first, second]);
    expect(results[0]?.words[0]?.audio_url).toContain("/v/vibrate01.mp3");
    expect(results[1]?.words[0]?.audio_url).toContain("/v/vibrate01.mp3");
  });

  it("deduplicates normalized duplicates in one batch", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([exactEntry()]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPronunciationAudio(["Vibrate", "vibrate", " vibrate "]);

    expect(result.words).toHaveLength(1);
    expect(result.words[0]?.word).toBe("Vibrate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops new uncached lookups at the quota circuit limit while keeping cache hits", async () => {
    process.env.MERRIAM_WEBSTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const words = Array.from({ length: 61 }, (_, index) => `word-${index}`);
    const result = await getPronunciationAudio(words);

    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(result.words).toHaveLength(61);
    expect(result.words[60]?.audio_url).toBeNull();

    await getPronunciationAudio(["WORD-0"]);
    expect(fetchMock).toHaveBeenCalledTimes(60);
  });
});
