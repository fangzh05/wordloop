// These tests isolate the original flow; budget admission is exercised in learningBudget.test.ts.
vi.mock("../server/services/learningBudget.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/services/learningBudget.js")>(),
  getLearningBudget: vi.fn(async () => ({ date:"2026-10-02",daily_minutes:45,remaining_seconds:2700,estimated_used_seconds:0,due_count:0,overdue_count:0,new_word_cap:50,effective_new_limit:50,enabled:true,forecast:[] })),
  reserveLearningBudget: vi.fn(async () => undefined),
}));
import { describe, expect, it, vi } from "vitest";
import { Rating, State } from "ts-fsrs";
import { buildLessonWords } from "../server/services/lessonQueue.js";
import { getDueReviewSelection } from "../server/services/review.js";
import { recordPretestResult } from "../server/services/words.js";
import type { UserWordRow, VocabularyItem } from "../server/types.js";

const NOW = new Date("2026-09-28T00:00:00.000Z");
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_ID = "00000000-0000-4000-8000-000000000001";

function freshWord(): UserWordRow {
  return {
    id: "user-word",
    user_id: USER_ID,
    word_id: "fresh-word",
    status: "new",
    source: "test",
    first_seen_at: NOW.toISOString(),
    last_seen_at: NOW.toISOString(),
    last_reviewed_at: null,
    correct_count: 0,
    wrong_count: 0,
    consecutive_correct: 0,
    meaning_error: false,
    collocation_error: false,
    grammar_error: false,
    pronunciation_error: false,
    spelling_error: false,
    mastered: false,
    next_review_at: NOW.toISOString(),
    fsrs_stability: 0,
    fsrs_difficulty: 0,
    fsrs_elapsed_days: 0,
    fsrs_scheduled_days: 0,
    fsrs_learning_steps: 0,
    fsrs_reps: 0,
    fsrs_lapses: 0,
    fsrs_state: State.New,
  };
}

function lessonItem(status: VocabularyItem["status"], nextReviewAt: string): VocabularyItem {
  return {
    word: "fresh-word",
    display_word: "fresh-word",
    status,
    source: "test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: nextReviewAt,
    error_layers: [],
    fsrs_stability: 0,
    fsrs_difficulty: 0,
    fsrs_scheduled_days: 0,
    fsrs_state: State.Review,
  };
}

function pretestDb() {
  let stored = freshWord();
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const lookup: any = {
    select: () => lookup,
    eq: () => lookup,
    single: async () => ({ data: stored, error: null }),
  };
  const db = {
    from: () => lookup,
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "record_pretest_result_v2") {
        stored = { ...stored, ...(args.p_card as Partial<UserWordRow>) };
        return { data: { word: "fresh-word", result: args.p_result }, error: null };
      }
      if (name === "get_due_review_states_v1") {
        const due = Date.parse(stored.next_review_at ?? "") <= Date.parse(String(args.p_now));
        return {
          data: due ? [{
            state: stored,
            word: { normalized_word: "fresh-word", display_word: "fresh-word", senses: [] },
          }] : [],
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  return { db, rpcCalls };
}

describe("Fresh Pretest → Lesson → long-term FSRS flow", () => {
  it.each([
    { result: "known" as const, status: "known" as const, rating: Rating.Good, minDays: 2, maxDays: 5, lesson: false },
    { result: "uncertain" as const, status: "uncertain" as const, rating: Rating.Hard, minDays: 1.5, maxDays: 3, lesson: true },
    { result: "unknown" as const, status: "unknown" as const, rating: Rating.Again, minDays: 0.75, maxDays: 1.5, lesson: true },
  ])("keeps $result on its existing Pretest path with a day-scale due", async ({ result, status, rating, minDays, maxDays, lesson }) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const fake = pretestDb();
      await recordPretestResult({ word: "fresh-word", result }, fake.db as never, USER_ID);

      const pretestCall = fake.rpcCalls.find((call) => call.name === "record_pretest_result_v2");
      expect(pretestCall).toBeDefined();
      expect(pretestCall?.args).toMatchObject({
        p_user_id: USER_ID,
        p_normalized_word: "fresh-word",
        p_result: result,
        p_activity_type: "pretest_cn_to_en",
        p_rating: rating,
      });
      const card = pretestCall?.args.p_card as Record<string, unknown>;
      const log = pretestCall?.args.p_log as Record<string, unknown>;
      const due = Date.parse(String(card.next_review_at));
      const intervalDays = (due - NOW.getTime()) / DAY_MS;
      expect(card.fsrs_state).toBe(State.Review);
      expect(card.fsrs_learning_steps).toBe(0);
      expect(log.rating).toBe(rating);
      expect(Number.isFinite(Number(card.fsrs_stability))).toBe(true);
      expect(Number.isFinite(Number(card.fsrs_difficulty))).toBe(true);
      expect(due - NOW.getTime()).toBeGreaterThan(EIGHT_HOURS);
      expect(intervalDays).toBeGreaterThanOrEqual(minDays);
      expect(intervalDays).toBeLessThanOrEqual(maxDays);

      const lessonWords = buildLessonWords([], [lessonItem(status, String(card.next_review_at))]);
      expect(lessonWords).toEqual(lesson ? ["fresh-word"] : []);

      // Lesson completion does not reschedule FSRS. The normal due requery
      // therefore still has no same-day formal Review for this fresh word.
      const afterLesson = new Date(NOW.getTime() + EIGHT_HOURS);
      const dueSelection = await getDueReviewSelection(25, fake.db as never, USER_ID, afterLesson);
      expect(dueSelection.rollingReview).toEqual([]);
      expect(fake.rpcCalls.at(-1)?.args.p_now).toBe(afterLesson.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });
});
