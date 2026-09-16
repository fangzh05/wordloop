import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VocabularyItem } from "../server/types.js";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(() => "user"),
  getDatabase: vi.fn(),
  getTodayWords: vi.fn(),
  getUserTimeZone: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
  getDatabase: mocks.getDatabase,
}));
vi.mock("../server/services/words.js", () => ({
  getTodayWords: mocks.getTodayWords,
  getUserTimeZone: mocks.getUserTimeZone,
}));

import { normalizeLegacyLessonSession } from "../server/services/studySessions.js";

function item(word: string, status: VocabularyItem["status"] = "review"): VocabularyItem {
  return {
    word,
    display_word: word,
    status,
    source: "test",
    consecutive_correct: 1,
    wrong_count: 0,
    mastered: false,
    next_review_at: null,
    error_layers: [],
    fsrs_stability: 1,
    fsrs_difficulty: 5,
    fsrs_scheduled_days: 1,
    fsrs_state: 2,
  };
}

function makeDb(attemptRows: unknown[]) {
  let updateValues: Record<string, unknown> | null = null;
  const attemptsBuilder: Record<string, any> = {};
  attemptsBuilder.select = vi.fn(() => attemptsBuilder);
  attemptsBuilder.eq = vi.fn(() => attemptsBuilder);
  attemptsBuilder.gte = vi.fn(() => attemptsBuilder);
  attemptsBuilder.order = vi.fn(async () => ({ data: attemptRows, error: null }));

  const sessionsBuilder: Record<string, any> = {};
  sessionsBuilder.update = vi.fn((values: Record<string, unknown>) => {
    updateValues = values;
    return sessionsBuilder;
  });
  sessionsBuilder.eq = vi.fn(() => sessionsBuilder);
  sessionsBuilder.is = vi.fn(() => sessionsBuilder);
  sessionsBuilder.select = vi.fn(() => ({
    single: vi.fn(async () => ({
      data: {
        id: "session",
        user_id: "user",
        started_at: "2026-09-15T00:00:00.000Z",
        ended_at: null,
        new_words_count: 0,
        review_words_count: 0,
        state: updateValues?.state,
        updated_at: "2026-09-16T00:00:00.000Z",
      },
      error: null,
    })),
  }));

  const db = {
    from: vi.fn((table: string) => table === "attempts" ? attemptsBuilder : sessionsBuilder),
  };
  return { db, attemptsBuilder, sessionsBuilder };
}

describe("legacy Lesson queue recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes once from attempts plus the session-date words and fixes the cursor", async () => {
    const todayWords = [
      item("marine"), item("thermometer"), item("rectify"),
      item("reed"), item("via"), item("interpret"),
    ];
    mocks.getTodayWords.mockResolvedValue(todayWords);
    const { db, attemptsBuilder, sessionsBuilder } = makeDb([
      ...["planet", "shrink"].map((word) => ({
        activity_type: "review",
        created_at: "2026-09-15T00:00:00.000Z",
        word: { normalized_word: word },
      })),
      ...["expression", "marine", "thermometer", "rectify", "reed", "via", "interpret"].map((word) => ({
        activity_type: "sentence",
        created_at: "2026-09-15T00:00:00.000Z",
        word: { normalized_word: word },
      })),
    ]);
    const session = {
      id: "session",
      user_id: "user",
      started_at: "2026-09-15T00:00:00.000Z",
      ended_at: null,
      new_words_count: 0,
      review_words_count: 0,
      updated_at: "2026-09-16T00:00:00.000Z",
      state: {
        version: 1 as const,
        date: "2026-09-15",
        widget: "lesson" as const,
        phase: "lesson_feedback" as const,
        current_word: "interpret",
        current_index: 6,
        retry_count: 0,
        flow: { relearn_words: ["expression", "planet", "shrink"] },
        payload: { widget: "lesson", word: "interpret" },
      },
    };

    const normalized = await normalizeLegacyLessonSession(session, db as any, "user");

    expect(normalized.state?.flow.lesson_words).toEqual([
      "expression", "marine", "thermometer", "rectify", "reed", "via", "interpret", "planet", "shrink",
    ]);
    expect(normalized.state?.current_index).toBe(6);
    expect(sessionsBuilder.update).toHaveBeenCalledOnce();
    expect(attemptsBuilder.gte).toHaveBeenCalledWith("created_at", session.started_at);

    const second = await normalizeLegacyLessonSession(normalized, db as any, "user");
    expect(second).toBe(normalized);
    expect(mocks.getTodayWords).toHaveBeenCalledOnce();
    expect(sessionsBuilder.update).toHaveBeenCalledOnce();
  });
});
