import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VocabularyItem } from "../server/types.js";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
  getDatabase: vi.fn(() => ({})),
  getActiveStudySession: vi.fn(),
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
    freezeLessonQueueForSession: mocks.freezeLessonQueueForSession,
    normalizeLegacyLessonSession: mocks.normalizeLegacyLessonSession,
    normalizeStudyStateForRead: mocks.normalizeStudyStateForRead,
  }));
vi.mock("../server/services/dailyQueue.js", () => ({
  ensureTodayQueue: mocks.ensureTodayQueue,
}));
vi.mock("../server/services/review.js", () => ({
  getDueReviewSelection: mocks.getDueReviewSelection,
  getFirstSessionLearningWord: mocks.getFirstSessionLearningWord,
  findFirstLearningWord: mocks.findFirstLearningWord,
}));
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveStudySession.mockResolvedValue(null);
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
        phase: "explain",
        current_word: "carry",
        current_index: 0,
        retry_count: 0,
        payload: {},
      },
    });

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "resume", widget: "lesson" });
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
    expect(mocks.getTodayWords).not.toHaveBeenCalled();
  });

  it("does not gate a new study flow on active errors whose cards are not due", async () => {
    mocks.getTodayWords.mockResolvedValue([word(1, "known")]);

    await expect(getStudyBootstrap()).resolves.toEqual({ action: "done" });
    expect(mocks.getDueReviewSelection).toHaveBeenCalledOnce();
  });

  it("continues a completed Review session into its re-learn queue", async () => {
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
        payload: { widget: "review", items: [] },
      },
    });
    mocks.getTodayWords.mockResolvedValue([word(1, "known")]);
    await expect(getStudyBootstrap()).resolves.toMatchObject({ action: "lesson", word: { word: "failed-word" } });
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
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
});
