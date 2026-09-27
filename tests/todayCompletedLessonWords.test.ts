import { afterEach, describe, expect, it, vi } from "vitest";
import { getTodayCompletedLessonWords } from "../server/services/attempts.js";

function query(result: unknown) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "eq", "gte", "lt", "in"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => result);
  builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function database(input: {
  timezone: string;
  attempts: Array<{ word: { normalized_word: string } | Array<{ normalized_word: string }> }>;
}) {
  const userQuery = query({ data: { timezone: input.timezone }, error: null });
  const attemptsQuery = query({ data: input.attempts, error: null });
  const db = {
    from: vi.fn((table: string) => table === "users" ? userQuery : attemptsQuery),
  };
  return { db, userQuery, attemptsQuery };
}

describe("today's completed Lesson words", () => {
  afterEach(() => vi.useRealTimers());

  it("queries only the current user's local day and formal Lesson activity types", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T03:00:00.000Z"));
    const { db, userQuery, attemptsQuery } = database({
      timezone: "Asia/Shanghai",
      attempts: [
        { word: { normalized_word: "Electrical" } },
        { word: [{ normalized_word: "embark" }] },
        { word: { normalized_word: "ELECTRICAL" } },
      ],
    });

    const completed = await getTodayCompletedLessonWords(db as any, "current-user");

    expect([...completed]).toEqual(["electrical", "embark"]);
    expect(userQuery.eq).toHaveBeenCalledWith("id", "current-user");
    expect(attemptsQuery.eq).toHaveBeenCalledWith("user_id", "current-user");
    expect(attemptsQuery.gte).toHaveBeenCalledWith("created_at", "2026-09-27T16:00:00.000Z");
    expect(attemptsQuery.lt).toHaveBeenCalledWith("created_at", "2026-09-28T16:00:00.000Z");
    expect(attemptsQuery.in).toHaveBeenCalledWith("activity_type", expect.arrayContaining([
      "exact_cloze",
      "cloze",
      "translation_cn_to_en",
      "translation_en_to_cn",
      "collocation",
      "derivation",
      "recall",
      "sentence",
      "spelling",
      "word_recall",
    ]));
    const activityTypes = attemptsQuery.in.mock.calls[0][1] as string[];
    expect(activityTypes).not.toContain("review");
    expect(activityTypes).not.toContain("pretest_cn_to_en");
    expect(activityTypes).not.toContain("pretest_en_definition");
  });

  it("uses a new local-day window after midnight so yesterday does not carry over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T16:01:00.000Z"));
    const { db, attemptsQuery } = database({ timezone: "Asia/Shanghai", attempts: [] });

    await expect(getTodayCompletedLessonWords(db as any, "current-user")).resolves.toEqual(new Set());
    expect(attemptsQuery.gte).toHaveBeenCalledWith("created_at", "2026-09-28T16:00:00.000Z");
    expect(attemptsQuery.lt).toHaveBeenCalledWith("created_at", "2026-09-29T16:00:00.000Z");
  });
});