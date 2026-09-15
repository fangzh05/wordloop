import { describe, expect, it, vi } from "vitest";
import { findFirstLearningWord, findNextLearningWord, resolveLearningQueueDate } from "../server/services/review.js";
import { makeStudyState } from "../server/services/studySessions.js";
import type { VocabularyItem } from "../server/types.js";

function item(word: string, status: VocabularyItem["status"], mastered = false): VocabularyItem {
  return {
    word,
    display_word: word,
    status,
    source: "test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered,
    next_review_at: null,
    error_layers: [],
    fsrs_stability: 0,
    fsrs_difficulty: 0,
    fsrs_scheduled_days: 0,
    fsrs_state: 0,
  };
}

describe("deterministic daily learning queue", () => {
  const todayWords = [
    item("recur", "known"),
    item("planet", "new"),
    item("navigation", "uncertain"),
  ];

  it("returns the first unfinished word after the current queue position", () => {
    expect(findNextLearningWord(todayWords, "recur")).toMatchObject({
      next_word: { word: "planet" },
      round_complete: false,
    });
    expect(findNextLearningWord(todayWords, "planet")).toMatchObject({
      next_word: { word: "navigation" },
      round_complete: false,
    });
  });

  it("skips completed candidates without restarting the current word", () => {
    const words = [
      item("recur", "unknown"),
      item("planet", "known"),
      item("navigation", "new", true),
      item("signal", "uncertain"),
    ];
    expect(findNextLearningWord(words, "recur")).toMatchObject({ next_word: { word: "signal" }, round_complete: false });
  });

  it("reports the end of the queue instead of selecting a replacement", () => {
    expect(findNextLearningWord(todayWords, "navigation")).toEqual({ next_word: null, round_complete: true });
  });

  it("keeps the canonical queue order when finding the first lesson word", () => {
    expect(findFirstLearningWord([
      item("known", "known"),
      item("first", "new"),
      item("later", "unknown"),
    ])?.word).toBe("first");
  });

  it("can resume a yesterday queue after today's queue no longer contains the cursor", () => {
    const yesterday = [item("A", "known"), item("B", "unknown"), item("C", "new")];
    expect(findNextLearningWord(yesterday, "B")).toMatchObject({ next_word: { word: "C" }, round_complete: false });
  });

  it("resolves a matching active lesson cursor to its saved queue date", async () => {
    const activeState = makeStudyState({
      date: "2026-09-14",
      widget: "lesson",
      phase: "lesson_exercise",
      current_word: "B",
      current_index: 1,
      retry_count: 0,
      payload: { widget: "lesson", word: "B" },
    });
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.is = vi.fn(() => builder);
    builder.order = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.maybeSingle = vi.fn(async () => ({
      data: {
        id: "session",
        user_id: "user",
        started_at: "2026-09-14T00:00:00Z",
        ended_at: null,
        new_words_count: 0,
        review_words_count: 0,
        state: activeState,
        updated_at: "2026-09-14T00:00:00Z",
      },
      error: null,
    }));
    const db = { from: vi.fn(() => builder) };
    await expect(resolveLearningQueueDate("B", db as any, "user")).resolves.toBe("2026-09-14");
  });
});
