import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerRenderTools } from "../server/tools/renderWidgets.js";
import type { ReviewVocabularyItem } from "../server/types.js";

const sessionMocks = vi.hoisted(() => ({
  getActiveStudySession: vi.fn(),
  freezeLessonQueueForSession: vi.fn(),
  normalizeLegacyLessonSession: vi.fn(),
  getStudyDate: vi.fn(),
  makeStudyState: vi.fn(),
  normalizeStudyStateForRead: vi.fn((state: unknown) => state),
  persistStudyState: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock("../server/services/studySessions.js", () => sessionMocks);

vi.mock("../server/services/review.js", () => ({
  getDueReviewSelection: vi.fn(),
  findFirstLearningWord: vi.fn(),
  findNextLearningWord: vi.fn(),
  getFirstSessionLearningWord: vi.fn(),
  getSessionLearningQueue: vi.fn(),
}));
const wordMocks = vi.hoisted(() => ({ getTodayWords: vi.fn() }));
vi.mock("../server/services/words.js", () => wordMocks);

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
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

describe("Review render tool schema compatibility", () => {
  beforeEach(() => {
    mockedGetDueReviewSelection.mockReset();
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
    wordMocks.getTodayWords.mockReset().mockResolvedValue([]);
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
            multiline: true,
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
            multiline: true,
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
            multiline: true,
          },
        },
      });
      expect(payloadOf(result)).toMatchObject({ widget: "lesson", phase: "lesson_explain", word: "failed-word" });
      const persisted = vi.mocked(sessionMocks.persistStudyState).mock.calls.at(-1)?.[0] as { flow?: { relearn_words: string[] } };
      expect(persisted.flow).toEqual({ relearn_words: ["failed-word"], lesson_words: ["failed-word"] });
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
    const feedbackInput = {
      mode: "feedback" as const,
      word: "shrink",
      progress: "9 / 9",
      exercise: {
        activity_type: "sentence",
        instruction: "Use the word in a new scene.",
        prompt: "Describe a shrinking sample.",
        multiline: false,
      },
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
      payload: { widget: "lesson", mode: "exercise", word: "shrink" },
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
      const persisted = vi.mocked(sessionMocks.persistStudyState).mock.calls.at(-1)?.[0] as { payload: Record<string, unknown> };
      expect(persisted.payload.navigation).toEqual({ action: "round_complete", next_word: null, next_index: null, total_count: 9 });

      const feedbackState = {
        ...exerciseState,
        phase: "lesson_feedback" as const,
        payload: {
          ...feedbackInput,
          widget: "lesson",
          navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
          exercise: { ...feedbackInput.exercise, legacy_context: "old" },
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
      const resumed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(resumed).toMatchObject({
        widget: "lesson",
        widget_version: 3,
        phase: "lesson_feedback",
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
      });
      expect(resumed.exercise).toEqual(feedbackInput.exercise);
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

  it("renders and resumes the durable long-sentence wrap-up in the same Lesson tool", async () => {
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
      wrapup: true as const,
      word: "shrink",
      progress: "长难句收尾",
      activity_type: "sentence",
      instruction: "先标出主干，再翻译。",
      prompt: "Although the sample began to shrink, the researchers continued monitoring it.",
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
      payload: { widget: "lesson", ...exerciseInput },
    };
    sessionMocks.getActiveStudySession.mockResolvedValue({ ...activeBase, state: {
      ...exerciseState,
      payload: { widget: "lesson", mode: "feedback", word: "shrink" },
    }});

    await withReviewClient(async (client) => {
      const exercise = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: exerciseInput }));
      expect(exercise).toMatchObject({
        widget: "lesson",
        mode: "exercise",
        wrapup: true,
        phase: "lesson_complete",
        navigation: { action: "round_complete" },
      });

      const feedbackInput = {
        mode: "feedback" as const,
        wrapup: true as const,
        word: "shrink",
        progress: "长难句收尾",
        exercise: {
          activity_type: "sentence",
          instruction: "先标出主干，再翻译。",
          prompt: exerciseInput.prompt,
          multiline: true,
        },
        feedback: {
          is_correct: true,
          user_answer: "主干是 researchers continued monitoring；尽管样本开始缩小，研究人员仍继续监测。",
          reveal_answer: false,
        },
      };
      sessionMocks.getActiveStudySession.mockResolvedValue({
        ...activeBase,
        state: { ...exerciseState, payload: { ...exerciseInput, widget: "lesson" } },
      });
      const feedback = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: feedbackInput }));
      expect(feedback).toMatchObject({ mode: "feedback", wrapup: true, phase: "lesson_complete" });

      sessionMocks.getActiveStudySession.mockResolvedValue({
        ...activeBase,
        state: {
          ...exerciseState,
          payload: {
            ...feedbackInput,
            widget: "lesson",
            navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 2 },
          },
        },
      });
      const resumed = payloadOf(await client.callTool({ name: "render_lesson_widget", arguments: { resume: true } }));
      expect(resumed).toMatchObject({ mode: "feedback", wrapup: true, phase: "lesson_complete" });
    });
  });
});
