import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lessonInputSchema, registerRenderTools, reviewWidgetItemFromVocabulary } from "../server/tools/renderWidgets.js";
import type { ReviewVocabularyItem } from "../server/types.js";
import { lessonPayloadSchema } from "../web/src/lesson/LessonWidget.js";

const sessionMocks = vi.hoisted(() => ({
  getActiveStudySession: vi.fn(),
  freezeLessonQueueForSession: vi.fn(),
  normalizeLegacyLessonSession: vi.fn(),
  getStudyDate: vi.fn(),
  makeStudyState: vi.fn(),
  normalizeStudyStateForRead: vi.fn((state: unknown) => state),
  persistStudyState: vi.fn(),
  persistStudyStateIfRevision: vi.fn(),
  recordPlannedSubmission: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock("../server/services/studySessions.js", () => sessionMocks);
vi.mock("../server/services/attempts.js", () => ({
  getCompletedLessonWords: vi.fn(async () => new Set<string>()),
}));

vi.mock("../server/services/review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/review.js")>();
  return {
    ...actual,
    getDueReviewSelection: vi.fn(),
    findFirstLearningWord: vi.fn(),
    findNextLearningWord: vi.fn(),
    getFirstSessionLearningWord: vi.fn(),
    getSessionLearningQueue: vi.fn(),
  };
});
const wordMocks = vi.hoisted(() => ({ getTodayWords: vi.fn() }));
vi.mock("../server/services/words.js", () => wordMocks);
const plannerMocks = vi.hoisted(() => ({ planLessonQueue: vi.fn(), cadenceCandidatePlans: vi.fn(() => ({})) }));
vi.mock("../server/services/exercisePlanner.js", () => plannerMocks);

import { getDueReviewSelection } from "../server/services/review.js";

const mockedGetDueReviewSelection = vi.mocked(getDueReviewSelection);

function reviewItem(word: string, nextReviewAt = "2026-09-12T00:00:00Z"): ReviewVocabularyItem {
  return {
    word,
    display_word: word,
    status: "review",
    source: "test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: nextReviewAt,
    error_layers: [],
    fsrs_stability: 3,
    fsrs_difficulty: 5,
    fsrs_scheduled_days: 2,
    fsrs_state: 2,
    is_due: true,
    review_kind: "fsrs_due",
    senses: [{ pos: "n.", definition_cn: "测试含义" }],
  };
}

describe("review word display fields", () => {
  it("includes every distinct persisted part of speech", () => {
    const item = reviewItem("record");
    item.senses = [
      { pos: "n.", definition_cn: "记录" },
      { pos: "v.", definition_cn: "记录" },
      { pos: "n.", definition_cn: "档案" },
    ];
    expect(reviewWidgetItemFromVocabulary(item)).toMatchObject({
      part_of_speech: "n./v.",
      meaning_zh: "n. 记录；档案　v. 记录",
    });
  });
});

describe("MCP Lesson content validation", () => {
  it("rejects untranslated collocations or derivations on newly rendered cards", () => {
    const lesson = {
      mode: "explain",
      word: "allocate",
      progress: "新词学习 1 / 5",
      ipa: "/ˈæləkeɪt/",
      part_of_speech: "v.",
      meaning_zh: "分配；拨出",
      collocations: ["allocate resources"],
      derivations: ["allocation n."],
      example_en: "The council will allocate funding to improve local transport.",
      note: "allocate 也可表示拨出经费。",
      exercise: {
        activity_type: "exact_cloze",
        instruction: "填入目标词。",
        prompt: "The council will ___ funding to improve local transport.",
        accepted_answers: ["allocate"],
        multiline: false,
      },
    };
    expect(lessonInputSchema.safeParse(lesson).success).toBe(false);
    expect(lessonInputSchema.safeParse({
      ...lesson,
      collocations: ["allocate resources（分配资源）"],
      derivations: ["allocation n.（分配；拨款）"],
    }).success).toBe(true);
  });
});

async function withReviewClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "review-tool-test", version: "1.0.0" });
  registerRenderTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "review-tool-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function payloadOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, unknown>;
}

describe("Review render tool schema compatibility", () => {
  beforeEach(() => {
    mockedGetDueReviewSelection.mockReset();
    sessionMocks.normalizeStudyStateForRead.mockReset().mockImplementation((state: unknown) => state);
    sessionMocks.getActiveStudySession.mockReset().mockResolvedValue(null);
    sessionMocks.freezeLessonQueueForSession.mockReset().mockImplementation(async (active: any) => ({
      ...active,
      state: {
        ...active.state,
        flow: {
          ...active.state.flow,
          lesson_words: [...(active.state.flow?.relearn_words ?? [])],
        },
      },
    }));
    sessionMocks.normalizeLegacyLessonSession.mockReset().mockImplementation(async (active: any) => active);
    sessionMocks.getStudyDate.mockReset().mockResolvedValue("2026-09-16");
    sessionMocks.makeStudyState.mockReset().mockImplementation((input: Record<string, unknown>) => ({
      version: 1,
      flow: { relearn_words: [] },
      ...input,
    }));
    sessionMocks.persistStudyState.mockReset().mockImplementation(async (state: unknown) => ({ state }));
    sessionMocks.persistStudyStateIfRevision.mockReset().mockImplementation(async (state: unknown) => ({ state }));
    wordMocks.getTodayWords.mockReset().mockResolvedValue([]);
    plannerMocks.planLessonQueue.mockReset().mockImplementation(async (words: string[], _relearn: string[], _db: unknown, _user: unknown,
      options?: { preserve_existing_activity?: { index: number; activity_type: string } }) => words.map((word, index) => ({
      plan_version: 1,
      plan_id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
      exercise_id: `00000000-0000-4000-9000-${String(index + 101).padStart(12, "0")}`,
      scope: "lesson",
      word_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      target_word_ids: [`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`],
      target_sense: "测试含义",
      planned_activity_type: options?.preserve_existing_activity?.index === index
        ? options.preserve_existing_activity.activity_type : word === "failed-word" ? "sentence" : "word_recall",
      skill_goal: "提取目标词",
      error_focus: null,
      skill_ids: ["target_sense_retrieval"],
      hint_level: "none",
      estimated_seconds: 20,
      selection_reason: options?.preserve_existing_activity?.index === index
        ? "旧会话兼容：保留当前已显示题目；新规划从下一轮生效。" : "test planner",
    })));
    sessionMocks.recordPlannedSubmission.mockReset().mockImplementation(async (input: any) => ({
      ...input.active,
      state: input.next_state,
      updated_at: "2026-09-16T00:00:01.000Z",
    }));
  });

  it("keeps an in-progress Review snapshot immutable when another card becomes due", async () => {
    const snapshot = {
      widget: "review",
      title: "复习",
      items: [{
        word: "review-a",
        meaning_zh: "测试含义",
        direction: "cn_to_en",
        error_layers: [],
        is_due: true,
        review_kind: "fsrs_due",
        next_review_at: "2026-09-16T00:00:00.000Z",
      }],
    };
    sessionMocks.getActiveStudySession.mockResolvedValue({
      id: "review-a-session",
      updated_at: "rev-a",
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "review",
        phase: "review",
        current_word: "review-a",
        current_index: 0,
        retry_count: 0,
        flow: { relearn_words: [] },
        payload: snapshot,
      },
    });
    mockedGetDueReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("review-b", "2026-09-16T00:05:00.000Z")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const payload = payloadOf(await client.callTool({ name: "render_review_widget_v2", arguments: {} }));
      expect(payload.items).toEqual(snapshot.items);
    });
    expect(mockedGetDueReviewSelection).not.toHaveBeenCalled();
    expect(sessionMocks.persistStudyState).not.toHaveBeenCalled();
  });

  it("creates a new Review snapshot after the previous snapshot completes", async () => {
    const completedPayload = {
      widget: "review",
      title: "复习",
      items: [{
        word: "review-a",
        meaning_zh: "测试含义",
        direction: "cn_to_en",
        error_layers: [],
        is_due: true,
        review_kind: "fsrs_due",
        next_review_at: "2026-09-16T00:00:00.000Z",
      }],
    };
    const completedState = {
      version: 1,
      date: "2026-09-16",
      widget: "review",
      phase: "review_complete",
      current_word: null,
      current_index: 1,
      retry_count: 0,
      flow: { relearn_words: ["failed-word"] },
      payload: completedPayload,
    };
    sessionMocks.getActiveStudySession.mockResolvedValue({
      id: "review-a-session",
      updated_at: "rev-a",
      state: completedState,
    });
    mockedGetDueReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("review-b", "2026-09-16T00:05:00.000Z")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const payload = payloadOf(await client.callTool({ name: "render_review_widget_v2", arguments: {} }));
      expect((payload.items as Array<{ word: string }>).map((item) => item.word)).toEqual(["review-b"]);
    });
    const persisted = sessionMocks.persistStudyState.mock.calls.at(-1)?.[0] as any;
    expect(persisted).toMatchObject({
      widget: "review",
      phase: "review",
      current_word: "review-b",
      current_index: 0,
      flow: { relearn_words: ["failed-word"] },
    });
    expect(completedState.payload.items).toEqual(completedPayload.items);
  });

  it("requires word and feedback for the minimal Lesson feedback tool input", async () => {
    await withReviewClient(async (client) => {
      const missingFeedback = await client.callTool({
        name: "render_lesson_widget",
        arguments: { mode: "feedback", word: "air-conditioning" },
      });
      const missingWord = await client.callTool({
        name: "render_lesson_widget",
        arguments: {
          mode: "feedback",
          feedback: { is_correct: true, user_answer: "air-conditioned", reveal_answer: false },
        },
      });
      expect(missingFeedback.isError).toBe(true);
      expect(missingWord.isError).toBe(true);
    });
  });

  it("resumes a version 3 Lesson feedback card without changing its cursor, exercise, or queue", async () => {
    const lessonWords = ["recur", "plausible", "viable", "thorn", "query", "subtle", "coherent", "constrain", "interpret", "rectify"];
    const exercise = {
      activity_type: "translation_cn_to_en",
      instruction: "用 thorn 翻译短句。",
      prompt: "这个问题仍然是改革中的一根刺。",
      multiline: false,
    };
    const payload = {
      widget: "lesson", phase: "lesson_feedback", mode: "feedback", word: "thorn",
      progress: "4 / 10", current_index: 3, widget_version: 3,
      exercise,
      feedback: { is_correct: false, user_answer: "The issue is thorn.", reveal_answer: false, message: "介词用法需修正。" },
      navigation: { action: "next_word", next_word: "query", next_index: 4, total_count: 10 },
    };
    const session = {
      id: "old-lesson", ended_at: null,
      state: {
        version: 1, date: "2026-09-16", widget: "lesson", phase: "lesson_feedback",
        current_word: "thorn", current_index: 3, retry_count: 0,
        flow: { relearn_words: [], lesson_words: lessonWords }, payload,
      },
    };
    sessionMocks.getActiveStudySession.mockResolvedValue(session);
    await withReviewClient(async (client) => {
      const resumed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(lessonPayloadSchema.safeParse(resumed).success).toBe(true);
      expect(resumed).toMatchObject(payload);
      expect(resumed.exercise).toEqual(exercise);
      const saved = sessionMocks.persistStudyState.mock.calls.at(-1)?.[0] as { payload: Record<string, unknown>; current_word: string; current_index: number; flow: { lesson_words: string[] } } | undefined;
      if (saved) {
        expect(saved).toMatchObject({ current_word: "thorn", current_index: 3, flow: { lesson_words: lessonWords } });
        expect(saved.payload).toMatchObject(payload);
        expect(saved.payload.exercise).toEqual(exercise);
      }
      expect(sessionMocks.normalizeLegacyLessonSession).not.toHaveBeenCalled();
      expect(session.state.current_word).toBe("thorn");
      expect(session.state.current_index).toBe(3);
      expect(session.state.flow.lesson_words).toEqual(lessonWords);
    });
  });

  it("renders the production-shaped legacy exercise as the same current Lesson exercise", async () => {
    const studySessions = await vi.importActual<typeof import("../server/services/studySessions.js")>("../server/services/studySessions.js");
    sessionMocks.normalizeStudyStateForRead.mockImplementation((state) =>
      studySessions.normalizeStudyStateForRead(state as Parameters<typeof studySessions.normalizeStudyStateForRead>[0]));
    const lessonWords = ["vicinity", "lower", "prospect", "thorn", "query", "marital", "pirate", "pit", "quota", "air-conditioning"];
    const exercise = {
      activity_type: "cloze",
      instruction: "用 air-conditioning 词族中的正确形式填空。",
      prompt: "Because the laboratory contains temperature-sensitive equipment, it must remain fully ____ throughout the summer.",
      multiline: false,
    };
    const navigation = { action: "round_complete", next_word: null, next_index: null, total_count: 10 };
    sessionMocks.getActiveStudySession.mockResolvedValue({
      id: "legacy-air-conditioning-session",
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "lesson",
        phase: "lesson_exercise",
        current_word: "air-conditioning",
        current_index: 9,
        retry_count: 0,
        flow: { relearn_words: [], lesson_words: lessonWords },
        payload: {
          widget: "lesson",
          mode: "explain",
          word: "air-conditioning",
          title: "当前词",
          progress: "10 / 10",
          widget_version: 3,
          navigation,
          exercise,
        },
      },
    });

    await withReviewClient(async (client) => {
      const resumed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(resumed).toMatchObject({
        widget: "lesson",
        mode: "exercise",
        phase: "lesson_exercise",
        word: "air-conditioning",
        current_index: 9,
        title: "当前词",
        progress: "10 / 10",
        ...exercise,
        navigation,
      });
      expect(resumed.mode).not.toBe("explain");
      expect(resumed.activity_type).toBe("cloze");
      expect(resumed.prompt).toBe(exercise.prompt);
      expect(sessionMocks.persistStudyState).toHaveBeenCalledOnce();
      const restored = vi.mocked(sessionMocks.persistStudyState).mock.calls.at(-1)?.[0] as { flow: { exercise_plans?: Array<{ planned_activity_type: string; selection_reason: string }> } } | undefined;
      expect(restored?.flow.exercise_plans?.[9]).toMatchObject({
        planned_activity_type: "cloze",
        selection_reason: expect.stringContaining("旧会话兼容"),
      });

      const feedback = payloadOf(await client.callTool({
        name: "render_lesson_widget",
        arguments: {
          mode: "feedback",
          word: "air-conditioning",
          feedback: {
            is_correct: true,
            user_answer: "air-conditioned",
            error_layer: "none",
            message: "正确。",
            reveal_answer: false,
          },
        },
      }));
      expect(feedback).toMatchObject({
        widget: "lesson",
        mode: "feedback",
        phase: "lesson_feedback",
        word: "air-conditioning",
        current_index: 9,
        progress: "10 / 10",
        exercise: { ...exercise },
        feedback: { is_correct: true, user_answer: "air-conditioned", error_layer: "none" },
        navigation,
      });
      const persisted = vi.mocked(sessionMocks.recordPlannedSubmission).mock.calls.at(-1)?.[0] as {
        is_correct: boolean;
        plan: { planned_activity_type: string; selection_reason: string };
        next_state: { phase: string; current_word: string; current_index: number; payload: Record<string, any> };
      } | undefined;
      expect(persisted).toMatchObject({
        is_correct: true,
        plan: { planned_activity_type: "cloze", selection_reason: expect.stringContaining("旧会话兼容") },
        next_state: {
          phase: "lesson_feedback",
          current_word: "air-conditioning",
          current_index: 9,
          payload: { mode: "feedback", word: "air-conditioning", exercise, navigation },
        },
      });
      expect(sessionMocks.persistStudyState).toHaveBeenCalledTimes(1);
    });
  });

  it("accepts legacy items but never returns the fake word", async () => {
    mockedGetDueReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const result = await client.callTool({
        name: "render_review_widget",
        arguments: {
          items: [{ word: "fake-word", meaning_zh: "伪造词", direction: "cn_to_en", error_layers: [] }],
          title: "伪造标题",
        },
      });
      const payload = payloadOf(result);
      expect(JSON.stringify(payload)).not.toContain("fake-word");
      expect((payload.items as Array<{ word: string }>).map((item) => item.word)).toEqual(["backend-word"]);
    });
  });

  it("accepts an empty legacy call", async () => {
    mockedGetDueReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const result = await client.callTool({ name: "render_review_widget", arguments: {} });
      expect(payloadOf(result).widget).toBe("review");
    });
  });

  it("accepts an empty v2 call", async () => {
    mockedGetDueReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const result = await client.callTool({ name: "render_review_widget_v2", arguments: {} });
      expect(payloadOf(result).widget).toBe("review");
    });
  });

  it("keeps the legacy and v2 payloads identical", async () => {
    mockedGetDueReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word"), reviewItem("second-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const legacy = payloadOf(await client.callTool({ name: "render_review_widget", arguments: {} }));
      const v2 = payloadOf(await client.callTool({ name: "render_review_widget_v2", arguments: {} }));
      expect(v2).toEqual(legacy);
      expect(mockedGetDueReviewSelection).toHaveBeenCalledWith(200, {}, "00000000-0000-0000-0000-000000000001");
    });
  });

  it("does not pad a short backend queue with future cards", async () => {
    mockedGetDueReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("due-word"), reviewItem("error-word")],
      oldRandomReview: [reviewItem("future-word", "2099-01-01T00:00:00Z")],
    });

    await withReviewClient(async (client) => {
      const payload = payloadOf(await client.callTool({
        name: "render_review_widget_v2",
        arguments: { current_index: 4 },
      }));
      expect((payload.items as Array<{ word: string }>).map((item) => item.word)).toEqual(["due-word", "error-word"]);
      expect(payload.current_index).toBe(0);
      expect(JSON.stringify(payload)).not.toContain("future-word");
    });
  });

  it("resumes the persisted snapshot and cursor without querying a new queue", async () => {
    const saved = reviewItem("saved-word");
    sessionMocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "review",
        phase: "review",
        current_word: "saved-word",
        current_index: 1,
        retry_count: 0,
        flow: { relearn_words: [] },
        payload: {
          widget: "review",
          items: [{
            word: saved.word,
            meaning_zh: "测试含义",
            part_of_speech: "n.",
            direction: "cn_to_en",
            error_layers: [],
            is_due: true,
            review_kind: "fsrs_due",
            next_review_at: saved.next_review_at,
          }],
          title: "复习",
        },
      },
    });

    await withReviewClient(async (client) => {
      const payload = payloadOf(await client.callTool({ name: "render_review_widget_v2", arguments: { current_index: 0 } }));
      expect(payload).toMatchObject({ widget: "review", phase: "review", current_index: 1, items: [{ word: "saved-word" }] });
      expect(mockedGetDueReviewSelection).not.toHaveBeenCalled();
      expect(sessionMocks.persistStudyState).not.toHaveBeenCalled();
    });
  });

  it("routes a completed pretest into the same session's failed-review lesson queue", async () => {
    const failedWord = reviewItem("failed-word");
    sessionMocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "pretest",
        phase: "pretest_complete",
        current_word: null,
        current_index: 6,
        retry_count: 0,
        flow: { relearn_words: [failedWord.word] },
        payload: { widget: "pretest", items: [] },
      },
    });
    const { getFirstSessionLearningWord } = await import("../server/services/review.js");
    vi.mocked(getFirstSessionLearningWord).mockResolvedValue(failedWord);

    await withReviewClient(async (client) => {
      const result = await client.callTool({
        name: "render_lesson_widget",
        arguments: {
          mode: "explain",
          word: "failed-word",
          ipa: "/feɪld/",
          part_of_speech: "v.",
          meaning_zh: "测试含义",
          collocations: [],
          derivations: [],
          example_en: "A complete example.",
          note: "测试备注",
          exercise: {
            activity_type: "sentence",
            instruction: "造句",
            prompt: "Use the word in a new scene.",
            multiline: false,
          },
        },
      });
      expect(payloadOf(result)).toMatchObject({ widget: "lesson", word: "failed-word" });
      expect(sessionMocks.freezeLessonQueueForSession).toHaveBeenCalled();
    });
  });

  it("rejects a Lesson explain before the pretest is durably complete", async () => {
    sessionMocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "pretest",
        phase: "listen_repeat",
        current_word: "failed-word",
        current_index: 0,
        retry_count: 0,
        flow: { relearn_words: ["failed-word"] },
        payload: { widget: "pretest", items: [{ word: "failed-word" }] },
      },
    });

    await withReviewClient(async (client) => {
      const result = await client.callTool({
        name: "render_lesson_widget",
        arguments: {
          mode: "explain",
          word: "failed-word",
          ipa: "/feɪld/",
          part_of_speech: "v.",
          meaning_zh: "测试含义",
          collocations: [],
          derivations: [],
          example_en: "A complete example.",
          note: "测试备注",
          exercise: {
            activity_type: "sentence",
            instruction: "造句",
            prompt: "Use the word in a new scene.",
            multiline: false,
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "PRETEST_NOT_COMPLETE" }]);
      expect(sessionMocks.persistStudyState).not.toHaveBeenCalled();
    });
  });

  it("accepts the backend-selected Lesson word after pretest_complete and preserves flow", async () => {
    const failedWord = reviewItem("failed-word");
    sessionMocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "pretest",
        phase: "pretest_complete",
        current_word: null,
        current_index: 6,
        retry_count: 0,
        flow: { relearn_words: [failedWord.word] },
        payload: { widget: "pretest", items: [] },
      },
    });
    const { getFirstSessionLearningWord } = await import("../server/services/review.js");
    vi.mocked(getFirstSessionLearningWord).mockResolvedValue(failedWord);

    await withReviewClient(async (client) => {
      const result = await client.callTool({
        name: "render_lesson_widget",
        arguments: {
          mode: "explain",
          word: "failed-word",
          ipa: "/feɪld/",
          part_of_speech: "v.",
          meaning_zh: "测试含义",
          collocations: [],
          derivations: [],
          example_en: "A complete example.",
          note: "测试备注",
          exercise: {
            activity_type: "sentence",
            instruction: "造句",
            prompt: "Use the word in a new scene.",
            multiline: false,
          },
        },
      });
      expect(payloadOf(result)).toMatchObject({ widget: "lesson", phase: "lesson_explain", word: "failed-word" });
      const persisted = vi.mocked(sessionMocks.persistStudyState).mock.calls.at(-1)?.[0] as { flow?: { relearn_words: string[] } };
      expect(persisted.flow).toMatchObject({ relearn_words: ["failed-word"], lesson_words: ["failed-word"] });
    });
  });

  it("projects legacy nested Lesson fields before resuming the Widget", async () => {
    const lessonWords = ["expression", "marine", "thermometer", "rectify", "reed", "via", "interpret", "planet", "shrink"];
    const exercise = {
      activity_type: "translation_cn_to_en",
      instruction: "用 shrink 完成中译英。",
      prompt: "治疗两个月后，影像显示肿瘤明显缩小了。",
      multiline: false,
    };
    sessionMocks.getActiveStudySession.mockResolvedValue({
      id: "lesson-session",
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "lesson",
        phase: "lesson_explain",
        current_word: "shrink",
        current_index: 8,
        retry_count: 0,
        flow: { relearn_words: [], lesson_words: lessonWords },
        payload: {
          widget: "lesson",
          mode: "explain",
          word: "shrink",
          ipa: "ʃrɪŋk",
          part_of_speech: "v./n.",
          meaning_zh: "缩小；收缩；减少；畏缩",
          collocations: ["shrink in size"],
          derivations: ["shrinkage n. 收缩；缩水"],
          example_en: "The tumor began to shrink after treatment.",
          note: "医学语境里 tumor shrinkage = 肿瘤缩小。",
          exercise: { ...exercise, legacy_context: { source: "old-widget" } },
          future_server_field: "keep",
          widget_version: 3,
        },
      },
    });

    await withReviewClient(async (client) => {
      const resumed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(resumed).toMatchObject({
        widget: "lesson",
        mode: "explain",
        phase: "lesson_explain",
        current_index: 8,
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
        future_server_field: "keep",
        exercise,
      });
      expect((resumed.exercise as Record<string, unknown>).legacy_context).toBeUndefined();
      const persisted = vi.mocked(sessionMocks.persistStudyState).mock.calls.at(-1)?.[0] as { payload: Record<string, unknown> } | undefined;
      expect(persisted?.payload.exercise).toEqual(exercise);
    });
  });

  it("persists backend-owned round-complete navigation on final feedback and restores it", async () => {
    const lessonWords = ["expression", "marine", "thermometer", "rectify", "reed", "via", "interpret", "planet", "shrink"];
    const exercise = {
      activity_type: "sentence",
      instruction: "Use the word in a new scene.",
      prompt: "Describe a shrinking sample.",
      multiline: false,
    };
    const feedbackInput = {
      mode: "feedback" as const,
      word: "shrink",
      feedback: {
        is_correct: true,
        user_answer: "The sample shrank.",
        reveal_answer: false,
      },
    };
    const exerciseState = {
      version: 1 as const,
      date: "2026-09-16",
      widget: "lesson" as const,
      phase: "lesson_exercise" as const,
      current_word: "shrink",
      current_index: 8,
      retry_count: 0,
      flow: { relearn_words: [], lesson_words: lessonWords },
      payload: {
        widget: "lesson", mode: "exercise", word: "shrink", progress: "9 / 9",
        lesson_profile: "targeted_relearn", error_focus: "grammar", ...exercise,
      },
    };
    sessionMocks.getActiveStudySession.mockResolvedValue({
      id: "lesson-session",
      user_id: "user",
      started_at: "2026-09-16T00:00:00.000Z",
      ended_at: null,
      new_words_count: 0,
      review_words_count: 0,
      updated_at: "2026-09-16T00:00:00.000Z",
      state: exerciseState,
    });

    await withReviewClient(async (client) => {
      const rendered = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: feedbackInput }));
      expect(rendered).toMatchObject({
        widget: "lesson",
        widget_version: 3,
        phase: "lesson_feedback",
        current_index: 8,
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
      });
      const persisted = vi.mocked(sessionMocks.recordPlannedSubmission).mock.calls.at(-1)?.[0] as { next_state: { payload: Record<string, unknown> } };
      expect(persisted.next_state.payload.navigation).toEqual({ action: "round_complete", next_word: null, next_index: null, total_count: 9 });
      expect(persisted.next_state.payload).toMatchObject({ lesson_profile: "targeted_relearn", error_focus: "grammar" });

      const feedbackState = {
        ...exerciseState,
        phase: "lesson_feedback" as const,
        payload: {
          widget: "lesson",
          mode: "feedback",
          word: "shrink",
          progress: "9 / 9",
          lesson_profile: "targeted_relearn",
          error_focus: "grammar",
          navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
          exercise: { ...exercise, legacy_context: "old" },
          feedback: { ...feedbackInput.feedback, legacy_context: "old" },
        },
      };
      sessionMocks.getActiveStudySession.mockResolvedValue({
        id: "lesson-session",
        user_id: "user",
        started_at: "2026-09-16T00:00:00.000Z",
        ended_at: null,
        new_words_count: 0,
        review_words_count: 0,
        updated_at: "2026-09-16T00:00:00.000Z",
        state: feedbackState,
      });
      const rehydrated = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: feedbackInput }));
      expect(rehydrated).toMatchObject({ mode: "feedback", word: "shrink", progress: "9 / 9" });
      expect(rehydrated.exercise).toEqual(exercise);
      const resumed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(resumed).toMatchObject({
        widget: "lesson",
        widget_version: 3,
        phase: "lesson_feedback",
        lesson_profile: "targeted_relearn",
        error_focus: "grammar",
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
      });
      expect(resumed.exercise).toEqual(exercise);
      expect(resumed.feedback).toEqual(feedbackInput.feedback);

      sessionMocks.getActiveStudySession.mockResolvedValue({
        id: "lesson-session",
        user_id: "user",
        started_at: "2026-09-16T00:00:00.000Z",
        ended_at: null,
        new_words_count: 0,
        review_words_count: 0,
        updated_at: "2026-09-16T00:00:00.000Z",
        state: { ...feedbackState, phase: "lesson_complete" as const },
      });
      const completed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(completed).toMatchObject({
        widget: "lesson",
        widget_version: 3,
        phase: "lesson_complete",
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
      });
    });
  });

  it("renders and resumes a server-marked translation consolidation in the same Lesson tool", async () => {
    const lessonWords = ["expression", "shrink"];
    const activeBase = {
      id: "lesson-session",
      user_id: "user",
      started_at: "2026-09-16T00:00:00.000Z",
      ended_at: null,
      new_words_count: 0,
      review_words_count: 0,
      updated_at: "2026-09-16T00:00:00.000Z",
    };
    const exerciseInput = {
      mode: "exercise" as const,
      consolidation: true as const,
      consolidation_kind: "translation" as const,
      consolidation_trigger_round: 2,
      consolidation_target_words: ["expression", "shrink"],
      word: "shrink",
      progress: "周期巩固 · 英译中",
      activity_type: "translation_en_to_cn",
      instruction: "先标出主干，再翻译。",
      prompt: "Although the expression of public concern began to shrink, local leaders continued to scrutinize the policy, whose careful wording encouraged debate about educational reform across neighboring districts over time.",
      multiline: true,
    };
    const exerciseState = {
      version: 1 as const,
      date: "2026-09-16",
      widget: "lesson" as const,
      phase: "lesson_complete" as const,
      current_word: "shrink",
      current_index: 1,
      retry_count: 0,
      flow: { relearn_words: [], lesson_words: lessonWords },
      payload: {
        widget: "lesson", mode: "feedback", word: "shrink", consolidation: true,
        consolidation_kind: "translation", consolidation_trigger_round: 2,
        consolidation_target_words: ["expression", "shrink"], consolidation_status: "pending",
        feedback: { is_correct: true, reveal_answer: false },
      },
    };
    sessionMocks.getActiveStudySession.mockResolvedValue({ ...activeBase, state: {
      ...exerciseState,
      payload: exerciseState.payload,
    }});

    await withReviewClient(async (client) => {
      const exercise = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: exerciseInput }));
      expect(exercise).toMatchObject({
        widget: "lesson",
        mode: "exercise",
        consolidation: true,
        consolidation_kind: "translation",
        consolidation_status: "exercise",
        phase: "lesson_complete",
        navigation: { action: "round_complete" },
      });

      const consolidationExercise = {
        activity_type: "translation_en_to_cn",
        instruction: "先标出主干，再翻译。",
        prompt: exerciseInput.prompt,
        multiline: true,
      };
      const feedbackInput = {
        mode: "feedback" as const,
        consolidation: true as const,
        consolidation_kind: "translation" as const,
        word: "shrink",
        feedback: {
          is_correct: true,
          user_answer: "主干是 researchers continued monitoring；尽管样本开始缩小，研究人员仍继续监测。",
          reveal_answer: false,
        },
      };
      sessionMocks.getActiveStudySession.mockResolvedValue({
        ...activeBase,
        state: { ...exerciseState, payload: {
          ...exerciseInput, ...consolidationExercise, consolidation_status: "exercise", widget: "lesson",
        } },
      });
      const leakedFirstAnswer = await client.callTool({
        name: "render_lesson_widget",
        arguments: {
          ...feedbackInput,
          feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false, reference_answer: "must not leak" },
        },
      });
      expect(leakedFirstAnswer.isError).toBe(true);
      const feedback = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: feedbackInput }));
      expect(feedback).toMatchObject({ mode: "feedback", consolidation: true, consolidation_kind: "translation", phase: "lesson_complete" });
      expect(feedback.exercise).toEqual(consolidationExercise);
      expect(feedback.progress).toBe("应用巩固 · 长难句英译中");

      sessionMocks.getActiveStudySession.mockResolvedValue({
        ...activeBase,
        state: {
          ...exerciseState,
          payload: feedback,
        },
      });
      const resumed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(resumed).toMatchObject({ mode: "feedback", consolidation: true, consolidation_kind: "translation", phase: "lesson_complete" });
    });
  });
});
