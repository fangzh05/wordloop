import { describe, expect, it, vi } from "vitest";
import { calculateProgress, calculateReviewTodayProgress, fsrsForecast, getProgress } from "../server/services/progress.js";
import { makeStudyState } from "../server/services/studySessions.js";
import type { StudyState, VocabularyItem, WordStatus } from "../server/types.js";

const runtimeMocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getAuthenticatedUserId: vi.fn(() => "user"),
  getActiveStudySession: vi.fn(),
  getUserTimeZone: vi.fn(),
}));

vi.mock("../server/db.js", async () => {
  const actual = await vi.importActual<typeof import("../server/db.js")>("../server/db.js");
  return {
    ...actual,
    getDatabase: runtimeMocks.getDatabase,
    getAuthenticatedUserId: runtimeMocks.getAuthenticatedUserId,
  };
});

vi.mock("../server/services/studySessions.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/studySessions.js")>("../server/services/studySessions.js");
  return { ...actual, getActiveStudySession: runtimeMocks.getActiveStudySession };
});

vi.mock("../server/services/words.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/words.js")>("../server/services/words.js");
  return { ...actual, getUserTimeZone: runtimeMocks.getUserTimeZone };
});

function tableQuery(result: unknown) {
  const builder: Record<string, any> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.gte = () => builder;
  builder.lt = () => builder;
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function item(word: string, status: WordStatus, options: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    word, display_word: word, status, source: "test", consecutive_correct: 0,
    wrong_count: 0, mastered: status === "mastered", next_review_at: null, error_layers: [],
    fsrs_stability: 0, fsrs_difficulty: 0, fsrs_scheduled_days: 0, fsrs_reps: 0, fsrs_state: 0,
    ...options,
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
  it("calculates the compatibility stability average over scheduled cards only", () => {
    const scheduled = Array.from({ length: 203 }, (_, index) => item(`scheduled-${index}`, "review", {
      fsrs_reps: 1, fsrs_stability: 5.2408,
    }));
    const unscheduled = Array.from({ length: 6390 }, (_, index) => item(`new-${index}`, "new", {
      fsrs_reps: 0, fsrs_stability: 0.1614,
    }));
    expect(fsrsForecast([...scheduled, ...unscheduled]).average_stability).toBe(5.24);
    expect(fsrsForecast(unscheduled).average_stability).toBe(0);
  });

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
    expect(calculateReviewTodayProgress({ state: active }, [])).toEqual({
      completed: 18, total: 25, remaining: 7,
    });
  });

  it("marks a completed Review snapshot as fully complete", () => {
    const completed = reviewState("review_complete", 25);
    expect(calculateReviewTodayProgress({ state: completed }, [])).toEqual({
      completed: 25, total: 25, remaining: 0,
    });
  });

  it("excludes assigned Review failures from formal Review progress", () => {
    const active = makeStudyState({
      date: "2026-09-27", widget: "review", phase: "review_complete", current_word: null, current_index: 25,
      retry_count: 0, flow: { relearn_words: ["pirate", "feeble", "intensive", "nerve"] },
      payload: { widget: "review", items: Array.from({ length: 25 }, (_, index) => ({ word: `review-${index}`, review_kind: "fsrs_due" })) },
    });
    expect(calculateReviewTodayProgress({ state: active }, [])).toEqual({
      completed: 25, total: 25, remaining: 0,
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
    )).toEqual({ completed: 25, total: 25, remaining: 0 });
  });

  it("keeps formal Review progress separate from Lesson relearn and today's new-word queue", () => {
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
    );
    const newWords = Array.from({ length: 50 }, (_, index) => item(`new-${index}`, index < 6 ? "known" : "new"));
    const today = calculateProgress(newWords, newWords);

    expect(review).toEqual({ completed: 25, total: 25, remaining: 0 });
    expect(today.today).toMatchObject({ completed: 6, total: 50 });
  });

  it("carries completed cards from Review snapshot A into active snapshot B", () => {
    const snapshotB = makeStudyState({
      date: "2026-09-27", widget: "review", phase: "review", current_word: "b-2", current_index: 2,
      retry_count: 0, flow: { relearn_words: ["opaque"] },
      payload: { widget: "review", items: Array.from({ length: 5 }, (_, index) => ({ word: `b-${index}`, review_kind: "fsrs_due" })) },
    });

    expect(calculateReviewTodayProgress(
      { state: snapshotB, review_words_count: 27 },
      [],
    )).toEqual({ completed: 27, total: 30, remaining: 3 });
  });

  it("returns 30 / 30 after consecutive Review snapshots even while relearn is queued", () => {
    const lesson = makeStudyState({
      date: "2026-09-27", widget: "lesson", phase: "lesson_exercise", current_word: "opaque", current_index: 2,
      retry_count: 0, flow: { relearn_words: ["opaque", "tacit"], lesson_words: ["opaque", "tacit", "new-1"] },
      payload: { widget: "lesson", mode: "exercise", word: "opaque" },
    });

    expect(calculateReviewTodayProgress(
      { state: lesson },
      [{ review_words_count: 30, state: lesson }],
    )).toEqual({ completed: 30, total: 30, remaining: 0 });
  });

  it("excludes non-FSRS error-repair cards from Review progress", () => {
    const mixed = makeStudyState({
      date: "2026-09-27", widget: "review", phase: "review_complete", current_word: null, current_index: 2,
      retry_count: 0, flow: { relearn_words: [] },
      payload: { widget: "review", items: [
        { word: "due", review_kind: "fsrs_due" },
        { word: "repair", review_kind: "error_repair" },
      ] },
    });

    expect(calculateReviewTodayProgress(
      { state: mixed, review_words_count: 1 },
      [],
    )).toEqual({ completed: 1, total: 1, remaining: 0 });
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
    )).toEqual({ completed: 17, total: 17, remaining: 0 });
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
    );
    expect(daily.today).toMatchObject({ total: 50, completed: 6 });
    expect(review_today).toEqual({ completed: 25, total: 25, remaining: 0 });
  });

  it("shows an untouched 50-word daily queue as 0 / 50 alongside an active Review snapshot", () => {
    const allNew = Array.from({ length: 50 }, (_, index) => item(`new-${index}`, "new"));
    const daily = calculateProgress(allNew, allNew);
    const review_today = calculateReviewTodayProgress({ state: reviewState("review_complete", 25) }, []);

    expect(daily.today).toMatchObject({ total: 50, completed: 0 });
    expect(review_today).toEqual({ completed: 25, total: 25, remaining: 0 });
  });

  it("reports no Review total without substituting due_now", () => {
    expect(calculateReviewTodayProgress(null, [])).toEqual({ completed: 0, total: 0, remaining: 0 });
  });

  it("returns daily new-word and cumulative formal Review progress through getProgress", async () => {
    const lesson = makeStudyState({
      date: "2026-09-28", widget: "lesson", phase: "lesson_exercise", current_word: "opaque", current_index: 2,
      retry_count: 0, flow: { relearn_words: ["opaque", "tacit"], lesson_words: ["opaque", "tacit", "new-1"] },
      payload: { widget: "lesson", mode: "exercise", word: "opaque" },
    });
    const session = {
      id: "session",
      review_words_count: 30,
      new_words_count: 12,
      state: lesson,
    };
    const snapshot = {
      today: { total: 50, known: 49, uncertain: 0, unknown: 0, completed: 49 },
      all_time: { total_words: 50, mastered: 0, learning: 50, error_book: 0 },
      fsrs: { due_now: 0, due_today: 0, tomorrow: 0, due_next_7_days: 0, average_stability: 0 },
      settings: { daily_new_word_limit: 50 },
    };
    const db = {
      rpc: vi.fn(async () => ({ data: snapshot, error: null })),
      from: vi.fn((table: string) => tableQuery(table === "study_sessions"
        ? { data: [session], error: null }
        : { data: null, error: null, count: 30 })),
    };
    runtimeMocks.getDatabase.mockReturnValue(db);
    runtimeMocks.getActiveStudySession.mockResolvedValue(session);
    runtimeMocks.getUserTimeZone.mockResolvedValue("Asia/Shanghai");

    const progress = await getProgress();

    expect(progress.today).toMatchObject({ completed: 49, total: 50 });
    expect(progress.review_today).toEqual({ completed: 30, total: 30, remaining: 0 });
  });
});
