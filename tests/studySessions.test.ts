import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceStudyState,
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
});

describe("strict resumable widget schemas", () => {
  it("rejects incomplete lesson exercise and feedback payloads", () => {
    expect(lessonInputSchema.safeParse({ mode: "exercise", word: "plantation", progress: "1 / 3", activity_type: "sentence", instruction: "Use it.", multiline: false }).success).toBe(false);
    expect(lessonInputSchema.safeParse({ mode: "feedback", word: "plantation", progress: "1 / 3", feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false } }).success).toBe(false);
    expect(lessonInputSchema.safeParse({ mode: "feedback", word: "plantation", progress: "1 / 3", exercise, feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false } }).success).toBe(true);
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
