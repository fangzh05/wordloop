import { describe, expect, it } from "vitest";
import { findNextLearningWord } from "../server/services/review.js";
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
});
