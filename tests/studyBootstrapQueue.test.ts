// These tests isolate the original flow; budget admission is exercised in learningBudget.test.ts.
vi.mock("../server/services/learningBudget.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/services/learningBudget.js")>(),
  getLearningBudget: vi.fn(async () => ({ date:"2026-10-02",daily_minutes:45,remaining_seconds:2700,estimated_used_seconds:0,due_count:0,overdue_count:0,new_word_cap:50,effective_new_limit:50,enabled:true,forecast:[] })),
  reserveLearningBudget: vi.fn(async () => undefined),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VocabularyItem } from "../server/types.js";

const completedLessonMocks = vi.hoisted(() => ({
  getCompletedLessonWords: vi.fn(async () => new Set<string>()),
}));
vi.mock("../server/services/attempts.js", () => completedLessonMocks);

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
  getDatabase: vi.fn(() => ({})),
  getActiveStudySession: vi.fn(),
  finishStudySession: vi.fn(),
  freezeLessonQueueForSession: vi.fn(),
  normalizeLegacyLessonSession: vi.fn(),
  normalizeStudyStateForRead: vi.fn((state: any) => {
    const items = state?.payload?.items;
    return state?.widget === "pretest"
      && state?.phase === "listen_recall"
      && Array.isArray(items)
      && state.current_index === items.length
      ? { ...state, phase: "pretest_complete", current_word: null }
      : state;
  }),
  ensureTodayQueue: vi.fn(),
  getDueReviewSelection: vi.fn(),
  getFirstSessionLearningWord: vi.fn(),
  findFirstLearningWord: vi.fn(),
  getTodayWords: vi.fn(),
  getVocabularyItemsByWords: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
  getDatabase: mocks.getDatabase,
}));
  vi.mock("../server/services/studySessions.js", () => ({
    getActiveStudySession: mocks.getActiveStudySession,
    finishStudySession: mocks.finishStudySession,
    freezeLessonQueueForSession: mocks.freezeLessonQueueForSession,
    normalizeLegacyLessonSession: mocks.normalizeLegacyLessonSession,
    normalizeStudyStateForRead: mocks.normalizeStudyStateForRead,
  }));
vi.mock("../server/services/dailyQueue.js", () => ({
  ensureTodayQueue: mocks.ensureTodayQueue,
}));
vi.mock("../server/services/review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/review.js")>();
  return {
    ...actual,
    getDueReviewSelection: mocks.getDueReviewSelection,
    getFirstSessionLearningWord: mocks.getFirstSessionLearningWord,
    findFirstLearningWord: mocks.findFirstLearningWord,
  };
});
  vi.mock("../server/services/words.js", () => ({
    getTodayWords: mocks.getTodayWords,
    getVocabularyItemsByWords: mocks.getVocabularyItemsByWords,
  }));

import { getStudyBootstrap } from "../server/services/studyBootstrap.js";

const queue = { date: "2026-09-16", prepared: 50, added: 50 };

function word(index: number, status: VocabularyItem["status"] = "new"): VocabularyItem {
  return {
    word: `word-${index}`,
    display_word: `word-${index}`,
    status,
    source: "test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: null,
    error_layers: [],
    fsrs_stability: 0,
    fsrs_difficulty: 0,
    fsrs_scheduled_days: 0,
    fsrs_state: 0,
    senses: [],
  };
}

describe("study bootstrap daily queue invariant", () => {
  it("refreshes the production-shaped 7/106 cursor without replacing or extending its snapshot", async () => {
    const state = { version: 1, date: "2026-10-04", widget: "review", phase: "review", current_word: "word-7", current_index: 7,
      retry_count: 0, flow: { relearn_words: Array.from({ length: 70 }, (_, i) => `failed-${i}`) },
      payload: { widget: "review", items: Array.from({ length: 106 }, (_, i) => ({ word: `word-${i}` })) } };
    const active = { state, updated_at: "revision", review_words_count: 139 } as any;
    const before = JSON.stringify(active);
    expect(await getStudyBootstrap({ activeSession: active, expectedRevision: "revision", startNewRound: false })).toEqual({ action: "resume", widget: "review", phase: "review" });
    expect(JSON.stringify(active)).toBe(before);
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
  });
  it("does not start a fresh round on refresh, but an explicit start can query due cards", async () => {
    expect(await getStudyBootstrap({ activeSession: null, expectedRevision: null, startNewRound: false })).toEqual({ action: "done" });
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
    mocks.getDueReviewSelection.mockResolvedValue({ rollingReview: [word(1, "review")], oldRandomReview: [] });
    expect(await getStudyBootstrap({ activeSession: null, expectedRevision: null, startNewRound: true })).toEqual({ action: "review", count: 1 });
  });
  it("hands a completed cross-day snapshot to today's Pretest while preserving all old progress", async () => {
    const active = { updated_at: "revision", review_words_count: 238, state: { version: 1, date: "2026-10-04", widget: "review", phase: "review_complete", current_index: 106, current_word: null,
      retry_count: 0, flow: { relearn_words: Array.from({ length: 70 }, (_, i) => `failed-${i}`) }, payload: { widget: "review", items: Array.from({ length: 106 }, (_, i) => ({ word: `word-${i}` })) } } } as any;
    mocks.ensureTodayQueue.mockResolvedValue({ ...queue, date: "2026-10-05" });
    mocks.getTodayWords.mockResolvedValue([word(1, "new")]);
    const before = JSON.stringify(active);
    expect(await getStudyBootstrap({ activeSession: active, expectedRevision: "revision", startNewRound: true, deferLessonQueueFreeze: true })).toMatchObject({ action: "pretest", date: "2026-10-05" });
    expect(mocks.getTodayWords).toHaveBeenCalledWith("2026-10-05", expect.anything(), expect.any(String));
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
    expect(JSON.stringify(active)).toBe(before);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeStudyStateForRead.mockReset().mockImplementation((state: any) => {
      const items = state?.payload?.items;
      return state?.widget === "pretest"
        && state?.phase === "listen_recall"
        && Array.isArray(items)
        && state.current_index === items.length
        ? { ...state, phase: "pretest_complete", current_word: null }
        : state;
    });
    mocks.getActiveStudySession.mockResolvedValue(null);
    mocks.finishStudySession.mockResolvedValue(null);
    mocks.freezeLessonQueueForSession.mockImplementation(async (active: any, todayWords: VocabularyItem[]) => ({
      ...active,
      state: {
        ...active.state,
        flow: {
          ...active.state.flow,
          lesson_words: [
            ...new Set([
              ...(active.state.flow?.relearn_words ?? []),
              ...todayWords.filter((entry) => entry.status === "unknown" || entry.status === "uncertain").map((entry) => entry.word),
            ]),
          ],
        },
      },
    }));
    mocks.normalizeLegacyLessonSession.mockImplementation(async (active: any) => active);
    mocks.ensureTodayQueue.mockResolvedValue(queue);
    mocks.getDueReviewSelection.mockResolvedValue({ rollingReview: [], oldRandomReview: [] });
    mocks.getFirstSessionLearningWord.mockResolvedValue(null);
    mocks.getTodayWords.mockResolvedValue([]);
    mocks.getVocabularyItemsByWords.mockImplementation(async (words: string[]) => words.map((entry) => ({ ...word(2, "unknown"), word: entry, display_word: entry })));
    mocks.findFirstLearningWord.mockReturnValue(null);
  });

  it("prepares the new-day queue before returning the pretest batch", async () => {
    mocks.getTodayWords.mockResolvedValue(Array.from({ length: 50 }, (_, index) => word(index)));

    const result = await getStudyBootstrap();

    expect(result).toMatchObject({ action: "pretest" });
    expect((result as { action: "pretest"; words: VocabularyItem[] }).words).toHaveLength(6);
    expect(mocks.ensureTodayQueue).toHaveBeenCalledOnce();
    expect(mocks.getDueReviewSelection).toHaveBeenCalledOnce();
    expect(mocks.ensureTodayQueue.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.getDueReviewSelection.mock.invocationCallOrder[0]!);
    expect(mocks.getTodayWords).toHaveBeenCalledWith(queue.date, {}, expect.any(String));
  });

  it("prepares today's queue before short-circuiting to review", async () => {
    mocks.getDueReviewSelection.mockResolvedValue({
      rollingReview: [word(1, "review")],
      oldRandomReview: [],
    });

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "review", count: 1 });
    expect(mocks.ensureTodayQueue).toHaveBeenCalledOnce();
    expect(mocks.getTodayWords).not.toHaveBeenCalled();
    expect(mocks.ensureTodayQueue.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.getDueReviewSelection.mock.invocationCallOrder[0]!);
  });

  it("returns an active resume before any daily queue or review work", async () => {
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-15",
        widget: "lesson",
        phase: "lesson_explain",
        current_word: "carry",
        current_index: 0,
        retry_count: 0,
        payload: {},
      },
    });

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "resume", widget: "lesson", phase: "lesson_explain" });
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
    expect(mocks.getTodayWords).not.toHaveBeenCalled();
  });

  it("does not gate a new study flow on active errors whose cards are not due", async () => {
    mocks.getTodayWords.mockResolvedValue([word(1, "known")]);

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "done" });
    expect(mocks.getDueReviewSelection).toHaveBeenCalledOnce();
  });

  it("continues a completed Review session into its re-learn queue even when other cards are due", async () => {
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "review",
        phase: "review_complete",
        current_word: null,
        current_index: 2,
        retry_count: 0,
        flow: { relearn_words: ["failed-word"] },
        payload: { widget: "review", items: [{ word: "review-a" }, { word: "review-b" }] },
      },
    });
    mocks.getTodayWords.mockResolvedValue([word(1, "known")]);
    await expect(getStudyBootstrap()).resolves.toMatchObject({ action: "lesson", word: { word: "failed-word" } });
    expect(mocks.ensureTodayQueue).toHaveBeenCalledOnce();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
  });

  it("hands off without appending cards that became due during the completed snapshot", async () => {
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "review",
        phase: "review_complete",
        current_word: null,
        current_index: 1,
        retry_count: 0,
        flow: { relearn_words: [] },
        payload: { widget: "review", items: [{ word: "review-a" }] },
      },
    });
    const newlyDue = { ...word(2, "review"), word: "review-b", display_word: "review-b", next_review_at: "2026-09-16T04:16:00.000Z" };
    mocks.getDueReviewSelection.mockResolvedValue({ rollingReview: [newlyDue], oldRandomReview: [] });

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "done" });
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
    expect(mocks.getTodayWords).toHaveBeenCalledOnce();
  });

  it("does not reopen a completed Review card whose due timestamp never advanced", async () => {
    const previousDue = "2026-09-16T04:00:00.000Z";
    const previous = { ...word(1, "review"), word: "review-a", display_word: "review-a", next_review_at: previousDue };
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "review",
        phase: "review_complete",
        current_word: null,
        current_index: 1,
        retry_count: 0,
        flow: { relearn_words: [] },
        payload: { widget: "review", items: [{ word: "review-a", next_review_at: previousDue }] },
      },
    });
    mocks.getDueReviewSelection.mockResolvedValue({ rollingReview: [previous], oldRandomReview: [] });
    mocks.getTodayWords.mockResolvedValue([word(3, "known")]);

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "done" });
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
    expect(mocks.getTodayWords).toHaveBeenCalledOnce();
  });

  it("defers a rescheduled due card until the user starts another round", async () => {
    const oldDue = "2026-09-16T04:00:00.000Z";
    const rescheduledDue = "2026-09-16T04:10:00.000Z";
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "review",
        phase: "review_complete",
        current_word: null,
        current_index: 1,
        retry_count: 0,
        flow: { relearn_words: [] },
        payload: { widget: "review", items: [{ word: "review-a", next_review_at: oldDue }] },
      },
    });
    mocks.getDueReviewSelection.mockResolvedValue({
      rollingReview: [{ ...word(1, "review"), word: "review-a", display_word: "review-a", next_review_at: rescheduledDue }],
      oldRandomReview: [],
    });

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "done" });
    expect(mocks.getTodayWords).toHaveBeenCalledOnce();
  });

  it("keeps an active Review snapshot immutable even if another card would be due now", async () => {
    const state = {
      version: 1 as const,
      date: "2026-09-16",
      widget: "review" as const,
      phase: "review" as const,
      current_word: "review-a",
      current_index: 0,
      retry_count: 0,
      flow: { relearn_words: [] },
      payload: { widget: "review", items: [{ word: "review-a" }] },
    };
    mocks.getActiveStudySession.mockResolvedValue({ state });
    mocks.getDueReviewSelection.mockResolvedValue({
      rollingReview: [{ ...word(2, "review"), word: "review-b", display_word: "review-b" }],
      oldRandomReview: [],
    });

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "resume", widget: "review", phase: "review" });
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
    expect(state.payload.items).toEqual([{ word: "review-a" }]);
  });

  it("continues a completed pretest into the session learning queue before new words", async () => {
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "pretest",
        phase: "pretest_complete",
        current_word: null,
        current_index: 6,
        retry_count: 0,
        flow: { relearn_words: ["failed-word"] },
        payload: { widget: "pretest", items: [] },
      },
    });
    mocks.getTodayWords.mockResolvedValue([word(1, "unknown"), word(2, "uncertain"), word(3, "new")]);
    await expect(getStudyBootstrap()).resolves.toMatchObject({ action: "lesson", word: { word: "failed-word" } });
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
  });

  it("starts the next new-word pretest only after a completed batch has no learning word", async () => {
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "pretest",
        phase: "pretest_complete",
        current_word: null,
        current_index: 6,
        retry_count: 0,
        flow: { relearn_words: [] },
        payload: { widget: "pretest", items: [] },
      },
    });
    mocks.getTodayWords.mockResolvedValue([
      word(1, "known"),
      word(2, "new"),
      word(3, "new"),
      word(4, "new"),
      word(5, "new"),
      word(6, "new"),
      word(7, "new"),
    ]);
    const result = await getStudyBootstrap();
    expect(result).toMatchObject({ action: "pretest" });
    expect((result as { action: "pretest"; words: VocabularyItem[] }).words.map((entry) => entry.word))
      .toEqual(["word-2", "word-3", "word-4", "word-5", "word-6", "word-7"]);
  });

  it("treats the legacy listen_recall item-count cursor as completed pretest", async () => {
    mocks.getActiveStudySession.mockResolvedValue({
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "pretest",
        phase: "listen_recall",
        current_word: null,
        current_index: 2,
        retry_count: 0,
        flow: { relearn_words: ["failed-word"] },
        payload: { widget: "pretest", items: [{ word: "first" }, { word: "second" }] },
      },
    });
    mocks.getTodayWords.mockResolvedValue([word(1, "known")]);
    await expect(getStudyBootstrap()).resolves.toMatchObject({ action: "lesson", word: { word: "failed-word" } });
    expect(mocks.normalizeStudyStateForRead).toHaveBeenCalled();
  });

  it("resumes a legacy Lesson exercise phase after payload compatibility normalization", async () => {
    const studySessions = await vi.importActual<typeof import("../server/services/studySessions.js")>("../server/services/studySessions.js");
    mocks.normalizeStudyStateForRead.mockImplementation(studySessions.normalizeStudyStateForRead);
    const state = {
      version: 1 as const,
      date: queue.date,
      widget: "lesson" as const,
      phase: "lesson_exercise" as const,
      current_word: "air-conditioning",
      current_index: 9,
      retry_count: 0,
      flow: {
        relearn_words: [],
        lesson_words: ["vicinity", "lower", "prospect", "thorn", "query", "marital", "pirate", "pit", "quota", "air-conditioning"],
      },
      payload: {
        widget: "lesson",
        mode: "explain",
        word: "air-conditioning",
        exercise: {
          activity_type: "cloze",
          instruction: "用 air-conditioning 词族中的正确形式填空。",
          prompt: "Because the laboratory contains temperature-sensitive equipment, it must remain fully ____ throughout the summer.",
          multiline: false,
        },
      },
    };
    mocks.getActiveStudySession.mockResolvedValue({ state });

    await expect(getStudyBootstrap()).resolves.toEqual({
      action: "resume",
      widget: "lesson",
      phase: "lesson_exercise",
    });
    expect(studySessions.normalizeStudyStateForRead(state)).toMatchObject({
      current_word: "air-conditioning",
      current_index: 9,
      payload: { mode: "exercise", word: "air-conditioning", activity_type: "cloze" },
    });
  });

  it("keeps a completed Lesson open for its backend cadence handoff", async () => {
    const completed = {
      id: "completed-session",
      ended_at: null as string | null,
      state: {
        version: 1,
        date: "2026-09-16",
        widget: "lesson",
        phase: "lesson_complete",
        current_word: "shrink",
        current_index: 8,
        retry_count: 0,
        flow: { relearn_words: ["expression"], lesson_words: ["expression", "shrink"] },
        payload: { widget: "lesson", mode: "feedback", word: "shrink" },
      },
    };
    mocks.getActiveStudySession.mockResolvedValue(completed);
    await expect(getStudyBootstrap()).resolves.toEqual({ action: "resume", widget: "lesson", phase: "lesson_complete" });
    expect(completed.ended_at).toBeNull();
    expect(mocks.finishStudySession).not.toHaveBeenCalled();
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
  });

  it("keeps repeated bootstrap calls on the same completed Lesson state", async () => {
    mocks.getActiveStudySession
      .mockResolvedValueOnce({
        id: "completed-session",
        ended_at: null as string | null,
        state: {
          version: 1,
          date: queue.date,
          widget: "lesson",
          phase: "lesson_complete",
          current_word: "word-8",
          current_index: 8,
          retry_count: 0,
          flow: { relearn_words: ["word-1"], lesson_words: Array.from({ length: 9 }, (_, index) => `word-${index}`) },
          payload: { widget: "lesson", mode: "feedback", word: "word-8" },
        },
      })
      .mockResolvedValueOnce({
        state: {
          version: 1,
          date: queue.date,
          widget: "lesson",
          phase: "lesson_complete",
          current_word: "word-8",
          current_index: 8,
          retry_count: 0,
          flow: { relearn_words: ["word-1"], lesson_words: Array.from({ length: 9 }, (_, index) => `word-${index}`) },
          payload: { widget: "lesson", mode: "feedback", word: "word-8" },
        },
      });

    const first = await getStudyBootstrap();
    const next = await getStudyBootstrap();

    expect(first).toEqual({ action: "resume", widget: "lesson", phase: "lesson_complete" });
    expect(next).toEqual({ action: "resume", widget: "lesson", phase: "lesson_complete" });
    expect(mocks.finishStudySession).not.toHaveBeenCalled();
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
  });

  it("keeps the final Lesson handoff even when the daily flow is empty", async () => {
    const completed = {
      id: "completed-session",
      ended_at: null as string | null,
      state: {
        version: 1,
        date: queue.date,
        widget: "lesson",
        phase: "lesson_complete",
        current_word: "word-8",
        current_index: 8,
        retry_count: 0,
        flow: { relearn_words: [], lesson_words: Array.from({ length: 9 }, (_, index) => `word-${index}`) },
        payload: { widget: "lesson", mode: "feedback", word: "word-8" },
      },
    };
    mocks.getActiveStudySession.mockResolvedValueOnce(completed);
    await expect(getStudyBootstrap()).resolves.toEqual({ action: "resume", widget: "lesson", phase: "lesson_complete" });
    expect(completed.ended_at).toBeNull();
    expect(mocks.finishStudySession).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
  });

  it("does not let due review preempt an unfinished final Lesson handoff", async () => {
    const completed = {
      id: "completed-session",
      ended_at: null as string | null,
      state: {
        version: 1,
        date: queue.date,
        widget: "lesson",
        phase: "lesson_complete",
        current_word: "word-8",
        current_index: 8,
        retry_count: 0,
        flow: { relearn_words: [], lesson_words: ["word-8"] },
        payload: { widget: "lesson", mode: "feedback", word: "word-8" },
      },
    };
    mocks.getActiveStudySession.mockResolvedValue(completed);
    mocks.getDueReviewSelection.mockResolvedValue({ rollingReview: [word(99, "review")], oldRandomReview: [] });

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "resume", widget: "lesson", phase: "lesson_complete" });
    expect(completed.ended_at).toBeNull();
    expect(mocks.finishStudySession).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
  });
});
