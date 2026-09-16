import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReviewCardDue } from "../server/services/fsrsReviews.js";
import { selectReviewWords } from "../server/services/review.js";
import type { VocabularyItem } from "../server/types.js";

const sql = readFileSync(new URL("../supabase/migrations/202609130002_fsrs_shanbay.sql", import.meta.url), "utf8");
const integritySql = readFileSync(new URL("../supabase/migrations/202609150005_integrity_guards.sql", import.meta.url), "utf8");

describe("attempt/review transaction boundary", () => {
  const item = (word: string, due: string | null, mastered = false, errors: VocabularyItem["error_layers"] = []): VocabularyItem => ({
    word, display_word: word, status: mastered ? "mastered" : "review", source: "test",
    consecutive_correct: 0, wrong_count: 0, mastered, next_review_at: due, error_layers: errors,
    fsrs_stability: 1, fsrs_difficulty: 5, fsrs_scheduled_days: 1, fsrs_state: 2,
  });

  it("includes due cards, excludes future cards, and adds no random filler", () => {
    const selected = selectReviewWords([
      item("mastered-due", "2026-09-12T00:00:00Z", true),
      item("future", "2026-09-20T00:00:00Z"),
    ], 5, new Date("2026-09-13T00:00:00Z"));
    expect(selected.map((word) => word.word)).toEqual(["mastered-due"]);
    expect(selected[0]).toMatchObject({ is_due: true, review_kind: "fsrs_due" });
  });

  it("labels future active errors as error repair without making them FSRS due", () => {
    const selected = selectReviewWords([
      item("repair", "2026-09-20T00:00:00Z", false, ["meaning"]),
    ], 5, new Date("2026-09-13T00:00:00Z"));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ is_due: false, review_kind: "error_repair" });
  });

  it("labels a due card with an active error as both", () => {
    const selected = selectReviewWords([
      item("both", "2026-09-12T00:00:00Z", false, ["spelling"]),
    ], 5, new Date("2026-09-13T00:00:00Z"));
    expect(selected[0]).toMatchObject({ is_due: true, review_kind: "both" });
  });
  it("record_attempt_v2 does not update FSRS or review timestamps", () => {
    const body = sql.slice(sql.indexOf("record_attempt_v2"), sql.indexOf("record_review_result_v1"));
    expect(body).not.toMatch(/next_review_at\s*=/);
    expect(body).not.toMatch(/last_reviewed_at\s*=/);
    expect(body).not.toMatch(/fsrs_(stability|difficulty|state|reps|lapses)\s*=/);
  });

  it("persists a deterministic spelling near miss as correct plus its spelling layer", () => {
    const body = sql.slice(sql.indexOf("record_attempt_v2"), sql.indexOf("record_review_result_v1"));
    expect(body).toContain("p_is_correct, p_error_layer");
    expect(body).toContain("if p_error_layer <> 'none' then v_layer := p_error_layer;");
    expect(body).toContain("if not p_is_correct then");
  });

  it("record_review_result updates one card and persists its ReviewLog transactionally", () => {
    const body = sql.slice(sql.indexOf("record_review_result_v1"), sql.indexOf("record_pretest_result_v2"));
    expect(body).toContain("update user_words set");
    expect(body).toContain("insert into fsrs_review_logs");
    expect(body).toContain("next_review_at");
  });

  it("checks due state after locking the card", () => {
    const body = integritySql.slice(integritySql.indexOf("record_review_result_v1"));
    expect(body).toContain("for update of uw");
    expect(body).toContain("FSRS_CARD_NOT_DUE");
    expect(body.indexOf("for update of uw")).toBeLessThan(body.indexOf("FSRS_CARD_NOT_DUE"));
  });

  it("uses one transaction for the review attempt and FSRS write", () => {
    expect(integritySql).toContain("record_review_submission_v1");
    const body = integritySql.slice(integritySql.indexOf("record_review_submission_v1"));
    expect(body).toContain("record_attempt_v2");
    expect(body).toContain("record_review_result_v1");
    expect(body).toContain("jsonb_build_object('attempt', v_attempt, 'review', v_review)");
  });

  it("fails fast for null, invalid, or future cards while accepting due cards", () => {
    expect(() => assertReviewCardDue(null, new Date("2026-09-15T00:00:00Z"))).toThrow("FSRS card is not due.");
    expect(() => assertReviewCardDue("not-a-date", new Date("2026-09-15T00:00:00Z"))).toThrow("FSRS card is not due.");
    expect(() => assertReviewCardDue("2026-09-16T00:00:00Z", new Date("2026-09-15T00:00:00Z"))).toThrow("FSRS card is not due.");
    expect(() => assertReviewCardDue("2026-09-14T00:00:00Z", new Date("2026-09-15T00:00:00Z"))).not.toThrow();
  });
});
