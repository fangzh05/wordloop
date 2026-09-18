import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  advanceStudyState,
  finishStudySession,
  getActiveStudySession,
  isStudySessionSchemaMismatch,
  makeStudyState,
  isLegacyCompletedPretestState,
  normalizeStudyStateForRead,
  studySessionSummary,
} from "../server/services/studySessions.js";
import {
  dictationInputSchema,
  lessonInputSchema,
  pretestInputSchema,
} from "../server/tools/renderWidgets.js";
import type { StudySessionRow } from "../server/types.js";

const exercise = {
  activity_type: "sentence",
  instruction: "Use the word in a new scene.",
  prompt: "The researchers observed a recurring pattern.",
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

describe("durable study session state", () => {
  it("projects explain into the exact exercise without a new GPT turn", () => {
    const next = advanceStudyState(sessionState(), "lesson_start_exercise");
    expect(next.phase).toBe("lesson_exercise");
    expect(next.current_word).toBe("plantation");
    expect(next.retry_count).toBe(0);
    expect(next.payload).toEqual(explainPayload);
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
    expect(next.payload).toEqual(feedback.payload);
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
    expect(normalizeStudyStateForRead(inProgress)).toBe(inProgress);
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
      single: vi.fn(async () => ({ data: finishedRow, error: null })),
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
    expect(lessonInputSchema.safeParse({ ...base, exercise: { activity_type: "cloze", instruction: "完成题目。", prompt: "The course requires ___ study.", multiline: false } }).success).toBe(true);
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
