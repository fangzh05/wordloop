import { describe, expect, it } from "vitest";
import { calculateProgress } from "../server/services/progress.js";
import type { VocabularyItem, WordStatus } from "../server/types.js";

function item(word: string, status: WordStatus, options: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    word, display_word: word, status, source: "test", consecutive_correct: 0,
    wrong_count: 0, mastered: status === "mastered", next_review_at: null, error_layers: [], ...options,
    fsrs_stability: 0, fsrs_difficulty: 0, fsrs_scheduled_days: 0, fsrs_state: 0,
  };
}

describe("progress calculation", () => {
  it("calculates daily classifications and all-time error book", () => {
    const all = [
      item("a", "known"), item("b", "uncertain"), item("c", "unknown"),
      item("d", "mastered"), item("e", "review", { error_layers: ["collocation"] }),
    ];
    expect(calculateProgress(all.slice(0, 4), all)).toEqual({
      today: { total: 4, known: 1, uncertain: 1, unknown: 1, completed: 4 },
      all_time: { total_words: 5, mastered: 1, learning: 3, error_book: 1 },
      fsrs: { due_now: 0, due_today: 0, tomorrow: 0, due_next_7_days: 0, average_stability: 0 },
      settings: { daily_new_word_limit: 50 },
    });
  });
});
