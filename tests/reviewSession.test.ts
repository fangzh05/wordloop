import { describe, expect, it } from "vitest";
import { REVIEW_SESSION_MAX, reviewWidgetPayloadSchema } from "../shared/toolContracts.js";
import { buildLearningQueue, findNextLearningWord, selectDueReviewWords } from "../server/services/review.js";
import { advanceStudyState, makeStudyState } from "../server/services/studySessions.js";
import { buildReviewAnswerSubmission, buildReviewSubmission } from "../web/src/review/ReviewWidget.js";
import type { ReviewWidgetItem } from "../shared/toolContracts.js";
import type { ReviewVocabularyItem, VocabularyItem } from "../server/types.js";

function vocabularyItem(word: string, options: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    word,
    display_word: word,
    status: "review",
    source: "test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: null,
    error_layers: [],
    fsrs_stability: 1,
    fsrs_difficulty: 5,
    fsrs_scheduled_days: 1,
    fsrs_state: 2,
    ...options,
  };
}

function reviewItem(word: string, nextReviewAt: string): ReviewVocabularyItem {
  return {
    ...vocabularyItem(word, { next_review_at: nextReviewAt }),
    is_due: true,
    review_kind: "fsrs_due",
    senses: [{ pos: "n.", definition_cn: "测试含义" }],
  };
}

function reviewWidgetItem(word: string): ReviewWidgetItem {
  return {
    word,
    meaning_zh: "测试含义",
    direction: "cn_to_en",
    error_layers: [],
    is_due: true,
    review_kind: "fsrs_due",
    next_review_at: "2026-09-15T00:00:00Z",
  };
}

describe("single Review session gate", () => {
  it("selects only due cards, ordered by due time and word, and caps at 200", () => {
    const now = new Date("2026-09-16T00:00:00Z");
    const selected = selectDueReviewWords([
      reviewItem("zulu", "2026-09-15T00:00:00Z"),
      vocabularyItem("active-error-only", { error_layers: ["meaning"], next_review_at: "2026-09-20T00:00:00Z" }),
      reviewItem("alpha", "2026-09-15T00:00:00Z"),
      reviewItem("future", "2026-09-20T00:00:00Z"),
    ], REVIEW_SESSION_MAX, now);
    expect(selected.map((item) => item.word)).toEqual(["alpha", "zulu"]);
    expect(selected.every((item) => item.is_due)).toBe(true);
  });

  it("deduplicates the session re-learn queue before today's learning queue", () => {
    const queue = buildLearningQueue({
      relearnWords: [vocabularyItem("recur", { status: "review" }), "old-card"],
      todayWords: [
        vocabularyItem("recur", { status: "unknown" }),
        vocabularyItem("today-card", { status: "uncertain" }),
        vocabularyItem("untested-new", { status: "new" }),
        vocabularyItem("finished", { status: "known" }),
      ],
    });
    expect(queue.map((item) => item.word)).toEqual(["recur", "old-card", "today-card"]);
    expect(findNextLearningWord(queue, "recur")).toMatchObject({ next_word: { word: "old-card" }, round_complete: false });
  });

  it("advances one immutable snapshot cursor and records failed cards once for re-learning", () => {
    const payload = reviewWidgetPayloadSchema.parse({
      widget: "review",
      items: [reviewWidgetItem("recur"), reviewWidgetItem("planet")],
      title: "复习",
    });
    const initial = makeStudyState({
      date: "2026-09-16",
      widget: "review",
      phase: "review",
      current_word: "recur",
      current_index: 0,
      retry_count: 0,
      payload,
    });

    const first = advanceStudyState(initial, "review_answer", 0, buildReviewAnswerSubmission({ word: "recur" }, false, 0));
    expect(first).toMatchObject({ phase: "review", current_word: "planet", current_index: 1, flow: { relearn_words: ["recur"] } });

    // A lost response may retry the same cursor transition, but must not add
    // another re-learn word or move the cursor twice.
    expect(advanceStudyState(first, "review_answer", 0, buildReviewAnswerSubmission({ word: "recur" }, false, 0))).toEqual(first);

    const complete = advanceStudyState(first, "review_answer", 1, buildReviewAnswerSubmission({ word: "planet" }, true, 1));
    expect(complete).toMatchObject({ phase: "review_complete", current_word: null, current_index: 2, flow: { relearn_words: ["recur"] } });
    expect(() => advanceStudyState(first, "review_answer", 1, buildReviewAnswerSubmission({ word: "wrong" }, true, 1))).toThrow("REVIEW_WORD_MISMATCH");
  });

  it("routes all Review verdicts through the same record contract before the cursor event", () => {
    for (const direction of ["cn_to_en", "en_definition"] as const) {
      for (const review_kind of ["error_repair", "fsrs_due", "both"] as const) {
        const call = buildReviewSubmission(
          { word: "recur", direction, review_kind },
          { user_answer: "", is_correct: false, error_layer: "meaning", rating: "again" },
        );
        expect(call.arguments).toMatchObject({ word: "recur", direction, is_correct: false, error_layer: "meaning" });
        expect(buildReviewAnswerSubmission({ word: "recur" }, false, 0)).toMatchObject({
          event: "review_answer", word: "recur", is_correct: false, current_index: 0,
        });
      }
    }
  });
});
