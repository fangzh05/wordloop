import { describe, expect, it } from "vitest";
import {
  normalizeNextLearningWordResult,
  nextLearningWordResultSchema,
  parseNextLearningWordResult,
} from "../shared/toolContracts.js";
import type { VocabularyItem } from "../server/types.js";
import {
  buildLessonWords,
  buildLessonNavigation,
  filterNewWordsWithoutLessonHistory,
  filterPreviouslyCompletedLessonWords,
  isLessonCursorAtCurrentWord,
  lessonWordAt,
  lessonWordIndex,
  nextLessonWordIndex,
  reconcileLessonQueueAfterCursor,
  recoverLegacyLessonWords,
} from "../server/services/lessonQueue.js";

function item(word: string, status: VocabularyItem["status"] = "unknown"): VocabularyItem {
  return {
    word,
    display_word: word,
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
  };
}

describe("durable Lesson queue invariant", () => {
  it.each([
    ["a", 0, { action: "next_word", next_word: "b", next_index: 1, total_count: 3 }],
    ["b", 1, { action: "next_word", next_word: "c", next_index: 2, total_count: 3 }],
    ["c", 2, { action: "round_complete", next_word: null, next_index: null, total_count: 3 }],
  ] as const)("derives server-owned navigation from %s at index %s", (currentWord, currentIndex, expected) => {
    expect(buildLessonNavigation(["a", "b", "c"], currentIndex, currentWord)).toEqual(expected);
  });

  it("rejects a navigation cursor that does not match the frozen queue", () => {
    expect(() => buildLessonNavigation(["a", "b", "c"], 0, "b")).toThrow("LESSON_CURSOR_MISMATCH");
  });

  it("freezes the queue before status changes and keeps A -> B -> C", () => {
    const lessonWords = buildLessonWords([], [item("A"), item("B"), item("C"), item("D")]);
    const afterAttempts = [
      item("A", "review"),
      item("B", "review"),
      item("C", "unknown"),
      item("D", "uncertain"),
    ];

    expect(lessonWords).toEqual(["a", "b", "c", "d"]);
    expect(buildLessonWords([], afterAttempts)).toEqual(["c", "d"]);
    expect(nextLessonWordIndex(lessonWords, "A", 0)).toBe(1);
    expect(nextLessonWordIndex(lessonWords, "B", 1)).toBe(2);
    expect(lessonWordAt(lessonWords, 2)).toBe("c");
  });

  it("puts every relearn word ahead of the daily unknown/uncertain queue", () => {
    expect(buildLessonWords(
      ["expression", "planet", "shrink"],
      [item("marine", "unknown"), item("thermometer", "uncertain"), item("known", "known")],
    )).toEqual(["expression", "planet", "shrink", "marine", "thermometer"]);
  });

  it("excludes words with a prior formal Lesson even when they remain unknown", () => {
    const completed = new Set(["electrical", "embark"]);
    expect(buildLessonWords([], [
      item("electrical", "unknown"),
      item("embark", "uncertain"),
      item("shallow", "unknown"),
    ], completed)).toEqual(["shallow"]);
  });

  it("keeps a word eligible when its only history is Pretest", () => {
    expect(buildLessonWords([], [item("electrical", "unknown")], new Set())).toEqual(["electrical"]);
  });

  it("keeps a status-new card with prior Lesson history out of the Pretest queue", () => {
    expect(filterNewWordsWithoutLessonHistory([
      item("already-taught", "new"),
      item("untouched", "new"),
      item("already-known", "known"),
    ], new Set(["already-taught"])).map((word) => word.word)).toEqual(["untouched"]);
  });

  it("filters a stored pre-Lesson queue while retaining explicit relearn words", () => {
    expect(filterPreviouslyCompletedLessonWords(
      ["old", "review-failed", "pending"],
      new Set(["old", "review-failed"]),
      ["REVIEW-FAILED"],
    )).toEqual(["review-failed", "pending"]);
  });

  it("keeps a normally completed word excluded after a correct Review", () => {
    const completed = new Set(["embark"]);
    expect(buildLessonWords([], [item("embark", "unknown")], completed)).toEqual([]);
  });

  it("allows one explicit failed-Review relearn despite its completed normal Lesson", () => {
    const completed = new Set(["embark"]);
    expect(buildLessonWords(["EMBARK", "embark"], [item("embark", "unknown")], completed)).toEqual(["embark"]);
  });

  it("prunes previously completed words after the active Lesson cursor", () => {
    expect(reconcileLessonQueueAfterCursor({
      lessonWords: ["done-before", "current", "old-a", "pending", "old-b"],
      currentIndex: 1,
      completedLessonWords: new Set(["done-before", "old-a", "old-b"]),
      relearnWords: [],
    })).toEqual({
      lessonWords: ["done-before", "current", "pending"],
      currentIndex: 1,
      currentWord: "current",
      skippedCurrent: false,
      changed: true,
    });
  });

  it("skips a previously completed explain card when there is a new pending word", () => {
    expect(reconcileLessonQueueAfterCursor({
      lessonWords: ["already-seen", "pending", "also-seen"],
      currentIndex: 0,
      completedLessonWords: new Set(["already-seen", "also-seen"]),
      relearnWords: [],
      skipCompletedCurrent: true,
    })).toEqual({
      lessonWords: ["pending"],
      currentIndex: 0,
      currentWord: "pending",
      skippedCurrent: true,
      changed: true,
    });
  });

  it("preserves explicit relearn words while pruning other completed words", () => {
    expect(reconcileLessonQueueAfterCursor({
      lessonWords: ["current", "failed-review", "normally-seen", "pending"],
      currentIndex: 0,
      completedLessonWords: new Set(["failed-review", "normally-seen"]),
      relearnWords: ["FAILED-REVIEW"],
    })).toMatchObject({
      lessonWords: ["current", "failed-review", "pending"],
      skippedCurrent: false,
    });
  });

  it("lets a current-session familiar override suppress relearn and uncertain new-word routing", () => {
    expect(buildLessonWords(
      ["alleviate", "recur"],
      [item("alleviate", "unknown"), item("recur", "uncertain"), item("other", "unknown")],
      new Set(),
      ["alleviate", "recur"],
    )).toEqual(["other"]);
    expect(buildLessonWords([], [item("alleviate", "known")], new Set(), ["alleviate"])).toEqual([]);
  });

  it("recovers pending relearn words that were before a legacy current cursor", () => {
    const recovered = recoverLegacyLessonWords({
      relearnWords: ["expression", "planet", "shrink"],
      todayWords: [
        item("marine", "review"),
        item("thermometer", "review"),
        item("rectify", "review"),
        item("reed", "review"),
        item("via", "review"),
        item("interpret", "review"),
      ],
      attemptWords: ["expression", "marine", "thermometer", "rectify", "reed", "via", "interpret"],
      currentWord: "interpret",
    });

    expect(recovered).toEqual([
      "expression", "marine", "thermometer", "rectify", "reed", "via", "interpret", "planet", "shrink",
    ]);
    expect(lessonWordIndex(recovered, "interpret")).toBe(6);
    expect(lessonWordAt(recovered, 7)).toBe("planet");
  });

  it("accepts the explicit round_complete result", () => {
    expect(nextLearningWordResultSchema.parse({
      action: "round_complete",
      next_word: null,
      round_complete: true,
    })).toEqual({
      action: "round_complete",
      next_word: null,
      round_complete: true,
    });
  });

  it("normalizes a legacy round_complete result without changing its invariant", () => {
    expect(normalizeNextLearningWordResult({
      next_word: null,
      round_complete: true,
    })).toEqual({
      action: "round_complete",
      next_word: null,
      round_complete: true,
    });
  });

  it("normalizes a legacy next_word result", () => {
    expect(normalizeNextLearningWordResult({
      next_word: { word: "example", source: "test" },
      round_complete: false,
    })).toEqual({
      action: "next_word",
      next_word: { word: "example", source: "test" },
      round_complete: false,
    });
  });

  it("rejects illegal action combinations with the invariant code", () => {
    expect(nextLearningWordResultSchema.safeParse({
      action: "next_word",
      next_word: null,
      round_complete: false,
    }).success).toBe(false);
    expect(nextLearningWordResultSchema.safeParse({
      action: "round_complete",
      next_word: { word: "planet" },
      round_complete: true,
    }).success).toBe(false);
    expect(nextLearningWordResultSchema.safeParse({
      action: "round_complete",
      next_word: null,
      round_complete: false,
    }).success).toBe(false);
    expect(() => parseNextLearningWordResult({
      action: "next_word",
      next_word: null,
      round_complete: false,
    }))
      .toThrow("NEXT_LEARNING_WORD_INVARIANT");
    expect(() => parseNextLearningWordResult({
      action: "round_complete",
      next_word: { word: "planet" },
      round_complete: true,
    }))
      .toThrow("NEXT_LEARNING_WORD_INVARIANT");
    expect(() => parseNextLearningWordResult({
      action: "round_complete",
      next_word: null,
      round_complete: false,
    }))
      .toThrow("NEXT_LEARNING_WORD_INVARIANT");
    expect(() => normalizeNextLearningWordResult({
      next_word: null,
      round_complete: false,
    })).toThrow("NEXT_LEARNING_WORD_INVARIANT");
    expect(() => normalizeNextLearningWordResult({
      next_word: { word: "example" },
      round_complete: true,
    })).toThrow("NEXT_LEARNING_WORD_INVARIANT");
  });

  it("marks only the final frozen word as complete", () => {
    const lessonWords = ["a", "b", "c", "d"];
    expect(isLessonCursorAtCurrentWord(lessonWords, "d", 3)).toBe(true);
    expect(lessonWordAt(lessonWords, nextLessonWordIndex(lessonWords, "d", 3))).toBeNull();
    expect(isLessonCursorAtCurrentWord(lessonWords, "c", 2)).toBe(true);
    expect(lessonWordAt(lessonWords, nextLessonWordIndex(lessonWords, "c", 2))).toBe("d");
  });
});
