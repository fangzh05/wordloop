import { describe, expect, it, vi } from "vitest";
import { getCompletedLessonWords } from "../server/services/attempts.js";

function database(rows: Array<{ normalized_word: string }>) {
  const rpc = vi.fn(async () => ({ data: rows, error: null }));
  return { db: { rpc }, rpc };
}

describe("completed Lesson words", () => {
  it("loads normalized words from all formal Lesson history", async () => {
    const { db, rpc } = database([
      { normalized_word: "Electrical" },
      { normalized_word: "embark" },
      { normalized_word: "ELECTRICAL" },
    ]);

    const completed = await getCompletedLessonWords(db as any, "current-user");

    expect([...completed]).toEqual(["electrical", "embark"]);
    expect(rpc).toHaveBeenCalledWith("get_formal_lesson_attempt_words_v1", {
      p_user_id: "current-user",
      p_before: null,
    });
  });

  it("can restrict history to attempts before an active session began", async () => {
    const { db, rpc } = database([{ normalized_word: "embark" }]);
    const before = "2026-09-28T15:40:09.681685Z";

    await expect(getCompletedLessonWords(db as any, "current-user", before)).resolves.toEqual(new Set(["embark"]));
    expect(rpc).toHaveBeenCalledWith("get_formal_lesson_attempt_words_v1", {
      p_user_id: "current-user",
      p_before: before,
    });
  });
});
