import { describe, expect, it } from "vitest";
import { calculateProgress, calculateReviewTodayProgress } from "../server/services/progress.js";
import { makeStudyState } from "../server/services/studySessions.js";
import type { StudyState, VocabularyItem, WordStatus } from "../server/types.js";

function item(word: string, status: WordStatus, options: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    word, display_word: word, status, source: "test", consecutive_correct: 0,
    wrong_count: 0, mastered: status === "mastered", next_review_at: null, error_layers: [], ...options,
    fsrs_stability: 0, fsrs_difficulty: 0, fsrs_scheduled_days: 0, fsrs_state: 0,
  };
}

function reviewState(phase: "review" | "review_complete", currentIndex: number): StudyState {
  const items = Array.from({ length: 25 }, (_, index) => ({
    word: `review-${index}`,
    meaning_zh: "复习词义",
    direction: "cn_to_en" as const,
    error_layers: [],
    is_due: true,
    review_kind: "fsrs_due" as const,
    next_review_at: "2026-09-26T00:00:00.000Z",
  }));
  return makeStudyState({
    date: "2026-09-27", widget: "review", phase,
    current_word: phase === "review_complete" ? null : items[currentIndex]?.word ?? null,
    current_index: currentIndex, retry_count: 0, flow: { relearn_words: [] },
    payload: { widget: "review", items },
  });
}

describe("progress calculation", () => {
  it("calculates daily classifications and all-time error book", () => {
    const all = [
      item("a", "known"), item("b", "uncertain"), item("c", "unknown"),
      item("d", "mastered"), item("e", "review", { error_layers: ["collocation"] }),
    ];
    expect(calculateProgress(all.slice(0, 4), all)).toEqual({
      today: { total: 4, known: 1, uncertain: 1, unknown: 1, completed: 4 },
      review_today: { completed: 0, total: 0, remaining: 0 },
      all_time: { total_words: 5, mastered: 1, learning: 3, error_book: 1 },
      fsrs: { due_now: 0, due_today: 0, tomorrow: 0, due_next_7_days: 0, average_stability: 0 },
      settings: { daily_new_word_limit: 50 },
    });
  });

  it("uses the active immutable Review snapshot and cursor for separate Review progress", () => {
    const active = reviewState("review", 18);
    expect(calculateReviewTodayProgress({ state: active }, [], 0)).toEqual({
      completed: 18, total: 25, remaining: 7,
    });
  });

  it("marks a completed Review snapshot as fully complete", () => {
    const completed = reviewState("review_complete", 25);
    expect(calculateReviewTodayProgress({ state: completed }, [], 0)).toEqual({
      completed: 25, total: 25, remaining: 0,
    });
  });

  it("includes assigned Review failures as pending Review work before Pretest begins", () => {
    const active = makeStudyState({
      date: "2026-09-27", widget: "review", phase: "review_complete", current_word: null, current_index: 25,
      retry_count: 0, flow: { relearn_words: ["pirate", "feeble", "intensive", "nerve"] },
      payload: { widget: "review", items: Array.from({ length: 25 }, (_, index) => ({ word: `review-${index}` })) },
    });
    expect(calculateReviewTodayProgress({ state: active }, [], 0)).toEqual({
      completed: 25, total: 29, remaining: 4,
    });
  });

  it("retains completed Review progress after the same session advances to Pretest", () => {
    const pretest = makeStudyState({
      date: "2026-09-27", widget: "pretest", phase: "pretest", current_word: "new-1", current_index: 0,
      retry_count: 0, flow: { relearn_words: [] }, payload: { widget: "pretest", items: [{ word: "new-1" }] },
    });
    expect(calculateReviewTodayProgress(
      { state: pretest },
      [{ review_words_count: 25, state: pretest }],
      25,
    )).toEqual({ completed: 25, total: 25, remaining: 0 });
  });

  it("counts assigned re-learning under Review progress and keeps it outside today's new-word queue", () => {
    const relearnWords = ["pirate", "feeble", "intensive", "nerve"];
    const lessonWords = [...relearnWords, ...Array.from({ length: 5 }, (_, index) => `new-${index}`)];
    const lesson = makeStudyState({
      date: "2026-09-27", widget: "lesson", phase: "lesson_explain", current_word: "intensive", current_index: 2,
      retry_count: 0, flow: { relearn_words: relearnWords, lesson_words: lessonWords },
      payload: { widget: "lesson", mode: "explain", word: "intensive" },
    });
    const review = calculateReviewTodayProgress(
      { state: lesson },
      [{ review_words_count: 25, state: lesson }],
      25,
    );
    const newWords = Array.from({ length: 50 }, (_, index) => item(`new-${index}`, index < 6 ? "known" : "new"));
    const today = calculateProgress(newWords, newWords);

    expect(review).toEqual({ completed: 27, total: 29, remaining: 2 });
    expect(today.today).toMatchObject({ completed: 6, total: 50 });
  });

  it("ignores ended sessions with empty state and safely counts a valid active Lesson", () => {
    const activeLesson = makeStudyState({
      date: "2026-09-27", widget: "lesson", phase: "lesson_explain", current_word: "new-1", current_index: 1,
      retry_count: 0, flow: { relearn_words: ["Grieve"], lesson_words: ["grieve", "new-1"] },
      payload: { widget: "lesson", mode: "explain", word: "new-1" },
    });

    expect(calculateReviewTodayProgress(
      { state: activeLesson },
      [
        { review_words_count: 17, state: {} },
        { review_words_count: 0, state: activeLesson },
        { review_words_count: 0, state: { flow: { relearn_words: null } } },
      ],
      12,
    )).toEqual({ completed: 13, total: 18, remaining: 5 });
  });

  it("keeps today's new-word queue independent from completed Review work", () => {
    const sixCompleted = Array.from({ length: 50 }, (_, index) => item(`new-${index}`, index < 6 ? "known" : "new"));
    const daily = calculateProgress(sixCompleted, sixCompleted);
    const review_today = calculateReviewTodayProgress(
      { state: makeStudyState({
        date: "2026-09-27", widget: "pretest", phase: "pretest", current_word: "new-6", current_index: 6,
        retry_count: 0, flow: { relearn_words: [] }, payload: { widget: "pretest", items: [{ word: "new-6" }] },
      }) },
      [{ review_words_count: 25, state: null }],
      25,
    );
    expect(daily.today).toMatchObject({ total: 50, completed: 6 });
    expect(review_today).toEqual({ completed: 25, total: 25, remaining: 0 });
  });

  it("shows an untouched 50-word daily queue as 0 / 50 alongside an active Review snapshot", () => {
    const allNew = Array.from({ length: 50 }, (_, index) => item(`new-${index}`, "new"));
    const daily = calculateProgress(allNew, allNew);
    const review_today = calculateReviewTodayProgress({ state: reviewState("review_complete", 25) }, [], 25);

    expect(daily.today).toMatchObject({ total: 50, completed: 0 });
    expect(review_today).toEqual({ completed: 25, total: 25, remaining: 0 });
  });

  it("reports no Review total without substituting due_now", () => {
    expect(calculateReviewTodayProgress(null, [], 0)).toEqual({ completed: 0, total: 0, remaining: 0 });
  });
});
