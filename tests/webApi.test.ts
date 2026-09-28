import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: null as any,
  revisionNumber: 0,
  advanceEvents: [] as string[],
  token: "web-test-token" as string | undefined,
  bootstrap: vi.fn(),
  getProgress: vi.fn(),
  getPretestResults: vi.fn(),
  getTodayWords: vi.fn(),
  getVocabularyItemsByWords: vi.fn(),
  recordPretestResult: vi.fn(),
  getPronunciationAudio: vi.fn(),
  buildReviewWidgetPayload: vi.fn(),
  recordAttempt: vi.fn(),
  getTodayCompletedLessonWords: vi.fn(async () => new Set<string>()),
  recordReviewSubmission: vi.fn(),
  finishStudySession: vi.fn(),
  generateLesson: vi.fn(),
  generateWrapup: vi.fn(),
  gradeEnglishDefinition: vi.fn(),
  gradeSemanticAnswer: vi.fn(),
  gradeWrapupAnswer: vi.fn(),
  getDatabase: vi.fn(() => ({})),
  getAuthenticatedUserId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
}));

vi.mock("../server/db.js", async () => {
  const actual = await vi.importActual<typeof import("../server/db.js")>("../server/db.js");
  return {
    ...actual,
    getDatabase: mocks.getDatabase,
    getAuthenticatedUserId: mocks.getAuthenticatedUserId,
    getWordloopWebToken: () => mocks.token,
  };
});

vi.mock("../server/services/studyBootstrap.js", () => ({ getStudyBootstrap: mocks.bootstrap }));
vi.mock("../server/services/progress.js", () => ({ getProgress: mocks.getProgress }));
vi.mock("../server/services/studySessions.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/studySessions.js")>("../server/services/studySessions.js");
  const persist = async (state: any, expectedRevision: string | null, _db?: unknown, _userId?: string, expectedSessionId?: string) => {
    const active = mocks.active;
    if ((active?.updated_at ?? null) !== expectedRevision || (expectedSessionId && active?.id !== expectedSessionId)) {
      throw new actual.StaleStudyStateError();
    }
    const updated = {
      ...(active ?? { id: "00000000-0000-4000-8000-000000000002", user_id: "00000000-0000-0000-0000-000000000001", started_at: "2026-09-27T00:00:00.000Z", ended_at: null, new_words_count: 0, review_words_count: 0 }),
      state,
      updated_at: `rev-${++mocks.revisionNumber}`,
    };
    mocks.active = updated;
    return updated;
  };
  return {
    ...actual,
    getActiveStudySession: vi.fn(async () => mocks.active),
    assertActiveStudySessionRevision: vi.fn(async (expectedRevision: string | null, expectedSessionId?: string) => {
      if ((mocks.active?.updated_at ?? null) !== expectedRevision || (expectedSessionId && mocks.active?.id !== expectedSessionId)) {
        throw new actual.StaleStudyStateError();
      }
      return mocks.active;
    }),
    persistStudyStateIfRevision: vi.fn(persist),
    advanceStudySessionIfRevision: vi.fn(async (event: string, index: number, expectedRevision: string, expectedSessionId: string) => {
      mocks.advanceEvents.push(event);
      const active = mocks.active;
      if (!active?.state || active.id !== expectedSessionId || active.updated_at !== expectedRevision) throw new actual.StaleStudyStateError();
      const state = actual.advanceStudyState(active.state, event as any, index);
      return state === active.state ? active : persist(state, expectedRevision, undefined, undefined, expectedSessionId);
    }),
    getStudyDate: vi.fn(async () => "2026-09-27"),
    getPretestResults: mocks.getPretestResults,
    freezeLessonQueueForSession: vi.fn(async (session: any, _words: unknown[], _db?: unknown, _userId?: string, expectedRevision?: string | null) => {
      if (expectedRevision !== undefined && session.updated_at !== expectedRevision) throw new actual.StaleStudyStateError();
      return session;
    }),
    normalizeLegacyLessonSession: vi.fn(async (session: any) => session),
    finishStudySession: mocks.finishStudySession,
  };
});

vi.mock("../server/services/words.js", () => ({
  getTodayWords: mocks.getTodayWords,
  getVocabularyItemsByWords: mocks.getVocabularyItemsByWords,
  recordPretestResult: mocks.recordPretestResult,
}));
vi.mock("../server/tools/renderWidgets.js", async () => {
  const actual = await vi.importActual<typeof import("../server/tools/renderWidgets.js")>("../server/tools/renderWidgets.js");
  return { ...actual, buildReviewWidgetPayload: mocks.buildReviewWidgetPayload };
});
vi.mock("../server/tools/getPronunciationAudio.js", () => ({ getPronunciationAudio: mocks.getPronunciationAudio }));
vi.mock("../server/services/attempts.js", () => ({
  recordAttempt: mocks.recordAttempt,
  getTodayCompletedLessonWords: mocks.getTodayCompletedLessonWords,
}));
vi.mock("../server/services/fsrsReviews.js", () => ({ recordReviewSubmission: mocks.recordReviewSubmission }));
vi.mock("../server/services/deepseek.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/deepseek.js")>("../server/services/deepseek.js");
  return {
    ...actual,
    generateLesson: mocks.generateLesson,
    generateWrapup: mocks.generateWrapup,
    gradeEnglishDefinition: mocks.gradeEnglishDefinition,
    gradeSemanticAnswer: mocks.gradeSemanticAnswer,
    gradeWrapupAnswer: mocks.gradeWrapupAnswer,
  };
});

import { handleWebApiRequest } from "../server/webApi.js";
import { makeStudyState } from "../server/services/studySessions.js";
import { DeepSeekError } from "../server/services/deepseek.js";
import { buildLessonNavigation } from "../server/services/lessonQueue.js";
import { resumableLessonPayload } from "../server/tools/renderWidgets.js";

const date = "2026-09-27";
const userId = "00000000-0000-0000-0000-000000000001";

function row(state: any, revision = "rev-a") {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    user_id: userId,
    started_at: `${date}T00:00:00.000Z`,
    ended_at: null,
    new_words_count: 1,
    review_words_count: 0,
    updated_at: revision,
    state,
  };
}

function lessonState(activityType = "sentence", phase = "lesson_exercise", retryCount = 0) {
  return makeStudyState({
    date,
    widget: "lesson",
    phase: phase as any,
    current_word: "fixture",
    current_index: 0,
    retry_count: retryCount,
    flow: { relearn_words: [], lesson_words: ["fixture"] },
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "exercise",
      word: "fixture",
      activity_type: activityType,
      instruction: "Translate or explain the sentence.",
      prompt: "A fresh prompt in a separate context.",
      multiline: activityType === "sentence",
    },
  });
}

function post(body: unknown, revision = "rev-a"): Request {
  return new Request("https://wordloop.test/api/web/action", {
    method: "POST",
    headers: { authorization: `Bearer ${mocks.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body as object, expected_revision: revision }),
  });
}

async function body(response: Response): Promise<any> {
  return response.json();
}

describe("Standalone Web API shared-state boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.active = null;
    mocks.revisionNumber = 0;
    mocks.advanceEvents.length = 0;
    mocks.token = "web-test-token";
    mocks.getProgress.mockResolvedValue({ today: { completed: 0, total: 1 } });
    mocks.getPretestResults.mockResolvedValue([]);
    mocks.getPronunciationAudio.mockResolvedValue({ words: [] });
    mocks.recordAttempt.mockResolvedValue(undefined);
    mocks.recordPretestResult.mockResolvedValue(undefined);
    mocks.finishStudySession.mockImplementation(async (_db?: unknown, _userId?: string, expected?: { revision: string; sessionId: string }) => {
      if (expected && (mocks.active?.updated_at !== expected.revision || mocks.active?.id !== expected.sessionId)) throw new Error("STALE_STUDY_STATE");
      const finished = { ...mocks.active, ended_at: "2026-09-27T01:00:00.000Z", state: {} };
      mocks.active = null;
      return finished;
    });
    mocks.getVocabularyItemsByWords.mockResolvedValue([{
      word: "fixture", display_word: "fixture", ipa_us: "/ˈfɪks.tʃər/",
      senses: [{ pos: "n.", definition_cn: "设施；固定的事物" }],
    }]);
    mocks.generateLesson.mockResolvedValue({
      ipa: "/ˈfɪks.tʃər/", part_of_speech: "n.", meaning_zh: "设施",
      collocations: ["a permanent fixture"], derivations: ["fix v."],
      example_en: "Although the committee postponed its decision, the evidence continued to influence public debate about educational reform.",
      note: "可指固定设施。",
      exercise: { activity_type: "translation_cn_to_en", instruction: "翻译句子。", prompt: "学校改善了图书馆设施。", multiline: false },
      next_word: "hostile", current_index: 99, navigation: { action: "next_word", next_word: "hostile", next_index: 100 },
    });
  });

  it("requires a bearer token, returns no-store headers, and rejects client-owned cursor fields", async () => {
    const missing = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
    expect(missing.headers.get("referrer-policy")).toBe("no-referrer");

    const wrong = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: "Bearer wrong-token" },
    }));
    expect(wrong.status).toBe(401);

    const unauthenticatedAction = await handleWebApiRequest(new Request("https://wordloop.test/api/web/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh_progress", expected_revision: null }),
    }));
    expect(unauthenticatedAction.status).toBe(401);
    expect(unauthenticatedAction.headers.get("cache-control")).toBe("no-store");

    const invalid = await handleWebApiRequest(post({ action: "lesson_submit", answer: "fixture", word: "other", current_index: 8, rating: "good" }));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
  });

  it("rejects a stale Web submission before grading or recording an attempt", async () => {
    mocks.active = row(lessonState("sentence"), "rev-b");
    const response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "old answer" }, "rev-a"));
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ error: { code: "STALE_STUDY_STATE", message: "Study state changed in another client." } });
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
  });

  it("rechecks revision after DeepSeek returns and discards stale grading", async () => {
    mocks.active = row(lessonState("sentence"));
    mocks.gradeSemanticAnswer.mockImplementationOnce(async () => {
      mocks.active = { ...mocks.active, updated_at: "rev-b" };
      return { is_correct: true, error_layer: "none", message: "正确。", explanation: "语义正确。" };
    });
    const response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "an answer" }));
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ error: { code: "STALE_STUDY_STATE" } });
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
    expect(mocks.active.updated_at).toBe("rev-b");
  });

  it("grades an exact_cloze answer from accepted_answers without calling DeepSeek", async () => {
    const state = lessonState("exact_cloze");
    state.payload.prompt = "The city hired a team of ___ to restore power.";
    state.payload.accepted_answers = ["electricians"];
    mocks.active = row(state);

    const response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "electricians" }));

    expect(response.status).toBe(200);
    const responsePayload = await body(response);
    expect(responsePayload).toMatchObject({ result: { is_correct: true, error_layer: "none" } });
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledOnce();
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      user_answer: "electricians", is_correct: true, error_layer: "none", activity_type: "exact_cloze",
    }));
    expect(mocks.active.state.payload.feedback).toMatchObject({
      is_correct: true,
      error_layer: "none",
      user_answer: "electricians",
    });
    expect(responsePayload.state.payload).not.toHaveProperty("accepted_answers");
  });

  it.each(["cloze", "derivation", "recall"])("keeps legacy fixed-answer %s exercises deterministic", async (activityType) => {
    const state = lessonState(activityType);
    state.payload.accepted_answers = ["electricians"];
    mocks.active = row(state);

    const response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "electricians" }));

    expect(response.status).toBe(200);
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      activity_type: activityType, user_answer: "electricians", is_correct: true, error_layer: "none",
    }));
  });

  it.each(["spelling", "word_recall"])("keeps %s exercises deterministic", async (activityType) => {
    mocks.active = row(lessonState(activityType));

    const response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "fixture" }));

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ result: { is_correct: true, error_layer: "none" } });
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      activity_type: activityType, user_answer: "fixture", is_correct: true, error_layer: "none",
    }));
  });

  it("preserves fixed answers through a Lesson retry and records each submission once", async () => {
    const state = lessonState("exact_cloze");
    state.payload.prompt = "The city hired a team of ___ to restore power.";
    state.payload.accepted_answers = ["electricians"];
    mocks.active = row(state);

    let response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "electrician" }));
    expect(response.status).toBe(200);
    expect(mocks.recordAttempt).toHaveBeenCalledOnce();
    expect(mocks.active.state.payload.accepted_answers).toEqual(["electricians"]);

    response = await handleWebApiRequest(post({ action: "lesson_retry" }, mocks.active.updated_at));
    expect(response.status).toBe(200);
    expect(mocks.active.state.phase).toBe("lesson_exercise");
    expect(mocks.active.state.payload.accepted_answers).toEqual(["electricians"]);

    response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "electricians" }, mocks.active.updated_at));
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ result: { is_correct: true, error_layer: "none" } });
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(2);
  });

  it("rejects blank Lesson and wrap-up submissions before any attempt write", async () => {
    mocks.active = row(lessonState("sentence"));
    const lessonResponse = await handleWebApiRequest(post({ action: "lesson_submit", answer: "  " }));
    expect(lessonResponse.status).toBe(400);
    expect(mocks.recordAttempt).not.toHaveBeenCalled();

    const wrapupState = makeStudyState({
      date, widget: "lesson", phase: "lesson_complete", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "exercise", wrapup: true, word: "fixture",
        activity_type: "sentence", instruction: "Translate.",
        prompt: "A sufficiently long wrap-up prompt about fixture and its useful applications in ordinary settings today.",
        multiline: true,
      },
    });
    mocks.active = row(wrapupState);
    const wrapupResponse = await handleWebApiRequest(post({ action: "wrapup_submit", answer: "\t " }));
    expect(wrapupResponse.status).toBe(400);
    expect(mocks.gradeWrapupAnswer).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
    expect(mocks.active.state).toEqual(wrapupState);
  });

  it("discards Lesson generation output when another client changes the active revision", async () => {
    const state = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(state);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });
    mocks.generateLesson.mockImplementationOnce(async () => {
      mocks.active = { ...mocks.active, updated_at: "chatgpt-revision" };
      return {
        ipa: "/ˈfɪks.tʃər/", part_of_speech: "n.", meaning_zh: "设施", collocations: [], derivations: [],
        example_en: "Although the committee postponed its decision, the evidence continued to influence public debate about educational reform.",
        note: "可指固定设施。", exercise: { activity_type: "translation_cn_to_en", instruction: "翻译。", prompt: "学校改善了设施。", multiline: false },
      };
    });
    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ error: { code: "STALE_STUDY_STATE" } });
    expect(mocks.active.state).toEqual(state);
    expect(mocks.active.updated_at).toBe("chatgpt-revision");
  });

  it.each([
    ["DEEPSEEK_INVALID_OUTPUT", 502],
    ["DEEPSEEK_TIMEOUT", 504],
  ])("does not record or persist a Lesson grade after %s", async (code, status) => {
    const original = lessonState("sentence");
    mocks.active = row(original);
    mocks.gradeSemanticAnswer.mockRejectedValueOnce(new DeepSeekError(code, status, "DeepSeek failed."));
    const response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "my answer" }));
    expect(response.status).toBe(status);
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
    expect(mocks.active.state).toEqual(original);
  });

  it("keeps deterministic recall on TypeScript and only reveals a semantic answer after the second miss", async () => {
    mocks.active = row(lessonState("word_recall"));
    const deterministic = await handleWebApiRequest(post({ action: "lesson_submit", answer: "fixture" }));
    expect(deterministic.status).toBe(200);
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.active.state.payload.feedback).toMatchObject({ is_correct: true, reveal_answer: false });

    mocks.active = row(lessonState("sentence"));
    mocks.gradeSemanticAnswer
      .mockResolvedValueOnce({ is_correct: false, error_layer: "grammar", message: "请调整结构。", explanation: "主谓关系不清。", reference_answer: "hidden answer" })
      .mockResolvedValueOnce({ is_correct: false, error_layer: "meaning", message: "仍需修改。", explanation: "表达有误。", reference_answer: "revealed answer" });
    const first = await handleWebApiRequest(post({ action: "lesson_submit", answer: "first attempt" }));
    expect(first.status).toBe(200);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_feedback", retry_count: 1 });
    expect(mocks.active.state.payload.feedback).toMatchObject({ reveal_answer: false });
    expect(mocks.active.state.payload.feedback).not.toHaveProperty("reference_answer");

    let retryRevision = mocks.active.updated_at as string;
    await handleWebApiRequest(post({ action: "lesson_retry" }, retryRevision));
    retryRevision = mocks.active.updated_at as string;
    const second = await handleWebApiRequest(post({ action: "lesson_submit", answer: "second attempt" }, retryRevision));
    expect(second.status).toBe(200);
    expect(mocks.gradeSemanticAnswer).toHaveBeenCalledTimes(2);
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(3);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_feedback", retry_count: 2 });
    expect(mocks.active.state.payload.feedback).toMatchObject({ reveal_answer: true, reference_answer: "revealed answer" });
  });

  it("creates canonical Lesson state from the frozen server queue and ignores model navigation fields", async () => {
    const start = makeStudyState({
      date,
      widget: "pretest",
      phase: "pretest_complete",
      current_word: null,
      current_index: 1,
      retry_count: 0,
      flow: { relearn_words: ["relearned"], lesson_words: ["fixture", "next-word"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(start);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });
    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload.state).toMatchObject({
      widget: "lesson", phase: "lesson_explain", current_word: "fixture", current_index: 0,
      flow: { lesson_words: ["fixture", "next-word"] },
      payload: { mode: "explain", word: "fixture", navigation: { action: "next_word", next_word: "next-word", next_index: 1 } },
    });
    expect(payload.state.payload).not.toMatchObject({ current_index: 99, next_word: "hostile" });
    expect(mocks.generateLesson).toHaveBeenCalledWith(expect.objectContaining({ word: "fixture" }));
    const chatgptResume = await resumableLessonPayload(mocks.active);
    expect(chatgptResume).toMatchObject({
      widget: "lesson", phase: "lesson_explain", current_index: 0, mode: "explain", word: "fixture",
      exercise: { activity_type: "translation_cn_to_en", prompt: "学校改善了图书馆设施。" },
      navigation: { action: "next_word", next_word: "next-word", next_index: 1 },
    });
  });

  it("persists fixed answers in the server Lesson state but omits them from the Web response", async () => {
    const start = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(start);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });
    mocks.generateLesson.mockResolvedValueOnce({
      ipa: "/ˈfɪks.tʃər/", part_of_speech: "n.", meaning_zh: "设施",
      collocations: ["a permanent fixture"], derivations: ["fix v."],
      example_en: "Although the committee postponed its decision, the evidence continued to influence public debate about educational reform.",
      example_zh: "尽管委员会推迟了决定，证据仍持续影响有关教育改革的公共讨论。", note: "可指固定设施。",
      exercise: { activity_type: "exact_cloze", instruction: "填入正确词形。", prompt: "The city hired a team of ___ to restore power.", accepted_answers: ["electricians"], multiline: false },
    });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(mocks.active.state.payload).toMatchObject({
      accepted_answers: ["electricians"],
      exercise: { activity_type: "exact_cloze", accepted_answers: ["electricians"] },
    });
    const sessions = await import("../server/services/studySessions.js");
    expect(vi.mocked(sessions.persistStudyStateIfRevision)).toHaveBeenCalledOnce();
    expect(payload.state.payload).not.toHaveProperty("accepted_answers");
    expect(payload.state.payload.exercise).not.toHaveProperty("accepted_answers");

    const persistResumableState = vi.spyOn(sessions, "persistStudyState").mockResolvedValueOnce(mocks.active);
    const widgetPayload = await resumableLessonPayload(mocks.active);
    expect(persistResumableState).toHaveBeenCalledOnce();
    persistResumableState.mockRestore();
    expect(widgetPayload.exercise).not.toHaveProperty("accepted_answers");
    expect(mocks.active.state.payload.exercise.accepted_answers).toEqual(["electricians"]);
  });

  it("takes the next word and cursor only from persisted backend navigation and the frozen queue", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_feedback", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture", "next-word"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", word: "fixture", progress: "1 / 2",
        exercise: { activity_type: "sentence", instruction: "Translate.", prompt: "The current exercise.", multiline: true },
        feedback: { is_correct: true, user_answer: "correct answer", reveal_answer: false },
        navigation: buildLessonNavigation(["fixture", "next-word"], 0, "fixture"),
      },
    });
    mocks.active = row(state);
    mocks.getVocabularyItemsByWords.mockImplementationOnce(async (words: string[]) => [{
      word: words[0]!, display_word: words[0]!, ipa_us: "/nekst/", senses: [{ pos: "n.", definition_cn: "下一个词" }],
    }]);
    const response = await handleWebApiRequest(post({ action: "lesson_next" }));
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(mocks.generateLesson).toHaveBeenCalledWith(expect.objectContaining({ word: "next-word" }));
    expect(payload.state).toMatchObject({
      current_word: "next-word", current_index: 1,
      flow: { lesson_words: ["fixture", "next-word"] },
      payload: { word: "next-word", navigation: { action: "round_complete", total_count: 2 } },
    });
  });

  it("leaves the current pretest-complete session untouched when Lesson generation fails", async () => {
    const state = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(state);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });
    mocks.generateLesson.mockRejectedValueOnce(new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "invalid output"));
    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    expect(response.status).toBe(502);
    expect(mocks.active.state).toEqual(state);
    expect(mocks.active.updated_at).toBe("rev-a");
  });

  it("leaves the durable state and cursor untouched when Lesson generation times out", async () => {
    const state = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(state);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });
    mocks.generateLesson.mockRejectedValueOnce(new DeepSeekError("DEEPSEEK_TIMEOUT", 504, "DeepSeek request timed out."));

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));

    expect(response.status).toBe(504);
    expect(await body(response)).toMatchObject({ error: { code: "DEEPSEEK_TIMEOUT" } });
    expect(mocks.active.state).toEqual(state);
    expect(mocks.active.updated_at).toBe("rev-a");
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
    expect(mocks.advanceEvents).toEqual([]);
  });

  it("does not freeze a new Lesson queue when real bootstrap reaches a generation timeout", async () => {
    const state = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(state);
    mocks.getTodayWords.mockResolvedValue([{
      word: "fixture", display_word: "fixture", status: "unknown", mastered: false,
      senses: [{ pos: "n.", definition_cn: "设施" }],
    }]);
    mocks.getVocabularyItemsByWords.mockImplementation(async (words: string[]) => words.map((word) => ({
      word, display_word: word, senses: [{ pos: "n.", definition_cn: "设施" }],
    })));
    const actualBootstrap = await vi.importActual<typeof import("../server/services/studyBootstrap.js")>("../server/services/studyBootstrap.js");
    mocks.bootstrap.mockImplementation((options: any) => actualBootstrap.getStudyBootstrap(options));
    mocks.generateLesson.mockRejectedValueOnce(new DeepSeekError("DEEPSEEK_TIMEOUT", 504, "DeepSeek request timed out."));

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const sessions = await import("../server/services/studySessions.js");

    expect(response.status).toBe(504);
    expect(await body(response)).toMatchObject({ error: { code: "DEEPSEEK_TIMEOUT" } });
    expect(mocks.bootstrap).toHaveBeenCalledWith(expect.objectContaining({ deferLessonQueueFreeze: true }));
    expect(vi.mocked(sessions.freezeLessonQueueForSession)).not.toHaveBeenCalled();
    expect(mocks.active.state).toEqual(state);
    expect(mocks.active.updated_at).toBe("rev-a");
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
    expect(mocks.advanceEvents).toEqual([]);
  });

  it("does not record an attempt or advance Lesson state after grading times out", async () => {
    const state = lessonState("sentence");
    mocks.active = row(state);
    mocks.gradeSemanticAnswer.mockRejectedValueOnce(new DeepSeekError("DEEPSEEK_TIMEOUT", 504, "DeepSeek request timed out."));

    const response = await handleWebApiRequest(post({ action: "lesson_submit", answer: "private answer" }));

    expect(response.status).toBe(504);
    expect(await body(response)).toMatchObject({ error: { code: "DEEPSEEK_TIMEOUT" } });
    expect(mocks.active.state).toEqual(state);
    expect(mocks.active.updated_at).toBe("rev-a");
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
    expect(mocks.advanceEvents).toEqual([]);
  });

  it("returns ChatGPT-persisted Lesson feedback unchanged to Web bootstrap", async () => {
    const canonical = makeStudyState({
      date, widget: "lesson", phase: "lesson_feedback", current_word: "fixture", current_index: 0, retry_count: 1,
      flow: { relearn_words: [], lesson_words: ["fixture", "next-word"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", word: "fixture", progress: "1 / 2",
        exercise: { activity_type: "sentence", instruction: "Translate.", prompt: "A sentence about the current word.", multiline: true },
        feedback: { is_correct: false, user_answer: "my answer", error_layer: "grammar", message: "修正主谓关系。", explanation: "主语和谓语需要一致。", reveal_answer: false },
        navigation: { action: "next_word", next_word: "next-word", next_index: 1, total_count: 2 },
      },
    });
    mocks.active = row(canonical, "chatgpt-revision");
    mocks.bootstrap.mockResolvedValue({ action: "resume", widget: "lesson", phase: "lesson_feedback" });
    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);
    expect(payload).toMatchObject({ screen: "lesson", session_revision: "chatgpt-revision", state: canonical });
    expect(mocks.active.state).toEqual(canonical);
  });

  it("maps Pretest recall deterministically and skips the listening phases", async () => {
    mocks.active = row(makeStudyState({
      date, widget: "pretest", phase: "pretest", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    }));
    const response = await handleWebApiRequest(post({ action: "pretest_submit", answer: "fixture" }));
    expect(response.status).toBe(200);
    expect(mocks.recordPretestResult).toHaveBeenCalledWith(expect.objectContaining({ word: "fixture", result: "known" }));
    expect(mocks.advanceEvents).toEqual(["pretest_result", "pretest_complete"]);
    expect(mocks.active.state).toMatchObject({ phase: "pretest_complete", current_index: 1, current_word: null });
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ["fixture", "known"],
    ["fixtur", "uncertain"],
    ["banana", "unknown"],
  ])("maps Pretest answer %s to %s in the existing result service", async (answer, result) => {
    mocks.active = row(makeStudyState({
      date, widget: "pretest", phase: "pretest", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] }, payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    }));
    const response = await handleWebApiRequest(post({ action: "pretest_submit", answer }));
    expect(response.status).toBe(200);
    expect(mocks.recordPretestResult).toHaveBeenCalledWith(expect.objectContaining({ result }));
  });

  it("uses recordReviewSubmission once with server-owned word and rating for each review direction", async () => {
    const makeReview = (direction: "cn_to_en" | "en_definition") => makeStudyState({
      date, widget: "review", phase: "review", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "review", items: [{
        word: "fixture", meaning_zh: "设施", part_of_speech: "n.", direction,
        error_layers: [], is_due: true, review_kind: "fsrs_due", next_review_at: "2026-09-26T00:00:00.000Z",
      }] },
    });
    mocks.recordReviewSubmission.mockImplementation(async () => {
      mocks.active = { ...mocks.active, state: { ...mocks.active.state, phase: "review_complete", current_word: null, current_index: 1 }, updated_at: `rev-${++mocks.revisionNumber}` };
    });
    mocks.active = row(makeReview("cn_to_en"));
    let response = await handleWebApiRequest(post({ action: "review_submit", answer: "fixture" }));
    expect(response.status).toBe(200);
    expect(mocks.gradeEnglishDefinition).not.toHaveBeenCalled();
    expect(mocks.recordReviewSubmission).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewSubmission.mock.calls[0]?.[0]).toMatchObject({ word: "fixture", rating: "good", direction: "cn_to_en" });

    mocks.recordReviewSubmission.mockClear();
    mocks.active = row(makeReview("en_definition"));
    mocks.gradeEnglishDefinition.mockResolvedValueOnce({ is_correct: true, feedback: "释义准确。" });
    response = await handleWebApiRequest(post({ action: "review_submit", answer: "a permanent object" }));
    expect(response.status).toBe(200);
    expect(mocks.gradeEnglishDefinition).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewSubmission).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewSubmission.mock.calls[0]?.[0]).toMatchObject({ word: "fixture", rating: "good", direction: "en_definition" });

    mocks.recordReviewSubmission.mockClear();
    mocks.gradeEnglishDefinition.mockReset();
    mocks.gradeEnglishDefinition.mockResolvedValueOnce({ is_correct: false, feedback: "释义没有覆盖核心义。" });
    mocks.active = row(makeReview("en_definition"));
    response = await handleWebApiRequest(post({ action: "review_submit", answer: "an unrelated definition" }));
    expect(response.status).toBe(200);
    expect(mocks.gradeEnglishDefinition).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewSubmission).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewSubmission.mock.calls[0]?.[0]).toMatchObject({ word: "fixture", rating: "again", error_layer: "meaning" });
  });

  it("submits separator-equivalent air-conditioning recall as Good with no spelling error", async () => {
    const reviewState = makeStudyState({
      date, widget: "review", phase: "review", current_word: "air-conditioning", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "review", items: [{
        word: "air-conditioning", meaning_zh: "空调", direction: "cn_to_en",
        error_layers: [], is_due: true, review_kind: "fsrs_due", next_review_at: "2026-09-26T00:00:00.000Z",
      }] },
    });
    mocks.recordReviewSubmission.mockImplementation(async () => {
      mocks.active = {
        ...mocks.active,
        state: { ...mocks.active.state, phase: "review_complete", current_word: null, current_index: 1 },
        updated_at: `rev-${++mocks.revisionNumber}`,
      };
    });
    mocks.active = row(reviewState);

    const response = await handleWebApiRequest(post({ action: "review_submit", answer: "air conditioning" }));

    expect(response.status).toBe(200);
    expect(mocks.recordReviewSubmission).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewSubmission.mock.calls[0]?.[0]).toMatchObject({
      word: "air-conditioning",
      user_answer: "air conditioning",
      is_correct: true,
      error_layer: "none",
      rating: "good",
      direction: "cn_to_en",
    });
  });

  it("preserves deterministic Review near-miss Hard and failure Again ratings", async () => {
    const reviewState = makeStudyState({
      date, widget: "review", phase: "review", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "review", items: [{ word: "fixture", meaning_zh: "设施", direction: "cn_to_en", error_layers: [], is_due: true, review_kind: "fsrs_due", next_review_at: "2026-09-26T00:00:00.000Z" }] },
    });
    mocks.recordReviewSubmission.mockImplementation(async () => {
      mocks.active = { ...mocks.active, state: { ...mocks.active.state, phase: "review_complete", current_word: null, current_index: 1 }, updated_at: `rev-${++mocks.revisionNumber}` };
    });
    mocks.active = row(reviewState);
    let response = await handleWebApiRequest(post({ action: "review_submit", answer: "fixtur" }));
    expect(response.status).toBe(200);
    expect(mocks.recordReviewSubmission.mock.calls[0]?.[0]).toMatchObject({ rating: "hard", error_layer: "spelling" });
    mocks.recordReviewSubmission.mockClear();

    mocks.active = row(reviewState);
    response = await handleWebApiRequest(post({ action: "review_submit", answer: "banana" }));
    expect(response.status).toBe(200);
    expect(mocks.recordReviewSubmission.mock.calls[0]?.[0]).toMatchObject({ rating: "again", error_layer: "meaning" });
    expect(mocks.gradeEnglishDefinition).not.toHaveBeenCalled();
  });

  it("continues to the backend's next stage after Review completion instead of reopening the old snapshot", async () => {
    mocks.active = row(makeStudyState({
      date, widget: "review", phase: "review_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] }, payload: { widget: "review", items: [{ word: "fixture" }] },
    }));
    mocks.bootstrap.mockResolvedValue({ action: "pretest", words: [{
      word: "new-word", display_word: "new-word", senses: [{ pos: "n.", definition_cn: "新词含义" }],
    }] });
    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ screen: "pretest", state: { phase: "pretest", payload: { items: [{ word: "new-word" }] } } });
    expect(mocks.buildReviewWidgetPayload).not.toHaveBeenCalled();
  });

  it("routes a contaminated completed Review to Pretest before Lesson generation", async () => {
    const prematureLessonWords = ["pirate", "feeble", "intensive", "nerve"];
    const todayWords = Array.from({ length: 50 }, (_, index) => ({
      word: `new-word-${index + 1}`,
      display_word: `new-word-${index + 1}`,
      status: "new" as const,
      mastered: false,
      senses: [{ pos: "n.", definition_cn: "新词含义" }],
    }));
    const reviewState = makeStudyState({
      date,
      widget: "review",
      phase: "review_complete",
      current_word: null,
      current_index: 25,
      retry_count: 0,
      flow: { relearn_words: [], lesson_words: prematureLessonWords },
      payload: { widget: "review", items: Array.from({ length: 25 }, (_, index) => ({ word: `review-${index + 1}` })) },
    });
    mocks.active = row(reviewState);
    mocks.getTodayWords.mockResolvedValue(todayWords);
    const actualBootstrap = await vi.importActual<typeof import("../server/services/studyBootstrap.js")>("../server/services/studyBootstrap.js");
    mocks.bootstrap.mockImplementation((options: any) => actualBootstrap.getStudyBootstrap(options));

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);
    const sessions = await import("../server/services/studySessions.js");

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      screen: "pretest",
      state: {
        widget: "pretest",
        phase: "pretest",
        current_index: 0,
        payload: { items: Array.from({ length: 6 }, (_, index) => ({ word: `new-word-${index + 1}` })) },
      },
    });
    expect(payload.state.flow).toEqual({ relearn_words: [] });
    expect(mocks.generateLesson).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.freezeLessonQueueForSession)).not.toHaveBeenCalled();
    expect(mocks.getTodayWords).toHaveBeenCalledWith(date, {}, userId);
  });

  it("does not freeze the Lesson queue in prepareBootstrap before Review progression is decided", async () => {
    const reviewState = makeStudyState({
      date,
      widget: "review",
      phase: "review_complete",
      current_word: null,
      current_index: 25,
      retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "review", items: Array.from({ length: 25 }, (_, index) => ({ word: `review-${index + 1}` })) },
    });
    mocks.active = row(reviewState);
    mocks.bootstrap.mockResolvedValue({ action: "pretest", words: [{
      word: "new-word", display_word: "new-word", senses: [{ pos: "n.", definition_cn: "新词含义" }],
    }] });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const sessions = await import("../server/services/studySessions.js");

    expect(response.status).toBe(200);
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(vi.mocked(sessions.freezeLessonQueueForSession)).not.toHaveBeenCalled();
    expect(mocks.generateLesson).not.toHaveBeenCalled();
  });

  it("keeps wrap-up retry on the same stored exercise without another DeepSeek call or attempt", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_complete", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: { widget: "lesson", widget_version: 3, mode: "exercise", wrapup: true, word: "fixture", activity_type: "sentence", instruction: "Translate.", prompt: "A sufficiently long wrap-up prompt about fixture and its useful applications in ordinary settings today.", multiline: true },
    });
    mocks.active = row(state);
    mocks.gradeWrapupAnswer.mockResolvedValueOnce({ is_correct: false, error_layer: "grammar", message: "请调整结构。", explanation: "检查主句结构。", reference_answer: "private answer" });
    let response = await handleWebApiRequest(post({ action: "wrapup_submit", answer: "first attempt" }));
    expect(response.status).toBe(200);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_complete", retry_count: 1, payload: { mode: "feedback", wrapup: true, feedback: { reveal_answer: false } } });
    expect(mocks.active.state.payload.feedback).not.toHaveProperty("reference_answer");
    const samePrompt = mocks.active.state.payload.exercise.prompt;
    const retryRevision = mocks.active.updated_at as string;
    response = await handleWebApiRequest(post({ action: "wrapup_retry" }, retryRevision));
    expect(response.status).toBe(200);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_complete", current_word: "fixture", current_index: 0, retry_count: 1, payload: { mode: "exercise", wrapup: true, prompt: samePrompt } });
    expect(mocks.gradeWrapupAnswer).toHaveBeenCalledTimes(1);
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(1);

    mocks.gradeWrapupAnswer.mockResolvedValueOnce({ is_correct: false, error_layer: "grammar", message: "仍需修改。", explanation: "请检查从句关系。", reference_answer: "revealed answer" });
    const secondRevision = mocks.active.updated_at as string;
    response = await handleWebApiRequest(post({ action: "wrapup_submit", answer: "second attempt" }, secondRevision));
    expect(response.status).toBe(200);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_complete", retry_count: 2, payload: { mode: "feedback", wrapup: true, feedback: { reveal_answer: true, reference_answer: "revealed answer" } } });
    expect(mocks.gradeWrapupAnswer).toHaveBeenCalledTimes(2);
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(2);
  });

  it("blocks wrap-up finish before acceptance and allows finish after the answer is revealed", async () => {
    const wrapupFeedback = (isCorrect: boolean, revealAnswer: boolean) => makeStudyState({
      date, widget: "lesson", phase: "lesson_complete", current_word: "fixture", current_index: 0,
      retry_count: revealAnswer ? 2 : 1, flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", wrapup: true, word: "fixture", progress: "本轮长难句收尾",
        exercise: { activity_type: "sentence", instruction: "Translate.", prompt: "A sufficiently long wrap-up prompt about fixture and its useful applications in ordinary settings today.", multiline: true },
        feedback: { is_correct: isCorrect, user_answer: "my answer", error_layer: isCorrect ? "none" : "grammar", message: "反馈。", explanation: "解释。", reveal_answer: revealAnswer, ...(revealAnswer ? { reference_answer: "answer" } : {}) },
      },
    });
    mocks.active = row(wrapupFeedback(false, false));
    let response = await handleWebApiRequest(post({ action: "wrapup_finish" }));
    expect(response.status).toBe(409);
    expect(mocks.finishStudySession).not.toHaveBeenCalled();

    mocks.active = row(wrapupFeedback(false, true));
    mocks.finishStudySession.mockImplementationOnce(async () => {
      mocks.active = null;
      return { ended_at: "2026-09-27T01:00:00.000Z" };
    });
    mocks.bootstrap.mockResolvedValueOnce({ action: "done" });
    response = await handleWebApiRequest(post({ action: "wrapup_finish" }));
    expect(response.status).toBe(200);
    expect(mocks.finishStudySession).toHaveBeenCalledTimes(1);
    await expect(body(response)).resolves.toMatchObject({ screen: "done" });
  });
});
