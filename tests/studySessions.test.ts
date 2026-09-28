import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  advanceStudySession,
  advanceStudyState,
  finishStudySession,
  getActiveStudySession,
  isCompletedLessonRound,
  isStudySessionSchemaMismatch,
  makeStudyState,
  isLegacyCompletedPretestState,
  normalizeStudyStateForRead,
  persistStudyState,
  studySessionSummary,
} from "../server/services/studySessions.js";
import {
  dictationInputSchema,
  lessonInputSchema,
  pretestInputSchema,
} from "../server/tools/renderWidgets.js";
import type { StudySessionDb } from "../server/services/studySessions.js";
import type { StudySessionRow, StudyState } from "../server/types.js";

const exercise = {
  activity_type: "sentence",
  instruction: "Use the word in a new scene.",
  prompt: "The researchers observed a recurring pattern.",
  multiline: false,
};

const airConditioningExercise = {
  activity_type: "cloze",
  instruction: "用 air-conditioning 词族中的正确形式填空。",
  prompt: "Because the laboratory contains temperature-sensitive equipment, it must remain fully ____ throughout the summer.",
  multiline: false,
};

const explainPayload = {
  widget: "lesson",
  mode: "explain" as const,
  word: "plantation",
  ipa: "/plænˈteɪʃən/",
  part_of_speech: "n.",
  meaning_zh: "种植园",
  collocations: ["tea plantation"],
  derivations: [],
  example_en: "The plantation changed hands after the harvest.",
  note: "Use the noun for a large farm or estate.",
  exercise,
};

const completedWrapupPayload = {
  widget: "lesson",
  mode: "feedback" as const,
  wrapup: true as const,
  word: "plantation",
  progress: "长难句收尾",
  exercise: { ...exercise, multiline: true },
  feedback: {
    is_correct: true,
    user_answer: "主干：The plantation changed hands; 翻译：收获后种植园易主。",
    reveal_answer: false,
  },
};

function sessionState(overrides: Partial<Parameters<typeof makeStudyState>[0]> = {}) {
  return makeStudyState({
    date: "2026-09-15",
    widget: "lesson",
    phase: "lesson_explain",
    current_word: "plantation",
    current_index: 0,
    retry_count: 0,
    payload: explainPayload,
    ...overrides,
  });
}

function pretestState(
  words: string[],
  phase: "pretest" | "pretest_result" | "listen_repeat" | "listen_recall" | "pretest_complete",
  currentIndex: number,
  flow: { relearn_words: string[] } = { relearn_words: [] },
): StudyState {
  return makeStudyState({
    date: "2026-09-15",
    widget: "pretest",
    phase,
    current_word: phase === "pretest_complete" ? null : words[currentIndex] ?? null,
    current_index: currentIndex,
    retry_count: 0,
    flow,
    payload: { widget: "pretest", items: words.map((word) => ({ word })) },
  });
}

function reviewState(
  words: string[],
  phase: "review" | "review_complete",
  currentIndex: number,
  flow: { relearn_words: string[]; lesson_words?: string[] } = { relearn_words: [] },
): StudyState {
  return makeStudyState({
    date: "2026-09-15",
    widget: "review",
    phase,
    current_word: phase === "review_complete" ? null : words[currentIndex] ?? null,
    current_index: currentIndex,
    retry_count: 0,
    flow,
    payload: { widget: "review", items: words.map((word) => ({ word, review_kind: "fsrs_due" })) },
  });
}

function mockStudySessionDb(
  state: StudyState,
  counts: Partial<Pick<StudySessionRow, "new_words_count" | "review_words_count">> = {},
) {
  let row: StudySessionRow = {
    id: "session",
    user_id: "user",
    started_at: "2026-09-15T00:00:00.000Z",
    ended_at: null,
    new_words_count: counts.new_words_count ?? 0,
    review_words_count: counts.review_words_count ?? 0,
    state,
    updated_at: "2026-09-15T00:00:00.000Z",
  };
  const updates: Array<Record<string, unknown>> = [];
  const readBuilder: Record<string, any> = {};
  const updateBuilder: Record<string, any> = {};
  readBuilder.select = vi.fn(() => readBuilder);
  readBuilder.eq = vi.fn(() => readBuilder);
  readBuilder.is = vi.fn(() => readBuilder);
  readBuilder.order = vi.fn(() => readBuilder);
  readBuilder.limit = vi.fn(() => readBuilder);
  readBuilder.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  readBuilder.update = vi.fn((values: Record<string, unknown>) => {
    updates.push(values);
    row = {
      ...row,
      state: values.state as StudyState,
      updated_at: String(values.updated_at),
      ...(typeof values.new_words_count === "number" ? { new_words_count: values.new_words_count } : {}),
      ...(typeof values.review_words_count === "number" ? { review_words_count: values.review_words_count } : {}),
    };
    return updateBuilder;
  });
  updateBuilder.eq = vi.fn(() => updateBuilder);
  updateBuilder.is = vi.fn(() => updateBuilder);
  updateBuilder.select = vi.fn(() => updateBuilder);
  updateBuilder.single = vi.fn(async () => ({ data: row, error: null }));
  return {
    db: { from: vi.fn(() => readBuilder) } as unknown as StudySessionDb,
    updates,
  };
}

describe("durable study session state", () => {
  it("counts the completed prefix of each immutable Pretest snapshot", async () => {
    const words = Array.from({ length: 6 }, (_, index) => `new-${index}`);
    const start = pretestState(words, "pretest", 0);
    const { db } = mockStudySessionDb(start);

    let saved = await persistStudyState(start, db, "user");
    const counts = [saved.new_words_count];
    for (let index = 0; index < words.length; index += 1) {
      saved = await persistStudyState(pretestState(words, "pretest_result", index), db, "user");
      counts.push(saved.new_words_count);
      if (index + 1 < words.length) {
        saved = await persistStudyState(pretestState(words, "pretest", index + 1), db, "user");
        expect(saved.new_words_count).toBe(index + 1);
      }
    }
    saved = await persistStudyState(pretestState(words, "pretest_complete", words.length), db, "user");

    expect(counts).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saved.new_words_count).toBe(6);
  });

  it("keeps a repeated Pretest result at the same count after refresh or retry", async () => {
    const words = Array.from({ length: 6 }, (_, index) => `new-${index}`);
    const previous = pretestState(words, "pretest", 3);
    const { db } = mockStudySessionDb(previous, { new_words_count: 3 });
    const answeredThirdWord = pretestState(words, "pretest_result", 2);

    const first = await persistStudyState(answeredThirdWord, db, "user");
    const retry = await persistStudyState(answeredThirdWord, db, "user");

    expect(first.new_words_count).toBe(3);
    expect(retry.new_words_count).toBe(3);
  });

  it("accumulates distinct completed Pretest batches across intervening Lesson state", async () => {
    const batchA = Array.from({ length: 6 }, (_, index) => `batch-a-${index}`);
    const batchB = Array.from({ length: 6 }, (_, index) => `batch-b-${index}`);
    const { db } = mockStudySessionDb(pretestState(batchA, "pretest_complete", batchA.length));

    let saved = await persistStudyState(pretestState(batchA, "pretest_complete", batchA.length), db, "user");
    expect(saved.new_words_count).toBe(6);
    saved = await persistStudyState(sessionState({
      current_word: batchA[0] ?? null,
      flow: { relearn_words: [], lesson_words: [batchA[0] ?? "batch-a-0"] },
    }), db, "user");
    expect(saved.new_words_count).toBe(6);
    saved = await persistStudyState(pretestState(batchB, "pretest", 0), db, "user");
    expect(saved.new_words_count).toBe(6);
    saved = await persistStudyState(pretestState(batchB, "pretest_complete", batchB.length), db, "user");

    expect(saved.new_words_count).toBe(12);
  });

  it("does not count Review relearn words as newly learned words", async () => {
    const completedReview = reviewState(["opaque"], "review_complete", 1, {
      relearn_words: ["opaque"], lesson_words: ["opaque"],
    });
    const { db } = mockStudySessionDb(completedReview);
    const lesson = sessionState({
      current_word: "opaque",
      flow: { relearn_words: ["opaque"], lesson_words: ["opaque"] },
    });

    const saved = await persistStudyState(lesson, db, "user");

    expect(saved.new_words_count).toBe(0);
  });

  it("persists the completed Review count in the shared session row", async () => {
    const reviewItems = Array.from({ length: 25 }, (_, index) => ({
      word: `review-${index}`, meaning_zh: "词义", direction: "cn_to_en" as const,
      error_layers: [], is_due: true, review_kind: "fsrs_due" as const,
      next_review_at: "2026-09-15T00:00:00.000Z",
    }));
    const review = makeStudyState({
      date: "2026-09-15", widget: "review", phase: "review", current_word: "review-18",
      current_index: 18, retry_count: 0, flow: { relearn_words: [] },
      payload: { widget: "review", items: reviewItems },
    });
    const { db, updates } = mockStudySessionDb(review);

    const saved = await persistStudyState(review, db, "user");

    expect(updates[0]).toMatchObject({ review_words_count: 18 });
    expect(saved.review_words_count).toBe(18);
  });

  it("updates one immutable Review snapshot from 10 completed cards to 25", async () => {
    const words = Array.from({ length: 25 }, (_, index) => `review-${index}`);
    const { db } = mockStudySessionDb(reviewState(words, "review", 0));

    let saved = await persistStudyState(reviewState(words, "review", 10), db, "user");
    expect(saved.review_words_count).toBe(10);
    saved = await persistStudyState(reviewState(words, "review_complete", 25), db, "user");

    expect(saved.review_words_count).toBe(25);
  });

  it("does not schedule another same-day relearn after its completed word remains in the durable flow", () => {
    const review = makeStudyState({
      date: "2026-09-15",
      widget: "review",
      phase: "review",
      current_word: "embark",
      current_index: 0,
      retry_count: 0,
      flow: { relearn_words: ["embark"], lesson_words: ["embark"] },
      payload: {
        widget: "review",
        items: [{
          word: "embark",
          meaning_zh: "启程",
          direction: "cn_to_en",
          error_layers: [],
          is_due: true,
          review_kind: "fsrs_due",
          next_review_at: "2026-09-15T00:00:00.000Z",
        }],
      },
    });

    const afterAnotherFailure = advanceStudyState(review, "review_answer", 0, {
      event: "review_answer",
      word: "embark",
      is_correct: false,
      current_index: 0,
    });

    expect(afterAnotherFailure).toMatchObject({
      phase: "review_complete",
      flow: { relearn_words: ["embark"], lesson_words: ["embark"] },
    });
  });

  it("retains the completed Review count when the same session advances to Pretest", async () => {
    const reviewItems = Array.from({ length: 25 }, (_, index) => ({
      word: `review-${index}`, meaning_zh: "词义", direction: "cn_to_en" as const,
      error_layers: [], is_due: true, review_kind: "fsrs_due" as const,
      next_review_at: "2026-09-15T00:00:00.000Z",
    }));
    const review = makeStudyState({
      date: "2026-09-15", widget: "review", phase: "review_complete", current_word: null,
      current_index: 25, retry_count: 0, flow: { relearn_words: [] },
      payload: { widget: "review", items: reviewItems },
    });
    const pretest = makeStudyState({
      date: "2026-09-15", widget: "pretest", phase: "pretest", current_word: "new-word",
      current_index: 0, retry_count: 0, flow: { relearn_words: [] },
      payload: { widget: "pretest", items: [{ word: "new-word" }] },
    });
    const { db, updates } = mockStudySessionDb(review);

    const saved = await persistStudyState(pretest, db, "user");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ review_words_count: 25, state: { widget: "pretest" } });
    expect(saved.review_words_count).toBe(25);
  });

  it("accumulates completed cursors across successive immutable Review snapshots", async () => {
    const snapshotA = Array.from({ length: 25 }, (_, index) => `review-a-${index}`);
    const snapshotB = Array.from({ length: 5 }, (_, index) => `review-b-${index}`);
    const { db } = mockStudySessionDb(reviewState(snapshotA, "review_complete", snapshotA.length));

    let saved = await persistStudyState(reviewState(snapshotA, "review_complete", snapshotA.length), db, "user");
    expect(saved.review_words_count).toBe(25);
    saved = await persistStudyState(reviewState(snapshotB, "review", 0), db, "user");
    expect(saved.review_words_count).toBe(25);
    saved = await persistStudyState(reviewState(snapshotB, "review", 2), db, "user");
    expect(saved.review_words_count).toBe(27);
    saved = await persistStudyState(reviewState(snapshotB, "review_complete", snapshotB.length), db, "user");

    expect(saved.review_words_count).toBe(30);
  });

  it("counts only FSRS-bearing cards in a mixed Review snapshot", async () => {
    const mixed = makeStudyState({
      date: "2026-09-15", widget: "review", phase: "review", current_word: "repair", current_index: 1,
      retry_count: 0, flow: { relearn_words: [] },
      payload: { widget: "review", items: [
        { word: "due", review_kind: "fsrs_due" },
        { word: "repair", review_kind: "error_repair" },
      ] },
    });
    const { db } = mockStudySessionDb(mixed);

    let saved = await persistStudyState(mixed, db, "user");
    expect(saved.review_words_count).toBe(1);
    saved = await persistStudyState({ ...mixed, phase: "review_complete", current_word: null, current_index: 2 }, db, "user");

    expect(saved.review_words_count).toBe(1);
  });

  it("requires a formal FSRS submission before advancing a due Review card", async () => {
    const state = makeStudyState({
      date: "2026-09-15", widget: "review", phase: "review", current_word: "due", current_index: 0,
      retry_count: 0, flow: { relearn_words: [] },
      payload: { widget: "review", items: [{
        word: "due", meaning_zh: "词义", direction: "cn_to_en", error_layers: [], is_due: true,
        review_kind: "fsrs_due", next_review_at: "2026-09-15T00:00:00.000Z",
      }] },
    });
    const { db, updates } = mockStudySessionDb(state);

    await expect(advanceStudySession("review_answer", 0, {
      event: "review_answer", word: "due", is_correct: true, current_index: 0,
    }, db, "user")).rejects.toThrow("FSRS_REVIEW_SUBMISSION_REQUIRED");

    expect(updates).toHaveLength(0);
  });

  it("preserves the formal Review total through later Lesson relearn work", async () => {
    const reviewWords = Array.from({ length: 25 }, (_, index) => `review-${index}`);
    const completedReview = reviewState(reviewWords, "review_complete", reviewWords.length, {
      relearn_words: ["opaque", "tacit", "staid", "wary", "arduous"],
    });
    const { db } = mockStudySessionDb(completedReview, { review_words_count: 25 });
    const lessonWords = ["opaque", "tacit", "staid", "wary", "arduous"];
    let saved = await persistStudyState(sessionState({
      current_word: lessonWords[0] ?? null,
      current_index: 0,
      flow: { relearn_words: lessonWords, lesson_words: lessonWords },
    }), db, "user");
    for (let index = 1; index < lessonWords.length; index += 1) {
      saved = await persistStudyState(sessionState({
        current_word: lessonWords[index] ?? null,
        current_index: index,
        flow: { relearn_words: lessonWords, lesson_words: lessonWords },
      }), db, "user");
    }

    expect(saved.review_words_count).toBe(25);
  });

  it("projects explain into the exact exercise without a new GPT turn", () => {
    const next = advanceStudyState(sessionState(), "lesson_start_exercise");
    expect(next.phase).toBe("lesson_exercise");
    expect(next.current_word).toBe("plantation");
    expect(next.retry_count).toBe(0);
    expect(next.payload).toMatchObject({
      widget: "lesson",
      mode: "exercise",
      word: "plantation",
      ...exercise,
    });
    expect(next.payload.exercise).toBeUndefined();
  });

  it("persists phase and exercise payload together for lesson_start_exercise", async () => {
    const { db, updates } = mockStudySessionDb(sessionState());
    const result = await advanceStudySession("lesson_start_exercise", undefined, undefined, db, "user");
    expect(updates).toHaveLength(1);
    expect((updates[0]?.state as StudyState)).toMatchObject({
      phase: "lesson_exercise",
      payload: { mode: "exercise", ...exercise },
    });
    expect(result.state).toMatchObject({
      phase: "lesson_exercise",
      payload: { mode: "exercise", ...exercise },
    });
  });

  it("accepts a repeated lesson_start_exercise after a lost response without changing state", () => {
    const first = advanceStudyState(sessionState(), "lesson_start_exercise");
    const retried = advanceStudyState(first, "lesson_start_exercise");
    expect(retried).toBe(first);
    expect(retried).toMatchObject({
      phase: "lesson_exercise",
      current_word: "plantation",
      current_index: 0,
      payload: { mode: "exercise", word: "plantation", ...exercise },
    });
  });

  it("keeps the original exercise and retry count during a retry transition", () => {
    const feedback = sessionState({
      phase: "lesson_feedback",
      retry_count: 1,
      payload: {
        widget: "lesson",
        mode: "feedback",
        word: "plantation",
        progress: "1 / 3",
        exercise,
        feedback: {
          is_correct: false,
          user_answer: "wrong",
          error_layer: "meaning",
          message: "Try again.",
          reveal_answer: false,
        },
      },
    });
    const next = advanceStudyState(feedback, "lesson_retry");
    expect(next.phase).toBe("lesson_exercise");
    expect(next.retry_count).toBe(1);
    expect(next.payload).toMatchObject({
      widget: "lesson",
      mode: "exercise",
      word: "plantation",
      progress: "1 / 3",
      ...exercise,
    });
    expect(next.payload.feedback).toBeUndefined();
  });

  it("preserves fixed answers across the feedback-to-exercise retry transition", () => {
    const acceptedAnswers = ["electricians"];
    const feedback = sessionState({
      phase: "lesson_feedback",
      retry_count: 1,
      payload: {
        widget: "lesson",
        mode: "feedback",
        word: "plantation",
        progress: "1 / 3",
        accepted_answers: acceptedAnswers,
        exercise: {
          ...exercise,
          activity_type: "exact_cloze",
          prompt: "The city hired a team of ___ to restore power.",
        },
        feedback: { is_correct: false, user_answer: "electrician", reveal_answer: false },
      },
    });

    const next = advanceStudyState(feedback, "lesson_retry");

    expect(next.phase).toBe("lesson_exercise");
    expect(next.payload.accepted_answers).toEqual(acceptedAnswers);
    expect(next.payload).toMatchObject({
      activity_type: "exact_cloze",
      prompt: "The city hired a team of ___ to restore power.",
    });
  });

  it("persists phase and exercise payload together for lesson_retry", async () => {
    const feedback = sessionState({
      phase: "lesson_feedback",
      retry_count: 1,
      payload: {
        widget: "lesson",
        mode: "feedback",
        word: "plantation",
        progress: "1 / 3",
        exercise,
        feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false },
      },
    });
    const { db, updates } = mockStudySessionDb(feedback);
    const result = await advanceStudySession("lesson_retry", undefined, undefined, db, "user");
    expect(updates).toHaveLength(1);
    expect((updates[0]?.state as StudyState)).toMatchObject({
      phase: "lesson_exercise",
      payload: { mode: "exercise", ...exercise },
    });
    expect(result.state).toMatchObject({
      phase: "lesson_exercise",
      payload: { mode: "exercise", ...exercise },
    });
  });

  it("does not write again for exact lesson lost-response retries", async () => {
    const started = advanceStudyState(sessionState(), "lesson_start_exercise");
    const { db, updates } = mockStudySessionDb(started);
    const startRetry = await advanceStudySession("lesson_start_exercise", undefined, undefined, db, "user");
    expect(startRetry.state).toMatchObject({ phase: "lesson_exercise", payload: { mode: "exercise", ...exercise } });
    expect(updates).toHaveLength(0);

    const feedback = sessionState({
      phase: "lesson_feedback",
      current_word: "plantation",
      current_index: 0,
      retry_count: 1,
      payload: {
        widget: "lesson",
        mode: "feedback",
        word: "plantation",
        progress: "1 / 3",
        exercise,
        feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false },
      },
    });
    const retryState = advanceStudyState(feedback, "lesson_retry");
    const retryDb = mockStudySessionDb(retryState);
    const retryResult = await advanceStudySession("lesson_retry", undefined, undefined, retryDb.db, "user");
    expect(retryResult.state).toMatchObject({ phase: "lesson_exercise", payload: { mode: "exercise", ...exercise } });
    expect(retryDb.updates).toHaveLength(0);
  });

  it("accepts a repeated lesson_retry after a lost response without changing state", () => {
    const feedback = sessionState({
      phase: "lesson_feedback",
      current_index: 2,
      retry_count: 1,
      flow: { relearn_words: [], lesson_words: ["plantation", "thorn", "query"] },
      payload: {
        widget: "lesson",
        mode: "feedback",
        word: "query",
        progress: "3 / 3",
        exercise,
        feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false },
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 3 },
      },
      current_word: "query",
    });
    const first = advanceStudyState(feedback, "lesson_retry");
    const retried = advanceStudyState(first, "lesson_retry");
    expect(retried).toBe(first);
    expect(retried).toMatchObject({
      phase: "lesson_exercise",
      current_word: "query",
      current_index: 2,
      retry_count: 1,
      flow: { lesson_words: ["plantation", "thorn", "query"] },
      payload: {
        mode: "exercise",
        word: "query",
        progress: "3 / 3",
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 3 },
        ...exercise,
      },
    });
  });

  it("keeps Lesson event phase checks strict outside exact lost-response retries", () => {
    const feedback = sessionState({ phase: "lesson_feedback" });
    const complete = sessionState({ phase: "lesson_complete" });
    const review = sessionState({ widget: "review", phase: "review" });
    expect(() => advanceStudyState(feedback, "lesson_start_exercise")).toThrow("Cannot apply lesson_start_exercise");
    expect(() => advanceStudyState(complete, "lesson_retry")).toThrow("Cannot apply lesson_retry");
    expect(() => advanceStudyState(sessionState(), "lesson_retry")).toThrow("Cannot apply lesson_retry");
    expect(() => advanceStudyState(review, "lesson_start_exercise")).toThrow();
  });

  it.each(["explain", "feedback"] as const)(
    "normalizes legacy lesson_exercise plus mode=%s without changing its cursor or exercise",
    (mode) => {
      const nested = mode === "explain" ? airConditioningExercise : { ...airConditioningExercise };
      const legacy = sessionState({
        phase: "lesson_exercise",
        current_word: "air-conditioning",
        current_index: 9,
        flow: {
          relearn_words: [],
          lesson_words: ["vicinity", "lower", "prospect", "thorn", "query", "marital", "pirate", "pit", "quota", "air-conditioning"],
        },
        payload: {
          widget: "lesson",
          mode,
          word: "air-conditioning",
          title: "Lesson title",
          progress: "10 / 10",
          widget_version: 7,
          navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 10 },
          exercise: nested,
          ...(mode === "feedback" ? { feedback: { is_correct: false, user_answer: "", reveal_answer: false } } : {}),
        },
      });

      const normalized = normalizeStudyStateForRead(legacy);

      expect(normalized).toMatchObject({
        phase: "lesson_exercise",
        current_word: "air-conditioning",
        current_index: 9,
        flow: { lesson_words: legacy.flow.lesson_words },
        payload: {
          widget: "lesson",
          mode: "exercise",
          word: "air-conditioning",
          title: "Lesson title",
          progress: "10 / 10",
          widget_version: 7,
          navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 10 },
          ...airConditioningExercise,
        },
      });
      expect(normalized.payload.exercise).toBeUndefined();
      expect(normalized.current_index).toBe(legacy.current_index);
      expect(normalized.current_word).toBe(legacy.current_word);
      expect(normalized.flow.lesson_words).toBe(legacy.flow.lesson_words);
      expect({
        activity_type: normalized.payload.activity_type,
        instruction: normalized.payload.instruction,
        prompt: normalized.payload.prompt,
        multiline: normalized.payload.multiline,
      }).toEqual(airConditioningExercise);
    },
  );

  it("recognizes a canonical direct exercise payload on repeated transition", () => {
    const direct = sessionState({
      phase: "lesson_exercise",
      payload: { widget: "lesson", mode: "exercise", word: "plantation", progress: "1 / 1", ...exercise },
    });
    expect(advanceStudyState(direct, "lesson_start_exercise")).toBe(direct);
    expect(advanceStudyState(direct, "lesson_retry")).toBe(direct);
  });

  it("restores the production-shaped air-conditioning payload without replacing its exercise or navigation", () => {
    const lessonWords = ["vicinity", "lower", "prospect", "thorn", "query", "marital", "pirate", "pit", "quota", "air-conditioning"];
    const legacy = sessionState({
      phase: "lesson_exercise",
      current_word: "air-conditioning",
      current_index: 9,
      flow: { relearn_words: [], lesson_words: lessonWords },
      payload: {
        widget: "lesson",
        mode: "explain",
        word: "air-conditioning",
        title: "当前词",
        progress: "10 / 10",
        widget_version: 7,
        navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 10 },
        exercise: airConditioningExercise,
      },
    });

    const normalized = normalizeStudyStateForRead(legacy);

    expect(normalized.phase).toBe("lesson_exercise");
    expect(normalized.payload.mode).toBe("exercise");
    expect(normalized.current_index).toBe(9);
    expect(normalized.current_word).toBe("air-conditioning");
    expect(normalized.flow.lesson_words).toEqual(lessonWords);
    expect(normalized.payload.navigation).toEqual({
      action: "round_complete", next_word: null, next_index: null, total_count: 10,
    });
    expect(normalized.payload).toMatchObject(airConditioningExercise);
    expect({
      activity_type: normalized.payload.activity_type,
      instruction: normalized.payload.instruction,
      prompt: normalized.payload.prompt,
      multiline: normalized.payload.multiline,
    }).toEqual(airConditioningExercise);
    expect(advanceStudyState(normalized, "lesson_start_exercise")).toBe(normalized);
  });

  it("commits lesson_complete only from the final frozen Lesson cursor", () => {
    const feedback = sessionState({
      phase: "lesson_feedback",
      current_word: "c",
      current_index: 2,
      flow: { relearn_words: [], lesson_words: ["a", "b", "c"] },
      payload: { widget: "lesson", mode: "feedback", word: "c" },
    });
    const completed = advanceStudyState(feedback, "lesson_complete");
    expect(completed).toMatchObject({
      phase: "lesson_complete",
      current_word: "c",
      current_index: 2,
      flow: { lesson_words: ["a", "b", "c"] },
      payload: feedback.payload,
    });
  });

  it("rejects lesson_complete before the last word or with a mismatched cursor", () => {
    const nonFinal = sessionState({
      phase: "lesson_feedback",
      current_word: "a",
      current_index: 0,
      flow: { relearn_words: [], lesson_words: ["a", "b", "c"] },
      payload: { widget: "lesson", mode: "feedback", word: "a" },
    });
    expect(() => advanceStudyState(nonFinal, "lesson_complete")).toThrow("LESSON_NOT_COMPLETE");

    const mismatch = { ...nonFinal, current_word: "wrong", current_index: 2 };
    expect(() => advanceStudyState(mismatch, "lesson_complete")).toThrow("LESSON_NOT_COMPLETE");
  });

  it("makes repeated lesson_complete events idempotent", () => {
    const completed = sessionState({
      phase: "lesson_complete",
      current_word: "c",
      current_index: 2,
      flow: { relearn_words: [], lesson_words: ["a", "b", "c"] },
      payload: { widget: "lesson", mode: "feedback", word: "c" },
    });
    expect(advanceStudyState(completed, "lesson_complete")).toBe(completed);
  });

  it("persists pretest phases and completes the final listen-recall cursor", () => {
    const pretest = makeStudyState({
      date: "2026-09-15",
      widget: "pretest",
      phase: "pretest",
      current_word: "recur",
      current_index: 0,
      retry_count: 0,
      payload: {
        widget: "pretest",
        items: [{ word: "recur" }, { word: "planet" }],
      },
    });
    const result = advanceStudyState(pretest, "pretest_result", 0);
    expect(result).toMatchObject({ phase: "pretest_result", current_word: "recur", current_index: 0 });
    const repeat = advanceStudyState(result, "listen_repeat", 0);
    const recall = advanceStudyState(repeat, "listen_recall", 0);
    expect(recall).toMatchObject({ phase: "listen_recall", current_word: "recur", current_index: 0 });
    const ready = advanceStudyState(recall, "pretest_complete", 2);
    expect(ready).toMatchObject({ phase: "pretest_complete", current_word: null, current_index: 2 });
  });

  it("uses one durable pretest_complete transition for every legal final stage", () => {
    const phases = ["pretest_result", "listen_repeat", "listen_recall"] as const;
    for (const phase of phases) {
      const state = makeStudyState({
        date: "2026-09-15",
        widget: "pretest",
        phase,
        current_word: "recur",
        current_index: 1,
        retry_count: 2,
        flow: { relearn_words: ["failed-word"] },
        payload: { widget: "pretest", items: [{ word: "recur" }, { word: "planet" }] },
      });
      expect(advanceStudyState(state, "pretest_complete", 2)).toMatchObject({
        phase: "pretest_complete",
        current_word: null,
        current_index: 2,
        retry_count: 2,
        flow: { relearn_words: ["failed-word"] },
      });
    }
  });

  it("rejects pretest completion before the terminal cursor", () => {
    const state = makeStudyState({
      date: "2026-09-15",
      widget: "pretest",
      phase: "listen_recall",
      current_word: "recur",
      current_index: 0,
      retry_count: 0,
      payload: { widget: "pretest", items: [{ word: "recur" }, { word: "planet" }] },
    });
    expect(() => advanceStudyState(state, "pretest_complete", 1)).toThrow("terminal cursor");
  });

  it("normalizes only the legacy listen_recall item-count terminal state", () => {
    const legacy = makeStudyState({
      date: "2026-09-15",
      widget: "pretest",
      phase: "listen_recall",
      current_word: null,
      current_index: 2,
      retry_count: 0,
      flow: { relearn_words: ["failed-word"] },
      payload: { widget: "pretest", items: [{ word: "recur" }, { word: "planet" }] },
    });
    const inProgress = { ...legacy, current_index: 1, current_word: "planet" };
    expect(isLegacyCompletedPretestState(legacy)).toBe(true);
    expect(normalizeStudyStateForRead(legacy)).toMatchObject({ phase: "pretest_complete", current_word: null, current_index: 2 });
    expect(isLegacyCompletedPretestState(inProgress)).toBe(false);
    expect(normalizeStudyStateForRead(inProgress)).toMatchObject({
      widget: "pretest",
      current_index: 1,
      current_word: "planet",
      payload: { source: "new_word" },
    });
  });

  it("returns only the durable session summary", () => {
    const state = sessionState();
    const row: StudySessionRow = {
      id: "session",
      user_id: "user",
      started_at: "2026-09-15T00:00:00.000Z",
      ended_at: null,
      new_words_count: 0,
      review_words_count: 0,
      state,
      updated_at: "2026-09-15T00:00:00.000Z",
    };
    expect(studySessionSummary(row)).toEqual({
      active: true,
      widget: "lesson",
      phase: "lesson_explain",
      current_word: "plantation",
      current_index: 0,
    });
    expect(studySessionSummary(null)).toEqual({ active: false });
  });

  it("releases the active session through the existing finish boundary", async () => {
    const activeRow: StudySessionRow = {
      id: "session",
      user_id: "user",
      started_at: "2026-09-15T00:00:00.000Z",
      ended_at: null,
      new_words_count: 9,
      review_words_count: 0,
      state: sessionState({ phase: "lesson_complete", current_word: "plantation", flow: { relearn_words: [], lesson_words: ["plantation"] }, payload: completedWrapupPayload }),
      updated_at: "2026-09-15T00:00:00.000Z",
    };
    const finishedRow = { ...activeRow, ended_at: "2026-09-15T01:00:00.000Z", state: {} };
    let fromCalls = 0;
    let updateValues: Record<string, unknown> | undefined;
    const readBuilder = (result: unknown) => {
      const builder: Record<string, any> = {};
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(async () => result);
      return builder;
    };
    const updateBuilder: Record<string, any> = {};
    updateBuilder.eq = vi.fn(() => updateBuilder);
    updateBuilder.is = vi.fn(() => updateBuilder);
    updateBuilder.select = vi.fn(() => ({
      maybeSingle: vi.fn(async () => ({ data: finishedRow, error: null })),
    }));
    const db = {
      from: vi.fn((table: string) => {
        if (table !== "study_sessions") throw new Error(`unexpected table ${table}`);
        const call = fromCalls++;
        if (call === 0) return readBuilder({ data: activeRow, error: null });
        if (call === 1) {
          return {
            update: vi.fn((values: Record<string, unknown>) => {
              updateValues = values;
              return updateBuilder;
            }),
          };
        }
        return readBuilder({ data: null, error: null });
      }),
    };

    await expect(finishStudySession(db as any, "user")).resolves.toMatchObject({
      id: "session",
      ended_at: finishedRow.ended_at,
    });
    expect(updateValues).toMatchObject({
      ended_at: expect.any(String),
      state: {},
      updated_at: expect.any(String),
    });
    await expect(getActiveStudySession(db as any, "user")).resolves.toBeNull();
  });

  it("allows standalone completion after accepted final primary feedback", async () => {
    const state = makeStudyState({
      date: "2026-09-15", widget: "lesson", phase: "lesson_complete", current_word: "plantation", current_index: 0,
      retry_count: 0, flow: {
        relearn_words: [], lesson_words: ["plantation"],
        lesson_profile_history: [{ word: "plantation", lesson_profile: "quick_recall", error_focus: null }],
      },
      payload: {
        widget: "lesson", mode: "feedback", word: "plantation", lesson_profile: "quick_recall", error_focus: null,
        exercise: { activity_type: "exact_cloze", instruction: "Fill the blank.", prompt: "A tea ___ supports local farms.", multiline: false },
        feedback: { is_correct: true, reveal_answer: false },
      },
    });
    const activeRow: StudySessionRow = {
      id: "session", user_id: "user", started_at: "2026-09-15T00:00:00.000Z", ended_at: null,
      new_words_count: 1, review_words_count: 0, state, updated_at: "2026-09-15T00:00:00.000Z",
    };
    const finishedRow = { ...activeRow, ended_at: "2026-09-15T01:00:00.000Z", state: {} };
    let updateValues: Record<string, unknown> | undefined;
    const readBuilder = (result: unknown) => {
      const builder: Record<string, any> = {};
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(async () => result);
      return builder;
    };
    const updateBuilder: Record<string, any> = {};
    updateBuilder.eq = vi.fn(() => updateBuilder);
    updateBuilder.is = vi.fn(() => updateBuilder);
    updateBuilder.select = vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: finishedRow, error: null })) }));
    let fromCalls = 0;
    const db = { from: vi.fn(() => {
      fromCalls += 1;
      if (fromCalls === 1) return readBuilder({ data: activeRow, error: null });
      return { update: vi.fn((values: Record<string, unknown>) => { updateValues = values; return updateBuilder; }) };
    }) };

    expect(isCompletedLessonRound(state)).toBe(true);
    await expect(finishStudySession(db as any, "user", {
      revision: activeRow.updated_at,
      sessionId: activeRow.id,
      allowLessonRoundCompletion: true,
    })).resolves.toMatchObject({ id: "session", ended_at: finishedRow.ended_at });
    expect(updateValues).toMatchObject({
      ended_at: expect.any(String),
      state: {
        version: 1, widget: "lesson", flow: { relearn_words: [] },
        payload: {
          widget: "lesson", mode: "completed",
          lesson_profiles: [{ word: "plantation", lesson_profile: "quick_recall", error_focus: null }],
        },
      },
    });
  });

  it("rejects finishing before a persisted wrap-up feedback", async () => {
    const activeRow: StudySessionRow = {
      id: "session",
      user_id: "user",
      started_at: "2026-09-15T00:00:00.000Z",
      ended_at: null,
      new_words_count: 9,
      review_words_count: 0,
      state: sessionState({ phase: "lesson_complete", current_word: "plantation" }),
      updated_at: "2026-09-15T00:00:00.000Z",
    };
    const db = { from: vi.fn(() => {
      const builder: Record<string, any> = {};
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(async () => ({ data: activeRow, error: null }));
      return builder;
    }) };

    await expect(finishStudySession(db as any, "user")).rejects.toThrow("LESSON_WRAPUP_NOT_COMPLETE");
  });
});

describe("strict resumable widget schemas", () => {
  it("enforces structural Lesson exercise prompt boundaries", () => {
    const base = {
      mode: "explain" as const,
      word: "reel",
      ipa: "/riːl/",
      part_of_speech: "v.",
      meaning_zh: "受到冲击",
      collocations: [],
      derivations: [],
      example_en: "The team reeled from the result.",
      note: "Use reel from for a strong reaction.",
    };
    expect(lessonInputSchema.safeParse({ ...base, exercise: { activity_type: "cloze", instruction: "完成题目。", prompt: "The course requires ___ study.", accepted_answers: ["reel"], multiline: false } }).success).toBe(true);
    const invalidCloze = lessonInputSchema.safeParse({ ...base, exercise: { activity_type: "cloze", instruction: "完成题目。", prompt: "先理解词义与搭配，再进入练习。", multiline: false } });
    expect(invalidCloze.success).toBe(false);
    if (!invalidCloze.success) {
      expect(invalidCloze.error.issues).toContainEqual(expect.objectContaining({ code: "custom", message: "LESSON_EXERCISE_INVALID", path: ["exercise", "prompt"] }));
    }
    expect(lessonInputSchema.safeParse({ ...base, exercise: { activity_type: "translation_cn_to_en", instruction: "完成题目。", prompt: "这次试验失败后，团队仍深受冲击。", multiline: false } }).success).toBe(true);
    expect(lessonInputSchema.safeParse({ ...base, exercise: { activity_type: "translation_cn_to_en", instruction: "完成题目。", prompt: "Use reel from.", multiline: false } }).success).toBe(false);
    expect(lessonInputSchema.safeParse({ ...base, exercise: { activity_type: "translation_en_to_cn", instruction: "完成题目。", prompt: "The team was reeling from the result.", multiline: false } }).success).toBe(true);
  });

  it("rejects incomplete lesson exercise and feedback payloads", () => {
    expect(lessonInputSchema.safeParse({ mode: "exercise", word: "plantation", progress: "1 / 3", activity_type: "sentence", instruction: "Use it.", multiline: false }).success).toBe(false);
    expect(lessonInputSchema.safeParse({ mode: "feedback", word: "plantation", progress: "1 / 3", feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false } }).success).toBe(false);
    expect(lessonInputSchema.safeParse({ mode: "feedback", word: "plantation", progress: "1 / 3", exercise, feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false } }).success).toBe(true);
    expect(lessonInputSchema.safeParse({ ...explainPayload, navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 1 } }).success).toBe(false);
    expect(lessonInputSchema.safeParse({ resume: true }).success).toBe(true);
  });

  it("keeps resume input free of arbitrary payload fields", () => {
    expect(pretestInputSchema.safeParse({ resume: true }).success).toBe(true);
    expect(pretestInputSchema.safeParse({ resume: true, items: [] }).success).toBe(false);
    expect(dictationInputSchema.safeParse({ resume: true }).success).toBe(true);
    expect(dictationInputSchema.safeParse({ resume: true, text: "new text" }).success).toBe(false);
  });
});

describe("study session migration", () => {
  it("only adds the two state columns and active-session index", () => {
    const sql = readFileSync(new URL("../supabase/migrations/202609150004_study_session_state.sql", import.meta.url), "utf8");
    expect(sql).toContain("add column if not exists state jsonb not null default '{}'::jsonb");
    expect(sql).toContain("add column if not exists updated_at timestamptz not null default now()");
    expect(sql).toContain("study_sessions_active_idx");
    expect(sql).toContain("where ended_at is null");
    expect(sql).not.toMatch(/create table/i);
  });

  it("adds only integrity guards and the atomic review submission RPC", () => {
    const sql = readFileSync(new URL("../supabase/migrations/202609150005_integrity_guards.sql", import.meta.url), "utf8");
    expect(sql).toContain("study_sessions_one_active_per_user");
    expect(sql).toContain("ended_at = now()");
    expect(sql).toContain("state = '{}'::jsonb");
    expect(sql).toContain("FSRS_CARD_NOT_DUE");
    expect(sql).toContain("record_review_submission_v1");
    expect(sql).not.toMatch(/create table/i);
  });

  it("adds a bounded due-only Review snapshot RPC", () => {
    const sql = readFileSync(new URL("../supabase/migrations/202609160007_review_session.sql", import.meta.url), "utf8");
    expect(sql).toContain("get_due_review_candidates_v1");
    expect(sql).toContain("uw.next_review_at is not null");
    expect(sql).toContain("uw.next_review_at <= p_now");
    expect(sql).toContain("order by uw.next_review_at asc, w.normalized_word asc");
    expect(sql).toContain("limit least(greatest(coalesce(p_limit, 0), 0), 200)");
    expect(sql).not.toMatch(/meaning_error\s+or|collocation_error\s+or|spelling_error\s+or/);
  });

  it("recognizes only the explicit pre-004 study-session column mismatch", () => {
    expect(isStudySessionSchemaMismatch({ message: "Could not find the 'state' column of 'study_sessions' in the schema cache" })).toBe(true);
    expect(isStudySessionSchemaMismatch({ message: "column public.study_sessions.updated_at does not exist", code: "42703" })).toBe(true);
    expect(isStudySessionSchemaMismatch({ message: "Database connection failed" })).toBe(false);
    expect(isStudySessionSchemaMismatch({ message: "permission denied for table study_sessions" })).toBe(false);
  });
});
