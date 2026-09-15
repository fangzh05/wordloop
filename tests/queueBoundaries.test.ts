import { describe, expect, it } from "vitest";
import { assertLessonWordMatches, validatePretestItems } from "../server/tools/renderWidgets.js";
import { sortDailyWordRows } from "../server/services/words.js";
import type { VocabularyItem } from "../server/types.js";

function vocabulary(word: string, overrides: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    word,
    display_word: word,
    status: "new",
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
    ...overrides,
  };
}

function pretestItem(word: string) {
  return {
    word,
    ipa: "/model/",
    part_of_speech: "n.",
    meaning_zh: "模型释义",
    direction: "cn_to_en" as const,
  };
}

describe("canonical queue boundaries", () => {
  it("orders equal positions by import creation rank and word id", () => {
    const rows = [
      { import_id: "b", position: 1, word_id: "b1" },
      { import_id: "a", position: 1, word_id: "a1" },
      { import_id: "a", position: 0, word_id: "a0" },
      { import_id: "b", position: 0, word_id: "b0" },
    ];
    const rank = new Map([["a", 0], ["b", 1]]);
    expect(sortDailyWordRows(rows, rank).map((row) => row.word_id)).toEqual(["a0", "a1", "b0", "b1"]);
    expect(sortDailyWordRows(rows, rank).map((row) => row.word_id)).toEqual(["a0", "a1", "b0", "b1"]);
  });

  it("accepts only the canonical new-word prefix and overlays persisted lexical data", () => {
    const today = [
      vocabulary("alpha", { ipa_us: "/ˈælfə/", senses: [{ pos: "n.", definition_cn: "数据库释义" }] }),
      vocabulary("beta"),
      vocabulary("done", { status: "known" }),
    ];
    const result = validatePretestItems([pretestItem("alpha"), pretestItem("beta")], today);
    expect(result).toMatchObject([
      { word: "alpha", ipa: "/ˈælfə/", part_of_speech: "n.", meaning_zh: "数据库释义" },
      { word: "beta" },
    ]);
    expect(() => validatePretestItems([pretestItem("beta")], today)).toThrow("PRETEST_QUEUE_ORDER_INVALID");
    expect(() => validatePretestItems([pretestItem("alpha"), pretestItem("outside")], today)).toThrow("PRETEST_WORD_NOT_ELIGIBLE");
    expect(() => validatePretestItems([pretestItem("alpha"), pretestItem("alpha")], today)).toThrow("PRETEST_WORD_DUPLICATE");
    expect(() => validatePretestItems([pretestItem("alpha")], [...today, vocabulary("gamma")])).toThrow("PRETEST_ROUND_SIZE_INVALID");
  });

  it("accepts the backend lesson word and rejects a GPT-selected replacement", () => {
    expect(() => assertLessonWordMatches("plantation", "plantation")).not.toThrow();
    expect(() => assertLessonWordMatches("plantation", "planet")).toThrow("LESSON_WORD_MISMATCH");
  });
});
