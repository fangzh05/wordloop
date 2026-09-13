import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectReviewWords } from "../server/services/review.js";
import type { VocabularyItem } from "../server/types.js";

const sql = readFileSync(new URL("../supabase/migrations/202609130002_fsrs_shanbay.sql", import.meta.url), "utf8");

describe("attempt/review transaction boundary", () => {
  const item = (word: string, due: string | null, mastered = false): VocabularyItem => ({
    word, display_word: word, status: mastered ? "mastered" : "review", source: "test",
    consecutive_correct: 0, wrong_count: 0, mastered, next_review_at: due, error_layers: [],
    fsrs_stability: 1, fsrs_difficulty: 5, fsrs_scheduled_days: 1, fsrs_state: 2,
  });

  it("includes mastered due cards, excludes future cards, and adds no random filler", () => {
    const selected = selectReviewWords([
      item("mastered-due", "2026-09-12T00:00:00Z", true),
      item("future", "2026-09-20T00:00:00Z"),
    ], 5, new Date("2026-09-13T00:00:00Z"));
    expect(selected.map((word) => word.word)).toEqual(["mastered-due"]);
  });
  it("record_attempt_v2 does not update FSRS or review timestamps", () => {
    const body = sql.slice(sql.indexOf("record_attempt_v2"), sql.indexOf("record_review_result_v1"));
    expect(body).not.toMatch(/next_review_at\s*=/);
    expect(body).not.toMatch(/last_reviewed_at\s*=/);
    expect(body).not.toMatch(/fsrs_(stability|difficulty|state|reps|lapses)\s*=/);
  });

  it("record_review_result updates one card and persists its ReviewLog transactionally", () => {
    const body = sql.slice(sql.indexOf("record_review_result_v1"), sql.indexOf("record_pretest_result_v2"));
    expect(body).toContain("update user_words set");
    expect(body).toContain("insert into fsrs_review_logs");
    expect(body).toContain("next_review_at");
  });
});
