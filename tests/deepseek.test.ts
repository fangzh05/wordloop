import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDeepSeekApiKey: vi.fn((): string | undefined => "test-key") }));
vi.mock("../server/db.js", () => ({ getDeepSeekApiKey: mocks.getDeepSeekApiKey }));

import { generateLesson } from "../server/services/deepseek.js";

const example = "Although the committee postponed its decision, the evidence continued to influence public debate about educational reform.";
const validLesson = {
  ipa: "/ˈfɪks.tʃər/",
  part_of_speech: "n.",
  meaning_zh: "固定的事物；设施",
  collocations: ["a permanent fixture"],
  derivations: ["fix v.", "fixed adj."],
  example_en: example,
  note: "fixture 也可指固定设施。",
  exercise: {
    activity_type: "translation_cn_to_en",
    instruction: "使用目标词翻译句子。",
    prompt: "尽管预算有限，学校仍然决定改善图书馆设施。",
    multiline: false,
  },
};

function response(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe("DeepSeek stateless JSON client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mocks.getDeepSeekApiKey.mockReturnValue("test-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses DeepSeek Flash with thinking disabled and strips state-like output fields", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response(JSON.stringify({
      ...validLesson,
      current_index: 99,
      next_word: "untrusted",
      navigation: { action: "next_word", next_word: "untrusted", next_index: 100 },
    })));

    const result = await generateLesson({ word: "fixture", meaning_zh: "设施", part_of_speech: "n." });
    expect(result).toEqual(validLesson);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 600,
    });
    expect(body).not.toHaveProperty("temperature");
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries an invalid JSON body once, then accepts a valid JSON result", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response("not-json"))
      .mockResolvedValueOnce(response(JSON.stringify(validLesson)));
    await expect(generateLesson({ word: "fixture", meaning_zh: "设施", part_of_speech: "n." })).resolves.toMatchObject(validLesson);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an example copied into the exercise context", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response(JSON.stringify({
      ...validLesson,
      exercise: {
        ...validLesson.exercise,
        activity_type: "sentence",
        prompt: example,
      },
    })));
    await expect(generateLesson({ word: "fixture", meaning_zh: "设施", part_of_speech: "n." }))
      .rejects.toMatchObject({ code: "DEEPSEEK_INVALID_OUTPUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the 12 second hard timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = generateLesson({ word: "fixture", meaning_zh: "设施", part_of_speech: "n." });
    const rejected = expect(pending).rejects.toMatchObject({ code: "DEEPSEEK_TIMEOUT", status: 504 });
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry ordinary network failures", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(generateLesson({ word: "fixture", meaning_zh: "设施", part_of_speech: "n." }))
      .rejects.toMatchObject({ code: "DEEPSEEK_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not make an LLM request when the server key is missing", async () => {
    mocks.getDeepSeekApiKey.mockReturnValue(undefined);
    const fetchMock = vi.mocked(fetch);
    await expect(generateLesson({ word: "fixture", meaning_zh: "设施", part_of_speech: "n." }))
      .rejects.toMatchObject({ code: "DEEPSEEK_NOT_CONFIGURED", status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
