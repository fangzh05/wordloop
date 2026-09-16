import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VocabularyItem } from "../server/types.js";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(() => "user"),
  getDatabase: vi.fn(() => ({})),
  getActiveStudySession: vi.fn(),
  normalizeLegacyLessonSession: vi.fn(),
  getTodayWords: vi.fn(),
  getUserTimeZone: vi.fn(),
  getVocabularyItemsByWords: vi.fn(),
  getProgress: vi.fn(),
  perf: vi.fn(async (_name: string, run: () => unknown) => run()),
}));

vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
  getDatabase: mocks.getDatabase,
}));
vi.mock("../server/services/studySessions.js", () => ({
  getActiveStudySession: mocks.getActiveStudySession,
  normalizeLegacyLessonSession: mocks.normalizeLegacyLessonSession,
}));
vi.mock("../server/services/words.js", () => ({
  getTodayWords: mocks.getTodayWords,
  getUserTimeZone: mocks.getUserTimeZone,
  getVocabularyItemsByWords: mocks.getVocabularyItemsByWords,
}));
vi.mock("../server/services/progress.js", () => ({ getProgress: mocks.getProgress }));
vi.mock("../server/services/perf.js", () => ({ perf: mocks.perf }));

import { getNextLearningWord } from "../server/services/review.js";

function item(word: string): VocabularyItem {
  return {
    word,
    display_word: word,
    status: "review",
    source: "test",
    consecutive_correct: 1,
    wrong_count: 0,
    mastered: false,
    next_review_at: null,
    error_layers: [],
    fsrs_stability: 1,
    fsrs_difficulty: 5,
    fsrs_scheduled_days: 1,
    fsrs_state: 2,
  };
}

function activeLesson(currentWord: string, currentIndex: number) {
  return {
    id: "session",
    user_id: "user",
    started_at: "2026-09-15T00:00:00.000Z",
    ended_at: null,
    new_words_count: 0,
    review_words_count: 0,
    updated_at: "2026-09-16T00:00:00.000Z",
    state: {
      version: 1 as const,
      date: "2026-09-15",
      widget: "lesson" as const,
      phase: "lesson_feedback" as const,
      current_word: currentWord,
      current_index: currentIndex,
      retry_count: 0,
      flow: { relearn_words: [], lesson_words: ["a", "b", "c", "d"] },
      payload: { widget: "lesson", word: currentWord },
    },
  };
}

describe("frozen Lesson progression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVocabularyItemsByWords.mockImplementation(async (words: string[]) => words.map(item));
  });

  it("returns B after A and C after B even when live status would remove A/B", async () => {
    mocks.getActiveStudySession.mockResolvedValue(activeLesson("a", 0));
    await expect(getNextLearningWord("a")).resolves.toMatchObject({ next_word: { word: "b" }, round_complete: false });

    mocks.getActiveStudySession.mockResolvedValue(activeLesson("b", 1));
    await expect(getNextLearningWord("b")).resolves.toMatchObject({ next_word: { word: "c" }, round_complete: false });
    expect(mocks.getTodayWords).not.toHaveBeenCalled();
    expect(mocks.getVocabularyItemsByWords).toHaveBeenNthCalledWith(1, ["b"], {}, "user");
    expect(mocks.getVocabularyItemsByWords).toHaveBeenNthCalledWith(2, ["c"], {}, "user");
  });

  it("resumes the same frozen queue across a date boundary", async () => {
    mocks.getActiveStudySession.mockResolvedValue(activeLesson("b", 1));
    await expect(getNextLearningWord("b")).resolves.toEqual({ next_word: item("c"), round_complete: false });
    expect(mocks.getTodayWords).not.toHaveBeenCalled();
  });

  it("returns the legal completion result only for the last frozen word", async () => {
    mocks.getActiveStudySession.mockResolvedValue(activeLesson("d", 3));
    await expect(getNextLearningWord("d")).resolves.toEqual({ next_word: null, round_complete: true });
    expect(mocks.getVocabularyItemsByWords).not.toHaveBeenCalled();
  });

  it("fails closed when the request does not match the server cursor", async () => {
    mocks.getActiveStudySession.mockResolvedValue(activeLesson("b", 1));
    await expect(getNextLearningWord("a")).rejects.toThrow("LESSON_CURSOR_MISMATCH");
  });
});
