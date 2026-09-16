import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VocabularyItem } from "../server/types.js";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
  getDatabase: vi.fn(() => ({})),
  getActiveStudySession: vi.fn(),
  ensureTodayQueue: vi.fn(),
  getDueReviewSelection: vi.fn(),
  getFirstSessionLearningWord: vi.fn(),
  findFirstLearningWord: vi.fn(),
  getTodayWords: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
  getDatabase: mocks.getDatabase,
}));
vi.mock("../server/services/studySessions.js", () => ({
  getActiveStudySession: mocks.getActiveStudySession,
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
    mocks.ensureTodayQueue.mockResolvedValue(queue);
    mocks.getDueReviewSelection.mockResolvedValue({ rollingReview: [], oldRandomReview: [] });
    mocks.getFirstSessionLearningWord.mockResolvedValue(null);
    mocks.getTodayWords.mockResolvedValue([]);
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
    mocks.getFirstSessionLearningWord.mockResolvedValue(word(2, "unknown"));

    await expect(getStudyBootstrap()).resolves.toMatchObject({ action: "lesson", word: { word: "word-2" } });
    expect(mocks.ensureTodayQueue).not.toHaveBeenCalled();
    expect(mocks.getDueReviewSelection).not.toHaveBeenCalled();
  });
});
