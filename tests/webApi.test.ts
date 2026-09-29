import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: null as any,
  consolidationDecision: null as any,
  revisionNumber: 0,
  advanceEvents: [] as string[],
  token: "web-test-token" as string | undefined,
  bootstrap: vi.fn(),
  getProgress: vi.fn(),
  getPretestResults: vi.fn(),
  markPretestFamiliar: vi.fn(),
  getTodayWords: vi.fn(),
  getVocabularyItemsByWords: vi.fn(),
  recordPretestResult: vi.fn(),
  setDailyNewWordLimit: vi.fn(),
  getPronunciationAudio: vi.fn(),
  buildReviewWidgetPayload: vi.fn(),
  recordAttempt: vi.fn(),
  getCompletedLessonWords: vi.fn(async () => new Set<string>()),
  getDueReviewSelection: vi.fn(),
  recordReviewSubmission: vi.fn(),
  finishStudySession: vi.fn(),
  generateLesson: vi.fn(),
  generateWrapup: vi.fn(),
  generateSentenceConsolidation: vi.fn(),
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
vi.mock("../server/services/lessonConsolidation.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/lessonConsolidation.js")>("../server/services/lessonConsolidation.js");
  return {
    ...actual,
    decideLessonConsolidation: vi.fn(async (state: any) => mocks.consolidationDecision
      ? { ...state, payload: { ...state.payload, ...mocks.consolidationDecision } }
      : state),
  };
});
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
      let state = actual.advanceStudyState(active.state, event as any, index);
      if (event === "lesson_complete" && state.widget === "lesson" && state.phase === "lesson_complete") {
        state = mocks.consolidationDecision
          ? { ...state, payload: { ...state.payload, ...mocks.consolidationDecision } }
          : state;
      }
      return state === active.state ? active : persist(state, expectedRevision, undefined, undefined, expectedSessionId);
    }),
    getStudyDate: vi.fn(async () => "2026-09-27"),
    getPretestResults: mocks.getPretestResults,
    markPretestFamiliar: mocks.markPretestFamiliar,
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
  setDailyNewWordLimit: mocks.setDailyNewWordLimit,
}));
vi.mock("../server/tools/renderWidgets.js", async () => {
  const actual = await vi.importActual<typeof import("../server/tools/renderWidgets.js")>("../server/tools/renderWidgets.js");
  return { ...actual, buildReviewWidgetPayload: mocks.buildReviewWidgetPayload };
});
vi.mock("../server/tools/getPronunciationAudio.js", () => ({ getPronunciationAudio: mocks.getPronunciationAudio }));
vi.mock("../server/services/attempts.js", () => ({
  recordAttempt: mocks.recordAttempt,
  getCompletedLessonWords: mocks.getCompletedLessonWords,
}));
vi.mock("../server/services/review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/review.js")>();
  return { ...actual, getDueReviewSelection: mocks.getDueReviewSelection };
});
vi.mock("../server/services/fsrsReviews.js", () => ({ recordReviewSubmission: mocks.recordReviewSubmission }));
vi.mock("../server/services/deepseek.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/deepseek.js")>("../server/services/deepseek.js");
  return {
    ...actual,
    generateLesson: mocks.generateLesson,
    generateWrapup: mocks.generateWrapup,
    generateSentenceConsolidation: mocks.generateSentenceConsolidation,
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
    mocks.consolidationDecision = null;
    mocks.revisionNumber = 0;
    mocks.advanceEvents.length = 0;
    mocks.token = "web-test-token";
    mocks.getProgress.mockResolvedValue({ today: { completed: 0, total: 1 } });
    mocks.generateSentenceConsolidation.mockReset();
    mocks.setDailyNewWordLimit.mockResolvedValue({ daily_new_word_limit: 50, date, prepared: 50, added: 0 });
    mocks.getPretestResults.mockResolvedValue([]);
    mocks.markPretestFamiliar.mockResolvedValue(undefined);
    mocks.getDueReviewSelection.mockResolvedValue({ rollingReview: [], oldRandomReview: [] });
    mocks.getPronunciationAudio.mockResolvedValue({ words: [] });
    mocks.recordAttempt.mockResolvedValue(undefined);
    mocks.recordPretestResult.mockResolvedValue(undefined);
    mocks.finishStudySession.mockImplementation(async (_db?: unknown, _userId?: string, expected?: { revision: string; sessionId: string; allowLessonRoundCompletion?: boolean }) => {
      if (expected && (mocks.active?.updated_at !== expected.revision || mocks.active?.id !== expected.sessionId)) throw new Error("STALE_STUDY_STATE");
      const finished = { ...mocks.active, ended_at: "2026-09-27T01:00:00.000Z", state: {} };
      mocks.active = null;
      return finished;
    });
    mocks.getVocabularyItemsByWords.mockResolvedValue([{
      word: "fixture", display_word: "fixture", status: "unknown", error_layers: [], ipa_us: "/ˈfɪks.tʃər/",
      senses: [{ pos: "n.", definition_cn: "设施；固定的事物" }],
    }]);
    mocks.generateLesson.mockResolvedValue({
      ipa: "/ˈfɪks.tʃər/", part_of_speech: "n.", meaning_zh: "设施",
      collocations: ["a permanent fixture"], derivations: ["fix v."],
      example_en: "Although the committee postponed its decision, the evidence continued to influence public debate about educational reform.",
      note: "可指固定设施。",
      exercise: { activity_type: "exact_cloze", instruction: "根据语境回忆目标词并填空。", prompt: "The school added a ___ for families to use during evening events.", multiline: false, accepted_answers: ["fixture"] },
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

  it("raises today's queue from 50 to 70 and returns 50 / 70 progress without an active session", async () => {
    mocks.setDailyNewWordLimit.mockResolvedValue({ daily_new_word_limit: 70, date, prepared: 70, added: 20 });
    const progress = {
      today: { total: 70, completed: 50 },
      review_today: { completed: 0, total: 0, remaining: 0 },
      all_time: { error_book: 0, mastered: 0 },
      fsrs: { due_now: 0, tomorrow: 0, due_next_7_days: 0 },
      settings: { daily_new_word_limit: 70 },
    };
    mocks.getProgress.mockResolvedValue(progress);

    const response = await handleWebApiRequest(post({ action: "set_daily_new_word_limit", limit: 70 }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(mocks.setDailyNewWordLimit).toHaveBeenCalledWith(70);
    expect(payload).toMatchObject({
      screen: "done",
      settings_update: { daily_new_word_limit: 70, prepared: 70, added: 20 },
      progress: { today: { completed: 50, total: 70 }, settings: { daily_new_word_limit: 70 } },
    });
  });

  it("keeps 70 prepared words and the frozen Lesson queue when the future target is lowered to 50", async () => {
    const activeState = lessonState();
    mocks.active = row(activeState, "rev-a");
    mocks.setDailyNewWordLimit.mockResolvedValue({ daily_new_word_limit: 50, date, prepared: 70, added: 0 });
    mocks.getProgress.mockResolvedValue({
      today: { total: 70, completed: 50 },
      review_today: { completed: 0, total: 0, remaining: 0 },
      all_time: { error_book: 0, mastered: 0 },
      fsrs: { due_now: 0, tomorrow: 0, due_next_7_days: 0 },
      settings: { daily_new_word_limit: 50 },
    });

    const response = await handleWebApiRequest(post({ action: "set_daily_new_word_limit", limit: 50 }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(mocks.setDailyNewWordLimit).toHaveBeenCalledWith(50);
    expect(payload).toMatchObject({
      screen: "lesson",
      session_revision: "rev-a",
      state: activeState,
      settings_update: { daily_new_word_limit: 50, prepared: 70, added: 0 },
      progress: { today: { completed: 50, total: 70 }, settings: { daily_new_word_limit: 50 } },
    });
    expect(mocks.active.state.flow.lesson_words).toEqual(["fixture"]);
    expect(mocks.advanceEvents).toEqual([]);
  });

  it("leaves an active six-word Pretest snapshot untouched when the limit increases", async () => {
    const items = ["A", "B", "C", "D", "E", "F"].map((word) => ({ word, meaning_zh: `${word} 的含义` }));
    const activeState = makeStudyState({
      date,
      widget: "pretest",
      phase: "pretest",
      current_word: "C",
      current_index: 2,
      retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "pretest", items },
    });
    mocks.active = row(activeState, "rev-a");
    mocks.setDailyNewWordLimit.mockResolvedValue({ daily_new_word_limit: 70, date, prepared: 70, added: 20 });

    const response = await handleWebApiRequest(post({ action: "set_daily_new_word_limit", limit: 70 }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ screen: "pretest", session_revision: "rev-a", state: activeState });
    expect(mocks.active.state.payload.items).toEqual(items);
    expect(mocks.advanceEvents).toEqual([]);
  });

  it.each([0, 201, 1.5, Number.NaN])("rejects invalid daily target %s", async (limit) => {
    const response = await handleWebApiRequest(post({ action: "set_daily_new_word_limit", limit }));
    expect(response.status).toBe(400);
    expect(mocks.setDailyNewWordLimit).not.toHaveBeenCalled();
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
    state.payload.lesson_profile = "quick_recall";
    state.payload.error_focus = null;
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
    expect(mocks.active.state.payload).toMatchObject({ lesson_profile: "quick_recall", error_focus: null });
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

    mocks.bootstrap.mockResolvedValue({ action: "done" });
    const next = await handleWebApiRequest(post({ action: "lesson_next" }, mocks.active.updated_at));
    expect(next.status).toBe(200);
    expect(mocks.generateWrapup).not.toHaveBeenCalled();
    expect(mocks.generateLesson).not.toHaveBeenCalled();
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
      payload: { mode: "explain", word: "fixture", lesson_profile: "reinforce", error_focus: null, navigation: { action: "next_word", next_word: "next-word", next_index: 1 } },
    });
    expect(payload.state.payload).not.toMatchObject({ current_index: 99, next_word: "hostile" });
    expect(mocks.generateLesson).toHaveBeenCalledWith(expect.objectContaining({ word: "fixture", lesson_profile: "reinforce", error_focus: null }));
    const chatgptResume = await resumableLessonPayload(mocks.active);
    expect(chatgptResume).toMatchObject({
      widget: "lesson", phase: "lesson_explain", current_index: 0, mode: "explain", word: "fixture",
      exercise: { activity_type: "exact_cloze", prompt: "The school added a ___ for families to use during evening events." },
      navigation: { action: "next_word", next_word: "next-word", next_index: 1 },
    });
    expect(payload.state.flow.lesson_profile_history).toEqual([
      { word: "fixture", lesson_profile: "reinforce", error_focus: null },
    ]);
  });

  it("targets an explicitly queued Review relearn even after live status changes", async () => {
    const start = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: ["FIXTURE"], lesson_words: ["fixture"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(start);
    mocks.getVocabularyItemsByWords.mockResolvedValueOnce([{
      word: "fixture", display_word: "fixture", status: "known", error_layers: [],
      senses: [{ pos: "n.", definition_cn: "设施" }],
    }]);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));

    expect(response.status).toBe(200);
    expect(mocks.generateLesson).toHaveBeenCalledWith(expect.objectContaining({
      lesson_profile: "targeted_relearn", error_focus: null,
    }));
    expect(mocks.active.state.payload).toMatchObject({ lesson_profile: "targeted_relearn", error_focus: null });
  });

  it("passes a current spelling error layer into targeted Lesson generation", async () => {
    const start = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(start);
    mocks.getVocabularyItemsByWords.mockResolvedValueOnce([{
      word: "fixture", display_word: "fixture", status: "uncertain", error_layers: ["spelling"],
      senses: [{ pos: "n.", definition_cn: "设施" }],
    }]);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));

    expect(response.status).toBe(200);
    expect(mocks.generateLesson).toHaveBeenCalledWith(expect.objectContaining({
      lesson_profile: "targeted_relearn", error_focus: "spelling",
    }));
    expect(mocks.active.state.payload).toMatchObject({ lesson_profile: "targeted_relearn", error_focus: "spelling" });
  });

  it("uses quick_recall for an uncertain word with no active error", async () => {
    const start = makeStudyState({
      date, widget: "pretest", phase: "pretest_complete", current_word: null, current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    });
    mocks.active = row(start);
    mocks.getVocabularyItemsByWords.mockResolvedValueOnce([{
      word: "fixture", display_word: "fixture", status: "uncertain", error_layers: [],
      senses: [{ pos: "n.", definition_cn: "设施" }],
    }]);
    mocks.bootstrap.mockResolvedValue({ action: "lesson", word: { word: "fixture" } });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));

    expect(response.status).toBe(200);
    expect(mocks.generateLesson).toHaveBeenCalledWith(expect.objectContaining({
      lesson_profile: "quick_recall", error_focus: null,
    }));
    expect(mocks.active.state.payload).toMatchObject({ lesson_profile: "quick_recall", error_focus: null });
  });

  it("resumes the stored profile, exercise, and cursor without recalculating or regenerating", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_exercise", current_word: "fixture", current_index: 1, retry_count: 0,
      flow: { relearn_words: ["fixture"], lesson_words: ["before", "fixture", "after"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "exercise", word: "fixture",
        lesson_profile: "targeted_relearn", error_focus: "spelling",
        activity_type: "exact_cloze", instruction: "填入目标词形。",
        prompt: "The museum has one ___ that displays old local photographs.",
        accepted_answers: ["fixture"], multiline: false,
      },
    });
    mocks.active = row(state);
    mocks.bootstrap.mockResolvedValue({ action: "resume", widget: "lesson", phase: "lesson_exercise" });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.state).toMatchObject({
      current_index: 1, current_word: "fixture",
      payload: {
        lesson_profile: "targeted_relearn", error_focus: "spelling",
        prompt: "The museum has one ___ that displays old local photographs.",
      },
    });
    expect(mocks.generateLesson).not.toHaveBeenCalled();
  });

  it("prunes previously completed words from the unvisited active Lesson queue", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_exercise", current_word: "current", current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["done-before", "current", "old-a", "pending"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "exercise", word: "current",
        activity_type: "exact_cloze", instruction: "填入目标词形。",
        prompt: "The current entry is an example sentence.", multiline: false,
        navigation: buildLessonNavigation(["done-before", "current", "old-a", "pending"], 1, "current"),
      },
    });
    mocks.active = row(state);
    mocks.getCompletedLessonWords.mockResolvedValueOnce(new Set(["done-before", "old-a"]));
    mocks.bootstrap.mockResolvedValue({ action: "resume", widget: "lesson", phase: "lesson_exercise" });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(mocks.getCompletedLessonWords).toHaveBeenCalledWith({}, userId, mocks.active.started_at);
    expect(payload.state).toMatchObject({
      current_index: 1,
      current_word: "current",
      flow: { lesson_words: ["done-before", "current", "pending"] },
      payload: { navigation: { action: "next_word", next_word: "pending", next_index: 2, total_count: 3 } },
    });
  });

  it("skips a previously completed active explain card and renders the next pending word", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_explain", current_word: "already-done", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["already-done", "pending", "old-later"] },
      payload: { widget: "lesson", widget_version: 3, mode: "explain", word: "already-done" },
    });
    mocks.active = row(state);
    mocks.getCompletedLessonWords.mockResolvedValueOnce(new Set(["already-done", "old-later"]));
    mocks.getVocabularyItemsByWords.mockResolvedValueOnce([{
      word: "pending", display_word: "pending", status: "unknown", error_layers: [], ipa_us: "/ˈpɛndɪŋ/",
      senses: [{ pos: "adj.", definition_cn: "待处理的" }],
    }]);
    mocks.bootstrap.mockResolvedValue({ action: "resume", widget: "lesson", phase: "lesson_explain" });

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(mocks.generateLesson).toHaveBeenCalledTimes(1);
    expect(payload.state).toMatchObject({
      current_index: 0,
      current_word: "pending",
      flow: { lesson_words: ["pending"] },
      payload: { word: "pending", navigation: { action: "round_complete", total_count: 1 } },
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
      word: words[0]!, display_word: words[0]!, status: "unknown", error_layers: [], ipa_us: "/nekst/", senses: [{ pos: "n.", definition_cn: "下一个词" }],
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

  it("finishes the standalone Lesson round after its one final exercise without generating a wrap-up", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_feedback", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", word: "fixture",
        lesson_profile: "quick_recall", error_focus: null,
        exercise: { activity_type: "exact_cloze", instruction: "填空。", prompt: "An ___ keeps the chairs secure in the hall.", multiline: false },
        feedback: { is_correct: true, user_answer: "fixture", error_layer: "none", message: "正确。", explanation: "答对了。", reveal_answer: false },
        navigation: buildLessonNavigation(["fixture"], 0, "fixture"),
      },
    });
    mocks.active = row(state);
    mocks.bootstrap.mockResolvedValue({ action: "done" });

    const response = await handleWebApiRequest(post({ action: "lesson_next" }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.screen).toBe("done");
    expect(mocks.advanceEvents).toEqual(["lesson_complete"]);
    expect(mocks.finishStudySession).toHaveBeenCalledWith({}, userId, expect.objectContaining({ allowLessonRoundCompletion: true }));
    expect(mocks.generateWrapup).not.toHaveBeenCalled();
    expect(mocks.generateLesson).not.toHaveBeenCalled();
  });

  it("recovers a persisted final Lesson feedback by finishing it instead of generating a wrap-up", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_complete", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", word: "fixture",
        lesson_profile: "quick_recall", error_focus: null,
        exercise: { activity_type: "exact_cloze", instruction: "填空。", prompt: "An ___ keeps the chairs secure in the hall.", multiline: false },
        feedback: { is_correct: true, user_answer: "fixture", error_layer: "none", message: "正确。", explanation: "答对了。", reveal_answer: false },
        navigation: buildLessonNavigation(["fixture"], 0, "fixture"),
      },
    });
    mocks.active = row(state);
    mocks.bootstrap.mockResolvedValue({ action: "done" });

    const response = await handleWebApiRequest(post({ action: "lesson_next" }));

    expect(response.status).toBe(200);
    expect(mocks.advanceEvents).toEqual([]);
    expect(mocks.finishStudySession).toHaveBeenCalledWith({}, userId, expect.objectContaining({ allowLessonRoundCompletion: true }));
    expect(mocks.generateWrapup).not.toHaveBeenCalled();
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
      word, display_word: word, status: "unknown", error_layers: [], senses: [{ pos: "n.", definition_cn: "设施" }],
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
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(mocks.recordPretestResult).toHaveBeenCalledWith(expect.objectContaining({ word: "fixture", result: "known" }));
    expect(mocks.advanceEvents).toEqual(["pretest_result"]);
    expect(mocks.active.state).toMatchObject({ phase: "pretest_result", current_index: 0, current_word: "fixture" });
    expect(payload).toMatchObject({
      state: { phase: "pretest_result", current_index: 0, current_word: "fixture" },
      result: { status: "known", user_answer: "fixture", is_correct: true, error_layer: "none" },
    });
    expect(mocks.gradeSemanticAnswer).not.toHaveBeenCalled();
  });

  it("continues a revealed Pretest result exactly once and completes the final cursor", async () => {
    mocks.active = row(makeStudyState({
      date, widget: "pretest", phase: "pretest_result", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    }));
    const response = await handleWebApiRequest(post({ action: "pretest_continue", current_index: 0 }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(mocks.advanceEvents).toEqual(["pretest_complete"]);
    expect(payload.state).toMatchObject({ phase: "pretest_complete", current_index: 1, current_word: null });

    const retry = await handleWebApiRequest(post({ action: "pretest_continue", current_index: 0 }));
    expect(retry.status).toBe(200);
    expect(mocks.advanceEvents).toEqual(["pretest_complete"]);
    expect(mocks.active.state).toMatchObject({ phase: "pretest_complete", current_index: 1 });
  });

  it("restores the revealed answer and grading when an active Pretest result is resumed", async () => {
    mocks.active = row(makeStudyState({
      date, widget: "pretest", phase: "pretest_result", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }] },
    }));
    mocks.bootstrap.mockResolvedValue({ action: "resume" });
    mocks.getPretestResults.mockResolvedValue([{
      word: "fixture", status: "uncertain", user_answer: "fixtur", is_correct: true, error_layer: "spelling",
    }]);

    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.pretest_result).toEqual({
      word: "fixture", status: "uncertain", user_answer: "fixtur", is_correct: true, error_layer: "spelling",
    });
  });

  it("routes the standalone familiar action to the revision-safe server operation", async () => {
    mocks.active = row(makeStudyState({
      date, widget: "pretest", phase: "pretest_result", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "pretest", items: [{ word: "fixture", meaning_zh: "设施" }, { word: "next", meaning_zh: "下一个" }] },
    }));
    mocks.markPretestFamiliar.mockImplementation(async (input: any) => {
      const state = mocks.active.state;
      if (!(state.flow.pretest_familiar_words ?? []).includes(input.word)) {
        mocks.active = {
          ...mocks.active,
          state: {
            ...state,
            phase: "pretest",
            current_word: "next",
            current_index: 1,
            flow: { ...state.flow, pretest_familiar_words: [input.word] },
          },
          updated_at: `rev-${++mocks.revisionNumber}`,
        };
      }
      return { action: "pretest_mark_familiar", word: input.word, phase: mocks.active.state.phase, current_word: mocks.active.state.current_word, current_index: mocks.active.state.current_index, revision: mocks.active.updated_at };
    });

    const action = { action: "pretest_mark_familiar", word: "fixture", current_index: 0 };
    const response = await handleWebApiRequest(post(action));
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(mocks.markPretestFamiliar).toHaveBeenCalledWith({ ...action, expected_revision: "rev-a" });
    expect(payload.state).toMatchObject({ phase: "pretest", current_index: 1, current_word: "next" });

    const retry = await handleWebApiRequest(post(action));
    expect(retry.status).toBe(200);
    expect(mocks.markPretestFamiliar).toHaveBeenCalledTimes(2);
    expect(mocks.active.state).toMatchObject({ phase: "pretest", current_index: 1, current_word: "next" });
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
    expect(payload.state.flow).toEqual({ relearn_words: [], pretest_familiar_words: [] });
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

  it("generates, restores, grades, and finishes one EN→CN translation consolidation", async () => {
    const prompt = "Although the new policy reduced pressure on small clinics, residents still needed clear information and timely support from public services when unexpected changes disrupted daily routines.";
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_feedback", current_word: "pressure", current_index: 1, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["policy", "pressure"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", word: "pressure",
        exercise: { activity_type: "exact_cloze", instruction: "填空。", prompt: "A ___ in service demand affected local clinics.", multiline: false },
        feedback: { is_correct: true, reveal_answer: false },
        navigation: buildLessonNavigation(["policy", "pressure"], 1, "pressure"),
      },
    });
    mocks.active = row(state);
    mocks.consolidationDecision = {
      consolidation: true,
      consolidation_kind: "translation",
      consolidation_trigger_round: 2,
      consolidation_target_words: ["policy", "pressure"],
      consolidation_status: "pending",
    };
    mocks.generateWrapup.mockResolvedValueOnce({
      activity_type: "translation_en_to_cn",
      instruction: "先找出句子主干，再把整句翻译成自然中文。",
      prompt,
      multiline: true,
    });

    let response = await handleWebApiRequest(post({ action: "lesson_next" }));
    let payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload.state).toMatchObject({
      phase: "lesson_complete",
      payload: {
        mode: "exercise", consolidation: true, consolidation_kind: "translation",
        consolidation_trigger_round: 2, consolidation_target_words: ["policy", "pressure"],
        activity_type: "translation_en_to_cn", multiline: true,
      },
    });
    expect(mocks.generateWrapup).toHaveBeenCalledWith({ words: ["policy", "pressure"] });
    expect(mocks.generateSentenceConsolidation).not.toHaveBeenCalled();

    mocks.bootstrap.mockResolvedValue({ action: "resume", widget: "lesson", phase: "lesson_complete" });
    response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/bootstrap", {
      headers: { authorization: `Bearer ${mocks.token}` },
    }));
    payload = await body(response);
    expect(payload.state.payload.prompt).toBe(prompt);
    expect(mocks.generateWrapup).toHaveBeenCalledTimes(1);

    mocks.gradeWrapupAnswer.mockResolvedValueOnce({ is_correct: true, error_layer: "none", message: "译文准确。", explanation: "主干和逻辑关系清楚。" });
    response = await handleWebApiRequest(post({ action: "consolidation_submit", answer: "主干：residents needed information and support；尽管新政策降低了诊所压力，居民仍需要清晰信息和及时支持。" }, mocks.active.updated_at));
    expect(response.status).toBe(200);
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ activity_type: "translation_en_to_cn", session_id: mocks.active.id }));
    expect(mocks.recordReviewSubmission).not.toHaveBeenCalled();
    expect(mocks.active.state).toMatchObject({ payload: { mode: "feedback", consolidation: true, consolidation_status: "feedback" } });

    mocks.finishStudySession.mockImplementationOnce(async () => {
      mocks.active = null;
      return { ended_at: "2026-09-28T02:00:00.000Z" };
    });
    mocks.bootstrap.mockResolvedValueOnce({ action: "done" });
    response = await handleWebApiRequest(post({ action: "consolidation_finish" }, mocks.active.updated_at));
    expect(response.status).toBe(200);
    await expect(body(response)).resolves.toMatchObject({ screen: "done" });
    expect(mocks.generateWrapup).toHaveBeenCalledTimes(1);
    expect(mocks.recordReviewSubmission).not.toHaveBeenCalled();
  });

  it("generates and semantically grades a short sentence consolidation with one recent target", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_feedback", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", word: "fixture",
        exercise: { activity_type: "exact_cloze", instruction: "填空。", prompt: "An ___ keeps the chairs secure.", multiline: false },
        feedback: { is_correct: true, reveal_answer: false },
        navigation: buildLessonNavigation(["fixture"], 0, "fixture"),
      },
    });
    mocks.active = row(state);
    mocks.consolidationDecision = {
      consolidation: true,
      consolidation_kind: "sentence",
      consolidation_trigger_round: 3,
      consolidation_target_words: ["fixture"],
      consolidation_status: "pending",
    };
    mocks.generateSentenceConsolidation.mockResolvedValueOnce({
      activity_type: "sentence", instruction: "写一个自然英文句子，控制在 15–30 个单词。",
      prompt: "请用 fixture 写一个自然英文句子。", multiline: true,
    });
    let response = await handleWebApiRequest(post({ action: "lesson_next" }));
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(mocks.generateSentenceConsolidation).toHaveBeenCalledWith({ words: ["fixture"] });
    expect(payload.state.payload).toMatchObject({ consolidation: true, consolidation_kind: "sentence", activity_type: "sentence", multiline: true });

    mocks.gradeSemanticAnswer.mockResolvedValueOnce({ is_correct: true, error_layer: "none", message: "句子自然。", explanation: "词义和搭配合适。" });
    response = await handleWebApiRequest(post({ action: "consolidation_submit", answer: "The fixture helped families use the hall after school events." }, mocks.active.updated_at));
    expect(response.status).toBe(200);
    expect(mocks.gradeSemanticAnswer).toHaveBeenCalledWith(expect.objectContaining({
      activity_type: "sentence", target_words: ["fixture"],
    }));
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ activity_type: "sentence" }));
    expect(mocks.recordReviewSubmission).not.toHaveBeenCalled();
  });

  it("keeps a translation consolidation retry on the same stored exercise without another generation", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_complete", current_word: "fixture", current_index: 0, retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "exercise", consolidation: true, consolidation_kind: "translation",
        consolidation_trigger_round: 2, consolidation_target_words: ["fixture", "policy"], consolidation_status: "exercise",
        word: "fixture", activity_type: "translation_en_to_cn", instruction: "Find the main clause and translate.",
        prompt: "Although the new policy reduced pressure on small clinics, residents still needed clear information and timely support from public services when unexpected changes disrupted daily routines.", multiline: true,
      },
    });
    mocks.active = row(state);
    mocks.gradeWrapupAnswer.mockResolvedValueOnce({ is_correct: false, error_layer: "grammar", message: "请调整结构。", explanation: "检查主句结构。", reference_answer: "private answer" });
    let response = await handleWebApiRequest(post({ action: "consolidation_submit", answer: "first attempt" }));
    expect(response.status).toBe(200);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_complete", retry_count: 1, payload: { mode: "feedback", consolidation: true, consolidation_kind: "translation", exercise: { activity_type: "translation_en_to_cn" }, feedback: { reveal_answer: false } } });
    expect(mocks.active.state.payload.feedback).not.toHaveProperty("reference_answer");
    const samePrompt = mocks.active.state.payload.exercise.prompt;
    const retryRevision = mocks.active.updated_at as string;
    response = await handleWebApiRequest(post({ action: "consolidation_retry" }, retryRevision));
    expect(response.status).toBe(200);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_complete", current_word: "fixture", current_index: 0, retry_count: 1, payload: { mode: "exercise", consolidation: true, consolidation_status: "exercise", activity_type: "translation_en_to_cn", prompt: samePrompt } });
    expect(mocks.gradeWrapupAnswer).toHaveBeenCalledTimes(1);
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ activity_type: "translation_en_to_cn" }));
    expect(mocks.generateWrapup).not.toHaveBeenCalled();

    mocks.gradeWrapupAnswer.mockResolvedValueOnce({ is_correct: false, error_layer: "grammar", message: "仍需修改。", explanation: "请检查从句关系。", reference_answer: "revealed answer" });
    const secondRevision = mocks.active.updated_at as string;
    response = await handleWebApiRequest(post({ action: "consolidation_submit", answer: "second attempt" }, secondRevision));
    expect(response.status).toBe(200);
    expect(mocks.active.state).toMatchObject({ phase: "lesson_complete", retry_count: 2, payload: { mode: "feedback", consolidation: true, consolidation_status: "feedback", exercise: { activity_type: "translation_en_to_cn" }, feedback: { reveal_answer: true, reference_answer: "revealed answer" } } });
    expect(mocks.gradeWrapupAnswer).toHaveBeenCalledTimes(2);
    expect(mocks.recordAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not record a second incorrect consolidation grade without a reference expression", async () => {
    const state = makeStudyState({
      date, widget: "lesson", phase: "lesson_complete", current_word: "fixture", current_index: 0, retry_count: 1,
      flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "exercise", consolidation: true, consolidation_kind: "translation",
        consolidation_trigger_round: 2, consolidation_target_words: ["fixture", "policy"], consolidation_status: "exercise",
        word: "fixture", activity_type: "translation_en_to_cn", instruction: "先找主干并翻译。",
        prompt: "Although the new policy reduced pressure on small clinics, residents still needed clear information and timely support from public services when unexpected changes disrupted daily routines.",
        multiline: true,
      },
    });
    mocks.active = row(state);
    mocks.gradeWrapupAnswer.mockResolvedValueOnce({
      is_correct: false, error_layer: "grammar", message: "仍需修改。", explanation: "请检查主句结构。",
    });

    const response = await handleWebApiRequest(post({ action: "consolidation_submit", answer: "second attempt" }));

    expect(response.status).toBe(502);
    await expect(body(response)).resolves.toMatchObject({ error: { code: "DEEPSEEK_INVALID_OUTPUT" } });
    expect(mocks.recordAttempt).not.toHaveBeenCalled();
    expect(mocks.active.state).toEqual(state);
  });

  it("blocks consolidation finish before acceptance and continues bootstrap after reveal", async () => {
    const consolidationFeedback = (isCorrect: boolean, revealAnswer: boolean) => makeStudyState({
      date, widget: "lesson", phase: "lesson_complete", current_word: "fixture", current_index: 0,
      retry_count: revealAnswer ? 2 : 1, flow: { relearn_words: [], lesson_words: ["fixture"] },
      payload: {
        widget: "lesson", widget_version: 3, mode: "feedback", consolidation: true, consolidation_kind: "translation",
        consolidation_trigger_round: 2, consolidation_target_words: ["fixture", "policy"], consolidation_status: "feedback",
        word: "fixture", progress: "周期巩固 · 英译中",
        exercise: { activity_type: "translation_en_to_cn", instruction: "Translate.", prompt: "A sufficiently long sentence about fixture and policy, written for careful translation practice in a public service setting.", multiline: true },
        feedback: { is_correct: isCorrect, user_answer: "my answer", error_layer: isCorrect ? "none" : "grammar", message: "反馈。", explanation: "解释。", reveal_answer: revealAnswer, ...(revealAnswer ? { reference_answer: "answer" } : {}) },
      },
    });
    mocks.active = row(consolidationFeedback(false, false));
    let response = await handleWebApiRequest(post({ action: "consolidation_finish" }));
    expect(response.status).toBe(409);
    expect(mocks.finishStudySession).not.toHaveBeenCalled();

    mocks.active = row(consolidationFeedback(false, true));
    mocks.finishStudySession.mockImplementationOnce(async () => {
      mocks.active = null;
      return { ended_at: "2026-09-27T01:00:00.000Z" };
    });
    mocks.bootstrap.mockResolvedValueOnce({ action: "done" });
    response = await handleWebApiRequest(post({ action: "consolidation_finish" }));
    expect(response.status).toBe(200);
    expect(mocks.finishStudySession).toHaveBeenCalledTimes(1);
    await expect(body(response)).resolves.toMatchObject({ screen: "done" });
  });
});
