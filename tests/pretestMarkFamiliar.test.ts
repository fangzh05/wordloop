import { describe, expect, it, vi } from "vitest";
import { buildLessonWords } from "../server/services/lessonQueue.js";
import { selectDueReviewWords } from "../server/services/review.js";
import { makeStudyState, markPretestFamiliar } from "../server/services/studySessions.js";
import type { StudySessionRow, StudyState, VocabularyItem } from "../server/types.js";
import { readFileSync } from "node:fs";

const expectedRevision = "2026-09-28T01:00:00.000Z";

function pretestState(overrides: Partial<Parameters<typeof makeStudyState>[0]> = {}): StudyState {
  return makeStudyState({
    date: "2026-09-28",
    widget: "pretest",
    phase: "pretest_result",
    current_word: "alleviate",
    current_index: 0,
    retry_count: 0,
    flow: { relearn_words: ["alleviate", "earlier-review-word"] },
    payload: {
      widget: "pretest",
      source: "new_word",
      items: [{ word: "alleviate" }, { word: "recur" }],
    },
    ...overrides,
  });
}

function vocabulary(word: string, status: VocabularyItem["status"]): VocabularyItem {
  return {
    word,
    display_word: word,
    status,
    source: "daily",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: "2026-09-28T01:30:00.000Z",
    error_layers: [],
    fsrs_stability: 0.5,
    fsrs_difficulty: 6,
    fsrs_scheduled_days: 0,
    fsrs_state: 1,
  };
}

function familiarInput(expected = expectedRevision) {
  return {
    action: "pretest_mark_familiar" as const,
    word: "alleviate",
    current_index: 0,
    expected_revision: expected,
  };
}

function fixture(status = "unknown", state = pretestState()) {
  let session: StudySessionRow = {
    id: "session-1",
    user_id: "user-1",
    started_at: "2026-09-28T00:00:00.000Z",
    ended_at: null,
    new_words_count: 0,
    review_words_count: 0,
    state,
    updated_at: expectedRevision,
  };
  const userWord = {
    id: "user-word-1",
    status,
    correct_count: 1,
    wrong_count: 1,
    mastered: false,
    next_review_at: "2026-09-28T01:30:00.000Z",
    fsrs_state: 1,
    fsrs_reps: 1,
  };
  const attempt = {
    user_answer: "aleviate",
    is_correct: true,
    error_layer: "spelling",
    activity_type: "pretest_cn_to_en",
  };
  const reviewLog = { rating: "Hard", source: "pretest" };
  const tableCalls: string[] = [];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  let rpcCalls = 0;

  const db = {
    from(table: string) {
      tableCalls.push(table);
      let operation: "select" | "update" = "select";
      let values: Record<string, unknown> = {};
      const filters = new Map<string, unknown>();
      const builder: Record<string, any> = {};
      builder.select = vi.fn(() => builder);
      builder.update = vi.fn((next: Record<string, unknown>) => {
        operation = "update";
        values = next;
        updates.push({ table, values: next });
        return builder;
      });
      builder.eq = vi.fn((key: string, value: unknown) => {
        filters.set(key, value);
        return builder;
      });
      builder.is = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.in = vi.fn(() => builder);
      builder.gte = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(async () => {
        if (table === "user_words") {
          if (operation === "select") return { data: { ...userWord, word: { normalized_word: "alleviate" } }, error: null };
          Object.assign(userWord, values);
          return { data: userWord, error: null };
        }
        if (table !== "study_sessions") throw new Error(`unexpected maybeSingle on ${table}`);
        if (operation === "select") return { data: session, error: null };
        if (filters.get("updated_at") !== session.updated_at) return { data: null, error: null };
        session = { ...session, ...values } as StudySessionRow;
        return { data: session, error: null };
      });
      builder.single = vi.fn(async () => {
        if (table !== "user_words") throw new Error(`unexpected single on ${table}`);
        if (operation === "select") {
          return { data: { ...userWord, word: { normalized_word: "alleviate" } }, error: null };
        }
        Object.assign(userWord, values);
        return { data: userWord, error: null };
      });
      return builder;
    },
    rpc: vi.fn(async () => {
      rpcCalls += 1;
      return { data: null, error: null };
    }),
  };

  return {
    db,
    get session() { return session; },
    userWord,
    attempt,
    reviewLog,
    tableCalls,
    updates,
    get rpcCalls() { return rpcCalls; },
  };
}

describe("pretest_mark_familiar", () => {
  it("marks a spelling near miss known, preserves its attempt and Hard log, and advances once", async () => {
    const data = fixture();
    const result = await markPretestFamiliar(familiarInput(), data.db as never, "user-1");

    expect(data.userWord).toMatchObject({
      status: "known",
      correct_count: 1,
      wrong_count: 1,
      mastered: false,
      next_review_at: "2026-09-28T01:30:00.000Z",
      fsrs_state: 1,
      fsrs_reps: 1,
    });
    expect(data.session).toMatchObject({
      new_words_count: 1,
      review_words_count: 0,
      state: {
        phase: "pretest",
        current_word: "recur",
        current_index: 1,
        flow: {
          relearn_words: ["earlier-review-word"],
          pretest_familiar_words: ["alleviate"],
        },
      },
    });
    expect(result).toMatchObject({ action: "pretest_mark_familiar", word: "alleviate", current_word: "recur" });
    expect(data.attempt).toEqual({
      user_answer: "aleviate",
      is_correct: true,
      error_layer: "spelling",
      activity_type: "pretest_cn_to_en",
    });
    expect(data.reviewLog).toEqual({ rating: "Hard", source: "pretest" });
    expect(data.tableCalls).not.toContain("attempts");
    expect(data.rpcCalls).toBe(0);
    expect(data.updates.filter((entry) => entry.table === "user_words")).toHaveLength(1);
    expect(data.updates.filter((entry) => entry.table === "study_sessions")).toHaveLength(1);
  });

  it("excludes a familiar word from lesson_words, relearn, and current uncertain routing", async () => {
    const data = fixture();
    await markPretestFamiliar(familiarInput(), data.db as never, "user-1");
    const flow = data.session.state!.flow;
    const queue = buildLessonWords(
      flow.relearn_words,
      [vocabulary("alleviate", "unknown"), vocabulary("recur", "uncertain"), vocabulary("other", "unknown")],
      new Set(),
      flow.pretest_familiar_words,
    );
    expect(queue).toEqual(["earlier-review-word", "recur", "other"]);
    expect(queue).not.toContain("alleviate");
  });

  it("keeps a known Pretest out of Lesson and only offers correction for non-known results", async () => {
    const { shouldOfferMarkFamiliar } = await import("../web/src/pretest/PretestWidget.js");
    expect(shouldOfferMarkFamiliar("new_word", "known")).toBe(false);
    expect(buildLessonWords([], [vocabulary("alleviate", "known")], new Set())).toEqual([]);
  });

  it("rejects the action for Review and other non-new-word sources", async () => {
    const review = fixture("unknown", makeStudyState({
      date: "2026-09-28",
      widget: "review",
      phase: "review",
      current_word: "alleviate",
      current_index: 0,
      retry_count: 0,
      payload: { widget: "review", items: [{ word: "alleviate" }] },
    }));
    await expect(markPretestFamiliar(familiarInput(), review.db as never, "user-1"))
      .rejects.toThrow("PRETEST_SESSION_NOT_ACTIVE");

    const wrongSource = fixture("unknown", pretestState({ payload: {
      widget: "pretest",
      source: "review",
      items: [{ word: "alleviate" }, { word: "recur" }],
    } }));
    await expect(markPretestFamiliar(familiarInput(), wrongSource.db as never, "user-1"))
      .rejects.toThrow("PRETEST_FAMILIAR_SOURCE_NOT_ALLOWED");
  });

  it("requires the matching revision and hides the action when Pretest already classified the word known", async () => {
    const stale = fixture();
    await expect(markPretestFamiliar(familiarInput("2026-09-28T00:59:59.000Z"), stale.db as never, "user-1"))
      .rejects.toThrow("STUDY_SESSION_REVISION_MISMATCH");
    expect(stale.updates).toHaveLength(0);

    const alreadyKnown = fixture("known");
    await expect(markPretestFamiliar(familiarInput(), alreadyKnown.db as never, "user-1"))
      .rejects.toThrow("PRETEST_FAMILIAR_ALREADY_KNOWN");
    expect(alreadyKnown.updates).toHaveLength(0);
  });

  it("rejects familiar correction before the Pretest answer is revealed", async () => {
    const beforeReveal = fixture("unknown", pretestState({ phase: "pretest" }));
    await expect(markPretestFamiliar(familiarInput(), beforeReveal.db as never, "user-1"))
      .rejects.toThrow("PRETEST_FAMILIAR_CURSOR_MISMATCH");
    expect(beforeReveal.updates).toHaveLength(0);
  });

  it("retries the same expected revision without skipping another word or repeating counters", async () => {
    const data = fixture();
    await markPretestFamiliar(familiarInput(), data.db as never, "user-1");
    const afterFirstAction = data.session;
    const result = await markPretestFamiliar(familiarInput(), data.db as never, "user-1");

    expect(result.current_index).toBe(1);
    expect(result.current_word).toBe("recur");
    expect(data.session.new_words_count).toBe(1);
    expect(data.session.state?.current_index).toBe(1);
    expect(data.updates.filter((entry) => entry.table === "study_sessions")).toHaveLength(1);
    expect(data.updates.filter((entry) => entry.table === "user_words")).toHaveLength(1);
    expect(data.session.updated_at).toBe(afterFirstAction.updated_at);
    expect(data.attempt.user_answer).toBe("aleviate");
    expect(data.reviewLog.rating).toBe("Hard");
  });

  it("does not permanently master or blacklist a marked word", async () => {
    const data = fixture("unknown");
    await markPretestFamiliar(familiarInput(), data.db as never, "user-1");
    expect(data.userWord.mastered).toBe(false);
    expect(data.userWord.next_review_at).toBe("2026-09-28T01:30:00.000Z");
    expect(data.session.state?.flow.pretest_familiar_words).toEqual(["alleviate"]);
    expect(data.session.state?.payload).not.toHaveProperty("mastered");
    expect(selectDueReviewWords(
      [vocabulary("alleviate", "known")],
      5,
      new Date("2026-09-28T02:00:00.000Z"),
    ).map((item) => item.word)).toEqual(["alleviate"]);
  });

  it("keeps familiar action out of the Review Widget", () => {
    const reviewSource = readFileSync(new URL("../web/src/review/ReviewWidget.tsx", import.meta.url), "utf8");
    expect(reviewSource).not.toContain("pretest_mark_familiar");
    expect(reviewSource).not.toContain("我本来会这个词");
  });
});
