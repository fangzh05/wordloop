import { describe, expect, it, vi } from "vitest";
import { buildReviewWidgetItems, reviewWidgetItemFromVocabulary } from "../server/tools/renderWidgets.js";
import type { ReviewVocabularyItem } from "../server/types.js";

function item(word: string): ReviewVocabularyItem {
  return {
    word,
    display_word: word,
    status: "review",
    source: "test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: "2026-09-12T00:00:00Z",
    error_layers: [],
    fsrs_stability: 1,
    fsrs_difficulty: 5,
    fsrs_scheduled_days: 1,
    fsrs_state: 2,
    is_due: true,
    review_kind: "fsrs_due",
    senses: [{ pos: "n.", definition_cn: "含义" }],
  };
}

describe("server-owned review widget payload", () => {
  it("projects persisted vocabulary data and forces the deterministic direction", () => {
    const item: ReviewVocabularyItem = {
      word: "recur",
      display_word: "recur",
      status: "review",
      source: "test",
      consecutive_correct: 0,
      wrong_count: 2,
      mastered: false,
      next_review_at: "2026-09-12T00:00:00Z",
      error_layers: ["meaning"],
      fsrs_stability: 3,
      fsrs_difficulty: 5,
      fsrs_scheduled_days: 2,
      fsrs_state: 2,
      is_due: true,
      review_kind: "both",
      senses: [
        { pos: "v.", definition_cn: "再次发生；复发" },
        { pos: "n.", definition_cn: "复发" },
      ],
    };

    expect(reviewWidgetItemFromVocabulary(item)).toEqual({
      word: "recur",
      meaning_zh: "再次发生；复发；复发",
      part_of_speech: "v.",
      error_layers: ["meaning"],
      is_due: true,
      review_kind: "both",
      next_review_at: "2026-09-12T00:00:00Z",
      direction: "cn_to_en",
    });
  });

  it("skips one lexical-broken card and fills from later valid candidates", () => {
    const broken = { ...item("broken"), senses: "malformed" as unknown as ReviewVocabularyItem["senses"] };
    const valid = Array.from({ length: 5 }, (_, index) => ({
      ...item(`valid-${index}`),
      senses: [{ pos: "n.", definition_cn: "有效含义" }],
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(buildReviewWidgetItems([broken, ...valid], 5).map((entry) => entry.word)).toEqual(valid.map((entry) => entry.word));
      expect(warn).toHaveBeenCalledWith("Review word broken has no persisted meaning; skipped.");
    } finally {
      warn.mockRestore();
    }
  });
});
