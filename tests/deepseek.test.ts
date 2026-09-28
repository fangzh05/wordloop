import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDeepSeekApiKey: vi.fn((): string | undefined => "test-key") }));
vi.mock("../server/db.js", () => ({ getDeepSeekApiKey: mocks.getDeepSeekApiKey }));

import {
  generateLesson,
  generateWrapup,
  gradeEnglishDefinition,
  gradeSemanticAnswer,
  gradeWrapupAnswer,
  type LessonGeneration,
  validateGeneratedLessonExercise,
} from "../server/services/deepseek.js";
import {
  ENGLISH_DEFINITION_GRADING_PROMPT,
  LESSON_GENERATION_PROMPT,
  SEMANTIC_GRADING_PROMPT,
  WRAPUP_GENERATION_PROMPT,
  WRAPUP_GRADING_PROMPT,
} from "../server/services/deepseekPrompts.js";

const example = "Although the committee postponed its decision, the evidence continued to influence public debate about educational reform.";
const lessonInput = {
  word: "fixture",
  meaning_zh: "设施",
  part_of_speech: "n.",
  lesson_profile: "quick_recall" as const,
  error_focus: null,
};
const validLesson: LessonGeneration = {
  ipa: "/ˈfɪks.tʃər/",
  part_of_speech: "n.（名词）",
  meaning_zh: "固定的事物；设施",
  collocations: ["a permanent fixture（固定设施）"],
  derivations: ["fix（动词：固定）", "fixed（形容词：固定的）"],
  example_en: example,
  example_zh: "尽管委员会推迟了决定，证据仍持续影响有关教育改革的公共讨论。",
  note: "fixture 也可指固定设施。",
  exercise: {
    activity_type: "exact_cloze",
    instruction: "根据语境回忆目标词并填空。",
    prompt: "The city added a ___ near the library entrance for visiting students.",
    accepted_answers: ["fixture"],
    multiline: false,
  },
};
const validWrapup = {
  activity_type: "sentence",
  instruction: "翻译句子并指出主句。",
  prompt: "Although the policy appeared modest, its careful wording encouraged local leaders to invest in public libraries, which gradually widened access to education for families across neighboring districts over several years.",
  multiline: true,
};
const validGrade = {
  is_correct: true,
  error_layer: "none",
  message: "表达准确。",
  explanation: "意思、搭配和语法都符合要求。",
};

function response(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

function waitForAbort(): {
  signal: () => AbortSignal | undefined;
  resolve: (response: Response) => void;
} {
  let requestSignal: AbortSignal | undefined;
  let resolveResponse: ((response: Response) => void) | undefined;
  vi.mocked(fetch).mockImplementationOnce((_input, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    requestSignal = signal;
    resolveResponse = resolve;
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  return {
    signal: () => requestSignal,
    resolve: (value) => resolveResponse?.(value),
  };
}

async function expectTimeout(invoke: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  const waitingRequest = waitForAbort();
  const pending = invoke();
  const rejected = expect(pending).rejects.toMatchObject({ code: "DEEPSEEK_TIMEOUT", status: 504 });
  await vi.advanceTimersByTimeAsync(timeoutMs - 1);
  expect(waitingRequest.signal()?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(waitingRequest.signal()?.aborted).toBe(true);
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

    const result = await generateLesson(lessonInput);
    expect(result).toEqual(validLesson);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown> & { messages: { content: string }[] };
    expect(body).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      max_tokens: 1200,
    });
    expect(body.messages[1]?.content).toContain('"lesson_profile":"quick_recall"');
    expect(body.messages[1]?.content).toContain('"error_focus":null');
    expect(body).not.toHaveProperty("temperature");
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries an invalid JSON body once, then accepts a valid JSON result", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response("not-json"))
      .mockResolvedValueOnce(response(JSON.stringify(validLesson)));
    await expect(generateLesson(lessonInput)).resolves.toMatchObject(validLesson);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the configured per-task token budgets", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(JSON.stringify(validLesson)))
      .mockResolvedValueOnce(response(JSON.stringify(validGrade)))
      .mockResolvedValueOnce(response(JSON.stringify({ is_correct: true, feedback: "释义准确。" })))
      .mockResolvedValueOnce(response(JSON.stringify(validWrapup)))
      .mockResolvedValueOnce(response(JSON.stringify(validGrade)));

    await generateLesson(lessonInput);
    await gradeSemanticAnswer({ word: "fixture", activity_type: "sentence", instruction: "Translate.", prompt: "A prompt.", answer: "my answer", retry_count: 0 });
    await gradeEnglishDefinition({ word: "fixture", meaning_zh: "设施", answer: "something installed" });
    await generateWrapup({ words: ["fixture", "policy"] });
    await gradeWrapupAnswer({ words: ["fixture"], instruction: "Translate.", prompt: validWrapup.prompt, answer: "my answer", retry_count: 0 });

    const tokenBudgets = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).max_tokens);
    expect(tokenBudgets).toEqual([1200, 600, 400, 900, 700]);
  });

  it("includes a concrete JSON object shape in every DeepSeek prompt", () => {
    for (const prompt of [LESSON_GENERATION_PROMPT, SEMANTIC_GRADING_PROMPT, ENGLISH_DEFINITION_GRADING_PROMPT, WRAPUP_GENERATION_PROMPT, WRAPUP_GRADING_PROMPT]) {
      expect(prompt).toContain("{");
    }
    expect(LESSON_GENERATION_PROMPT).toContain("\"ipa\"");
    expect(SEMANTIC_GRADING_PROMPT).toContain("\"is_correct\"");
    expect(ENGLISH_DEFINITION_GRADING_PROMPT).toContain("\"feedback\"");
    expect(WRAPUP_GRADING_PROMPT).toContain("\"reference_answer\"");
    expect(LESSON_GENERATION_PROMPT).toContain("\"exercise\"");
    expect(LESSON_GENERATION_PROMPT).toContain("\"example_zh\"");
    expect(LESSON_GENERATION_PROMPT).toContain("\"accepted_answers\"");
    expect(LESSON_GENERATION_PROMPT).toContain("exact_cloze");
    expect(LESSON_GENERATION_PROMPT).toContain("简体中文");
    expect(WRAPUP_GENERATION_PROMPT).toContain("\"multiline\": true");
  });

  it("retries schema-invalid JSON once, then accepts a valid result", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(JSON.stringify({
      ...validLesson,
      exercise: {
        ...validLesson.exercise,
        activity_type: "exact_cloze",
        prompt: "A team of electricians arrived after the winter storm to restore power.",
      },
      })))
      .mockResolvedValueOnce(response(JSON.stringify(validLesson)));
    await expect(generateLesson(lessonInput)).resolves.toMatchObject(validLesson);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts cosmetic Lesson wording deviations without a fatal schema retry", async () => {
    const fetchMock = vi.mocked(fetch);
    const cosmeticDeviation = {
      ...validLesson,
      part_of_speech: "noun",
      collocations: ["a permanent fixture"],
      derivations: ["fix", "fixed"],
      example_en: "Although the committee postponed its decision, evidence continued to influence public debate about reform.",
      note: "A fixture can be a fixed feature.",
      exercise: { ...validLesson.exercise, instruction: "Translate the sentence." },
    };
    fetchMock.mockResolvedValueOnce(response(JSON.stringify(cosmeticDeviation)));

    await expect(generateLesson(lessonInput))
      .resolves.toMatchObject(cosmeticDeviation);
    expect(fetchMock).toHaveBeenCalledOnce();

    const longerExample = {
      ...validLesson,
      example_en: "Although the committee postponed its decision, evidence influenced public debate about educational reform among students, teachers, parents, and local leaders across districts in the region today.",
    };
    fetchMock.mockResolvedValueOnce(response(JSON.stringify(longerExample)));
    await expect(generateLesson(lessonInput))
      .resolves.toMatchObject(longerExample);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns DEEPSEEK_INVALID_OUTPUT after retrying schema-invalid JSON once and logs safe issue paths", async () => {
    const invalid = {
      ...validLesson,
      example_en: "",
      exercise: { activity_type: "exact_cloze", instruction: "Fill the blank.", prompt: "After the winter storm, workers checked whether every ___ remained secure inside the public hall.", multiline: false },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(JSON.stringify(invalid)))
      .mockResolvedValueOnce(response(JSON.stringify(invalid)));

    await expect(generateLesson(lessonInput))
      .rejects.toMatchObject({ code: "DEEPSEEK_INVALID_OUTPUT", details: { httpStatus: 200, issuePaths: ["example_en", "exercise.accepted_answers"] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(repairRequest.messages[1].content).toContain("上一次 JSON 未通过校验");
    expect(repairRequest.messages[1].content).toContain("- example_en:");
    expect(repairRequest.messages[1].content).toContain("- exercise.accepted_answers:");
    expect(repairRequest.messages[1].content).toContain("返回完整 JSON");
    expect(repairRequest.messages[1].content).not.toContain("ZodError");
    expect(log).toHaveBeenCalledWith("WordLoop DeepSeek request failed", {
      code: "DEEPSEEK_INVALID_OUTPUT", http_status: 200, task: "lesson_generation", issues: ["example_en", "exercise.accepted_answers"],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-key");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-provider-raw");
  });

  it("uses repair feedback and accepts a valid second generation response", async () => {
    const invalid = {
      ...validLesson,
      exercise: { activity_type: "exact_cloze", instruction: "Fill the blank.", prompt: "After the winter storm, workers checked whether every ___ remained secure inside the public hall.", multiline: false },
    };
    const repaired = {
      ...validLesson,
      exercise: {
        activity_type: "exact_cloze",
        instruction: "Fill the blank.",
        prompt: "The city added a ___ near the library entrance for visiting students.",
        accepted_answers: ["fixture"],
        multiline: false,
      },
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(JSON.stringify(invalid)))
      .mockResolvedValueOnce(response(JSON.stringify(repaired)));

    await expect(generateLesson(lessonInput))
      .resolves.toMatchObject(repaired);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(repairRequest.messages[1].content).toContain("exercise.accepted_answers");
    expect(repairRequest.messages[1].content).toContain("返回完整 JSON");
  });

  it("repairs an exact cloze that leaks the target outside its blank", async () => {
    const leaked = {
      ...validLesson,
      exercise: { ...validLesson.exercise, prompt: "The fixture near the library remains ___ for visiting students." },
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(JSON.stringify(leaked)))
      .mockResolvedValueOnce(response(JSON.stringify(validLesson)));

    await expect(generateLesson(lessonInput)).resolves.toMatchObject(validLesson);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(repairRequest.messages[1].content).toContain("exercise.prompt");
  });

  it("rejects target leakage and an exercise that repeats the example sentence", () => {
    const alleviateContext = {
      word: "alleviate",
      lesson_profile: "quick_recall" as const,
      error_focus: null,
    };
    const leaked = validateGeneratedLessonExercise(lessonInput, {
      example_en: example,
      exercise: { ...validLesson.exercise, prompt: "A fixture was placed near the entrance after ___." },
    });
    expect(leaked.map((issue) => issue.path.join("."))).toContain("exercise.prompt");

    const leakedAlleviate = validateGeneratedLessonExercise(alleviateContext, {
      example_en: "The new subsidy may alleviate some of the financial pressure on small firms.",
      exercise: {
        activity_type: "exact_cloze", instruction: "Fill the blank.",
        prompt: "Regular stretching may alleviate the discomfort caused by ___ for long periods.",
        accepted_answers: ["alleviate"], multiline: false,
      },
    });
    expect(leakedAlleviate.some((issue) => issue.path.join(".") === "exercise.prompt" && issue.message.includes("target word"))).toBe(true);

    const repeated = validateGeneratedLessonExercise(lessonInput, {
      example_en: "The museum installed a fixture to display the new map.",
      exercise: { ...validLesson.exercise, prompt: "The museum installed a ___ to display the new map." },
    });
    expect(repeated.some((issue) => issue.path.join(".") === "exercise.prompt" && issue.message.includes("new context"))).toBe(true);
  });

  it("requires one deterministic single-line exact cloze for quick_recall", () => {
    const invalid = validateGeneratedLessonExercise(lessonInput, {
      example_en: example,
      exercise: { ...validLesson.exercise, multiline: true },
    });
    expect(invalid.map((issue) => issue.path.join("."))).toContain("exercise.multiline");
    expect(invalid.some((issue) => issue.path.join(".") === "exercise.activity_type")).toBe(false);

    const hyphenVariantLeak = validateGeneratedLessonExercise({ ...lessonInput, word: "air conditioning" }, {
      example_en: "The old air conditioning system requires regular maintenance.",
      exercise: {
        activity_type: "exact_cloze", instruction: "Fill the blank.",
        prompt: "Air-conditioning keeps the offices comfortable throughout ___.",
        accepted_answers: ["air conditioning"], multiline: false,
      },
    });
    expect(hyphenVariantLeak.some((issue) => issue.message.includes("target word"))).toBe(true);
  });

  it("keeps ordinary Lesson generation closed while allowing a targeted collocation task", () => {
    const collocationExercise = {
      activity_type: "collocation" as const,
      instruction: "回忆目标搭配。",
      prompt: "What phrase means a permanent installation?",
      multiline: false,
    };
    expect(validateGeneratedLessonExercise(lessonInput, { example_en: example, exercise: collocationExercise })
      .some((issue) => issue.path.join(".") === "exercise.activity_type")).toBe(true);

    expect(validateGeneratedLessonExercise({
      ...lessonInput,
      lesson_profile: "targeted_relearn",
      error_focus: "collocation",
    }, { example_en: example, exercise: collocationExercise })).toEqual([]);

    const sentence = validateGeneratedLessonExercise(lessonInput, {
      example_en: example,
      exercise: { ...collocationExercise, activity_type: "sentence", prompt: "Write a sentence about fixtures." },
    });
    expect(sentence.some((issue) => issue.path.join(".") === "exercise.activity_type")).toBe(true);
  });

  it("does not log the user answer or raw provider content for grading errors", async () => {
    const privateAnswer = "PRIVATE_USER_ANSWER";
    const privateProviderText = "PRIVATE_PROVIDER_TEXT";
    const invalid = { ...validGrade, message: "", explanation: `批改说明：${privateProviderText}` };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(JSON.stringify(invalid)))
      .mockResolvedValueOnce(response(JSON.stringify(invalid)));

    await expect(gradeSemanticAnswer({
      word: "fixture", activity_type: "sentence", instruction: "Translate.", prompt: "A prompt.", answer: privateAnswer, retry_count: 0,
    })).rejects.toMatchObject({ code: "DEEPSEEK_INVALID_OUTPUT", details: { issuePaths: ["message"] } });

    const logs = JSON.stringify(log.mock.calls);
    expect(log).toHaveBeenCalledWith("WordLoop DeepSeek request failed", {
      code: "DEEPSEEK_INVALID_OUTPUT", http_status: 200, task: "semantic_lesson_grading", issues: ["message"],
    });
    expect(logs).not.toContain(privateAnswer);
    expect(logs).not.toContain(privateProviderText);
    expect(logs).not.toContain("test-key");
  });

  it("does not abort lesson generation at the old 12 second limit", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    const waitingRequest = waitForAbort();
    const pending = generateLesson(lessonInput);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(waitingRequest.signal()?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    waitingRequest.resolve(response(JSON.stringify(validLesson)));
    await expect(pending).resolves.toMatchObject(validLesson);
  });

  it("returns DEEPSEEK_TIMEOUT only at the lesson generation 30 second deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expectTimeout(() => generateLesson(lessonInput), 30_000);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("uses the semantic grading 20 second timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expectTimeout(() => gradeSemanticAnswer({ word: "fixture", activity_type: "sentence", instruction: "Translate.", prompt: "A prompt.", answer: "a private answer", retry_count: 0 }), 20_000);
  });

  it("uses the wrap-up generation, wrap-up grading, and English definition deadlines", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expectTimeout(() => generateWrapup({ words: ["fixture", "policy"] }), 30_000);
    vi.mocked(fetch).mockClear();
    await expectTimeout(() => gradeWrapupAnswer({ words: ["fixture"], instruction: "Translate.", prompt: validWrapup.prompt, answer: "a private answer", retry_count: 0 }), 20_000);
    vi.mocked(fetch).mockClear();
    await expectTimeout(() => gradeEnglishDefinition({ word: "fixture", meaning_zh: "设施", answer: "a private answer" }), 15_000);
  });

  it.each([429, 500, 502, 503, 504])("retries transient HTTP %i once after a short delay", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status }))
      .mockResolvedValueOnce(response(JSON.stringify(validLesson)));
    const pending = generateLesson(lessonInput);

    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject(validLesson);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403])("does not retry non-transient HTTP %i", async (status) => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status }));
    await expect(generateLesson(lessonInput))
      .rejects.toMatchObject({ code: "DEEPSEEK_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry ordinary network failures", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(generateLesson(lessonInput))
      .rejects.toMatchObject({ code: "DEEPSEEK_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not make an LLM request when the server key is missing", async () => {
    mocks.getDeepSeekApiKey.mockReturnValue(undefined);
    const fetchMock = vi.mocked(fetch);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(generateLesson(lessonInput))
      .rejects.toMatchObject({ code: "DEEPSEEK_NOT_CONFIGURED", status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
