import { describe, expect, it } from "vitest";
import type { UserWordRow, StudySessionRow } from "../server/types.js";
import { recordReviewSubmission } from "../server/services/fsrsReviews.js";
import { makeStudyState } from "../server/services/studySessions.js";
import type { RecordReviewSubmissionInput, ReviewWidgetPayload } from "../shared/toolContracts.js";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";

function reviewPayload(words: string[]): ReviewWidgetPayload {
  return {
    widget: "review",
    items: words.map((word) => ({
      word,
      meaning_zh: "测试含义",
      direction: "cn_to_en",
      error_layers: [],
      is_due: true,
      review_kind: "fsrs_due",
      next_review_at: "2026-09-18T00:00:00Z",
    })),
    title: "复习",
  };
}

function reviewSession(words: string[]): StudySessionRow {
  const payload = reviewPayload(words);
  const state = makeStudyState({
    date: "2026-09-19",
    widget: "review",
    phase: "review",
    current_word: words[0] ?? null,
    current_index: 0,
    retry_count: 0,
    payload,
  });
  return {
    id: sessionId,
    user_id: userId,
    started_at: "2026-09-19T00:00:00Z",
    ended_at: null,
    new_words_count: 0,
    review_words_count: words.length,
    state,
    updated_at: "2026-09-19T00:00:00Z",
  };
}

function userWord(nextReviewAt = "2026-09-18T00:00:00Z"): UserWordRow {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    user_id: userId,
    word_id: "00000000-0000-4000-8000-000000000004",
    status: "review",
    source: "test",
    first_seen_at: "2026-09-01T00:00:00Z",
    last_seen_at: "2026-09-18T00:00:00Z",
    last_reviewed_at: "2026-09-17T00:00:00Z",
    correct_count: 1,
    wrong_count: 0,
    consecutive_correct: 1,
    meaning_error: false,
    collocation_error: false,
    grammar_error: false,
    pronunciation_error: false,
    spelling_error: false,
    mastered: false,
    next_review_at: nextReviewAt,
    fsrs_stability: 1,
    fsrs_difficulty: 5,
    fsrs_elapsed_days: 1,
    fsrs_scheduled_days: 1,
    fsrs_learning_steps: 0,
    fsrs_reps: 1,
    fsrs_lapses: 0,
    fsrs_state: 2,
  };
}

type FakeDbOptions = {
  session: StudySessionRow;
  word?: UserWordRow;
  rpcError?: { message: string };
  failUpdateOnce?: boolean;
  sessionHistory?: Array<{ id: string; ended_at: string | null; state: unknown }>;
  attempts?: Array<{ session_id: string | null; activity_type: string; is_correct: boolean; created_at: string }>;
};

function fakeDatabase(options: FakeDbOptions) {
  let activeSession = options.session;
  let row = options.word ?? userWord();
  let failUpdate = options.failUpdateOnce ?? false;
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let updateAttempts = 0;
  let successfulUpdates = 0;

  const db = {
    from(table: string) {
      let updateValues: Record<string, unknown> | undefined;
      const query = {
        select() { return query; },
        eq() { return query; },
        gte() { return query; },
        lt() { return query; },
        in() { return query; },
        is() { return query; },
        order() { return query; },
        limit() { return query; },
        update(values: Record<string, unknown>) {
          updateValues = values;
          return query;
        },
        async single() {
          if (table === "user_words") return { data: row, error: null };
          updateAttempts += 1;
          if (failUpdate) {
            failUpdate = false;
            return { data: null, error: { message: "cursor update failed" } };
          }
          if (updateValues?.state) activeSession = { ...activeSession, state: updateValues.state as StudySessionRow["state"] };
          if (typeof updateValues?.updated_at === "string") activeSession = { ...activeSession, updated_at: updateValues.updated_at };
          successfulUpdates += 1;
          return { data: activeSession, error: null };
        },
        async maybeSingle() {
          if (table === "users") return { data: { timezone: "Asia/Shanghai" }, error: null };
          return { data: activeSession, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          const data = table === "study_sessions" ? options.sessionHistory ?? []
            : table === "attempts" ? options.attempts ?? []
              : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (options.rpcError) return { data: null, error: options.rpcError };
      const card = args.p_card as Record<string, unknown>;
      row = { ...row, next_review_at: card.next_review_at as string };
      return { data: { attempt: { saved: true }, review: { saved: true } }, error: null };
    },
  };
  return {
    db,
    get session() { return activeSession; },
    get row() { return row; },
    rpcCalls,
    get updateAttempts() { return updateAttempts; },
    get successfulUpdates() { return successfulUpdates; },
  };
}

const submission: RecordReviewSubmissionInput = {
  word: "recur",
  user_answer: "recur",
  is_correct: true,
  error_layer: "none",
  rating: "good",
  direction: "cn_to_en",
};

const failedSubmission: RecordReviewSubmissionInput = {
  ...submission,
  is_correct: false,
  error_layer: "meaning",
  rating: "again",
};

describe("server-owned Review submission cursor", () => {
  it("persists attempt and FSRS once, then advances the due cursor", async () => {
    const fake = fakeDatabase({ session: reviewSession(["recur", "planet"]) });

    await recordReviewSubmission(submission, new Date("2026-09-19T00:00:00Z"), false, fake.db as never, userId);

    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0]?.name).toBe("record_review_submission_v1");
    expect(fake.successfulUpdates).toBe(1);
    expect(fake.session.state).toMatchObject({ phase: "review", current_word: "planet", current_index: 1 });
  });

  it("marks the final card complete through the same single submission", async () => {
    const fake = fakeDatabase({ session: reviewSession(["recur"]) });

    await recordReviewSubmission(submission, new Date("2026-09-19T00:00:00Z"), false, fake.db as never, userId);

    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.session.state).toMatchObject({ phase: "review_complete", current_word: null, current_index: 1 });
  });

  it("allows a first failed Review to enter the Lesson relearn queue", async () => {
    const fake = fakeDatabase({ session: reviewSession(["recur"]) });

    await recordReviewSubmission(failedSubmission, new Date("2026-09-19T00:00:00Z"), false, fake.db as never, userId);

    expect(fake.rpcCalls[0]?.name).toBe("record_review_submission_v1");
    expect(fake.rpcCalls[0]?.args.p_is_correct).toBe(false);
    expect(fake.session.state?.flow.relearn_words).toEqual(["recur"]);
  });

  it("continues FSRS after a same-day Lesson relearn without queueing that word again", async () => {
    const initialNextReviewAt = "2026-09-18T00:00:00Z";
    const fake = fakeDatabase({
      session: reviewSession(["recur"]),
      word: userWord(initialNextReviewAt),
      sessionHistory: [{ id: "finished-relearn", ended_at: "2026-09-19T03:00:00Z", state: {} }],
      attempts: [
        { session_id: "finished-relearn", activity_type: "review", is_correct: false, created_at: "2026-09-19T01:00:00Z" },
        { session_id: "finished-relearn", activity_type: "cloze", is_correct: true, created_at: "2026-09-19T02:00:00Z" },
      ],
    });

    await recordReviewSubmission(failedSubmission, new Date("2026-09-19T04:00:00Z"), false, fake.db as never, userId);

    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0]?.name).toBe("record_review_submission_v1");
    expect(fake.row.next_review_at).not.toBe(initialNextReviewAt);
    expect(fake.session.state).toMatchObject({ phase: "review_complete", current_index: 1, flow: { relearn_words: [] } });
  });

  it("does not advance the cursor when the FSRS RPC fails", async () => {
    const fake = fakeDatabase({
      session: reviewSession(["recur"]),
      rpcError: { message: "FSRS write failed" },
    });

    await expect(recordReviewSubmission(submission, new Date("2026-09-19T00:00:00Z"), false, fake.db as never, userId))
      .rejects.toThrow("FSRS write failed");
    expect(fake.successfulUpdates).toBe(0);
    expect(fake.session.state).toMatchObject({ phase: "review", current_word: "recur", current_index: 0 });
  });

  it("recovers a lost cursor response without repeating FSRS, and stays idempotent", async () => {
    const fake = fakeDatabase({ session: reviewSession(["recur"]), failUpdateOnce: true });

    await expect(recordReviewSubmission(submission, new Date("2026-09-19T00:00:00Z"), false, fake.db as never, userId))
      .rejects.toThrow("cursor update failed");
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.session.state).toMatchObject({ phase: "review", current_word: "recur", current_index: 0 });

    await recordReviewSubmission(submission, new Date("2026-09-19T00:00:00Z"), false, fake.db as never, userId);
    await recordReviewSubmission(submission, new Date("2026-09-19T00:00:00Z"), false, fake.db as never, userId);

    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.successfulUpdates).toBe(1);
    expect(fake.session.state).toMatchObject({ phase: "review_complete", current_word: null, current_index: 1 });
  });
});
