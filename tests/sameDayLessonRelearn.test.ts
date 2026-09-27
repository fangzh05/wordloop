import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserTimeZone: vi.fn(async () => "Asia/Shanghai"),
}));

vi.mock("../server/services/words.js", () => ({
  getUserTimeZone: mocks.getUserTimeZone,
  getTodayWords: vi.fn(),
}));
vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: vi.fn(() => "user"),
  getDatabase: vi.fn(() => ({})),
}));

import { hasCompletedLessonRelearnToday } from "../server/services/studySessions.js";

type QueryCall = [string, unknown];
function query(result: unknown) {
  const calls: Record<string, QueryCall[]> = { eq: [], gte: [], lt: [], in: [] };
  const builder: Record<string, any> = {};
  builder.select = vi.fn(() => builder);
  for (const method of ["eq", "gte", "lt", "in"]) {
    builder[method] = vi.fn((column: string, value: unknown) => {
      calls[method]?.push([column, value]);
      return builder;
    });
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { builder, calls };
}

function database(input: {
  sessions: Array<{ id: string; ended_at: string | null; state: unknown }>;
  attempts: Array<{ session_id: string | null; activity_type: string; is_correct: boolean; created_at: string }>;
}) {
  const sessionQuery = query({ data: input.sessions, error: null });
  const attemptQuery = query({ data: input.attempts, error: null });
  const db = {
    from: vi.fn((table: string) => table === "study_sessions" ? sessionQuery.builder : attemptQuery.builder),
  };
  return { db, sessionQuery, attemptQuery };
}

describe("same-day Lesson relearn limit", () => {
  it("recognizes a completed relearn in an active session using only today's attempts", async () => {
    const { db, sessionQuery, attemptQuery } = database({
      sessions: [{ id: "active-session", ended_at: null, state: {} }],
      attempts: [
        { session_id: "active-session", activity_type: "review", is_correct: false, created_at: "2026-09-19T01:00:00.000Z" },
        { session_id: "active-session", activity_type: "cloze", is_correct: true, created_at: "2026-09-19T02:00:00.000Z" },
      ],
    });

    await expect(hasCompletedLessonRelearnToday(
      "Embark",
      new Date("2026-09-19T04:00:00.000Z"),
      db as any,
      "user",
    )).resolves.toBe(true);

    expect(sessionQuery.calls.eq).toContainEqual(["user_id", "user"]);
    expect(attemptQuery.calls.eq).toContainEqual(["user_id", "user"]);
    expect(attemptQuery.calls.gte).toContainEqual(["created_at", "2026-09-18T16:00:00.000Z"]);
    expect(attemptQuery.calls.lt).toContainEqual(["created_at", "2026-09-19T16:00:00.000Z"]);
    expect(attemptQuery.calls.in).toContainEqual([
      "activity_type",
      expect.arrayContaining(["review", "exact_cloze", "cloze", "sentence", "word_recall"]),
    ]);
  });

  it("allows the first relearn after a normal Lesson that happened before the failed Review", async () => {
    const { db } = database({
      sessions: [{ id: "active-session", ended_at: null, state: {} }],
      attempts: [
        { session_id: "active-session", activity_type: "cloze", is_correct: true, created_at: "2026-09-19T00:30:00.000Z" },
        { session_id: "active-session", activity_type: "review", is_correct: false, created_at: "2026-09-19T01:00:00.000Z" },
      ],
    });

    await expect(hasCompletedLessonRelearnToday(
      "embark",
      new Date("2026-09-19T04:00:00.000Z"),
      db as any,
      "user",
    )).resolves.toBe(false);
  });

  it("does not carry yesterday's relearn into the next local day", async () => {
    const { db, attemptQuery } = database({ sessions: [], attempts: [] });

    await expect(hasCompletedLessonRelearnToday(
      "embark",
      new Date("2026-09-20T04:00:00.000Z"),
      db as any,
      "user",
    )).resolves.toBe(false);

    expect(attemptQuery.calls.gte).not.toContainEqual(["created_at", "2026-09-18T16:00:00.000Z"]);
  });
});