import { describe, expect, it, vi } from "vitest";
import type { StudyState } from "../server/types.js";
import {
  consolidationKindForRound,
  countCompletedLessonRoundsToday,
  decideLessonConsolidation,
  selectConsolidationTargetWords,
} from "../server/services/lessonConsolidation.js";

function state(input: Partial<StudyState> = {}): StudyState {
  return {
    version: 1,
    date: "2026-09-28",
    widget: "lesson",
    phase: "lesson_complete",
    current_word: "pressure",
    current_index: 2,
    retry_count: 0,
    flow: {
      relearn_words: [],
      lesson_words: ["alleviate", "policy", "pressure"],
      lesson_profile_history: [
        { word: "alleviate", lesson_profile: "quick_recall", error_focus: null },
        { word: "policy", lesson_profile: "reinforce", error_focus: "collocation" },
        { word: "pressure", lesson_profile: "targeted_relearn", error_focus: "meaning" },
      ],
    },
    payload: { widget: "lesson", mode: "feedback", feedback: { is_correct: true, reveal_answer: false } },
    ...input,
  };
}

describe("server-owned Lesson consolidation cadence", () => {
  it("schedules no task after round 1, translation after round 2, and sentence after round 3", () => {
    expect(consolidationKindForRound(1)).toBeNull();
    expect(consolidationKindForRound(2)).toBe("translation");
    expect(consolidationKindForRound(3)).toBe("sentence");
  });

  it("gives round 6 one translation task and defers the colliding sentence task", () => {
    expect(consolidationKindForRound(6)).toBe("translation");
    expect(consolidationKindForRound(9)).toBe("sentence");
  });

  it("selects 2–3 translation words and prioritizes recent weak profiles", () => {
    const selected = selectConsolidationTargetWords([], state(), "translation");
    expect(selected).toHaveLength(3);
    expect(selected[0]).toBe("pressure");
    expect(selected).toEqual(expect.arrayContaining(["policy", "alleviate"]));
  });

  it("selects 1–2 sentence words and avoids the latest consolidation targets when possible", () => {
    const recent = state({
      current_word: null,
      payload: {
        widget: "lesson",
        mode: "completed",
        consolidation: true,
        consolidation_target_words: ["pressure", "policy"],
      },
    });
    const selected = selectConsolidationTargetWords([{ state: recent }], state(), "sentence");
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected.length).toBeLessThanOrEqual(2);
    expect(selected).not.toContain("pressure");
    expect(selected).not.toContain("policy");
  });

  it("counts only completed Lesson summaries ended during the user's local day", async () => {
    const rows = [
      { state: { widget: "lesson", payload: { mode: "completed" } } },
      { state: { widget: "lesson", payload: { mode: "completed", consolidation: true } } },
      { state: { widget: "review", payload: { mode: "completed" } } },
    ];
    const userQuery: any = {};
    userQuery.select = vi.fn(() => userQuery);
    userQuery.eq = vi.fn(() => userQuery);
    userQuery.maybeSingle = vi.fn(async () => ({ data: { timezone: "Asia/Shanghai" }, error: null }));
    const sessionQuery: any = {};
    sessionQuery.select = vi.fn(() => sessionQuery);
    sessionQuery.eq = vi.fn(() => sessionQuery);
    sessionQuery.contains = vi.fn(() => sessionQuery);
    sessionQuery.gte = vi.fn(() => sessionQuery);
    sessionQuery.lt = vi.fn(async () => ({ data: rows, error: null }));
    const db = { from: vi.fn((table: string) => table === "users" ? userQuery : sessionQuery) };

    await expect(countCompletedLessonRoundsToday(db as any, "user")).resolves.toBe(2);
    expect(sessionQuery.contains).toHaveBeenCalledWith("state", { widget: "lesson", payload: { mode: "completed" } });
    expect(sessionQuery.gte).toHaveBeenCalledWith("ended_at", expect.any(String));
    expect(sessionQuery.lt).toHaveBeenCalledWith("ended_at", expect.any(String));
  });

  it.each([
    { completedRounds: 0, expected: null },
    { completedRounds: 1, expected: "translation" },
    { completedRounds: 2, expected: "sentence" },
    { completedRounds: 5, expected: "translation" },
  ])("derives one server marker from $completedRounds completed rounds", async ({ completedRounds, expected }) => {
    const completedRows = Array.from({ length: completedRounds }, () => ({
      state: {
        widget: "lesson", phase: "lesson_complete", current_word: null, current_index: 0, retry_count: 0,
        flow: { relearn_words: [], lesson_words: ["policy", "pressure", "alleviate"] },
        payload: { mode: "completed" },
      },
    }));
    const users: any = {};
    users.select = vi.fn(() => users);
    users.eq = vi.fn(() => users);
    users.maybeSingle = vi.fn(async () => ({ data: { timezone: "Asia/Shanghai" }, error: null }));
    const db = {
      from: vi.fn((table: string) => {
        if (table === "users") return users;
        const query: any = {};
        for (const method of ["select", "eq", "contains", "gte", "not", "order"]) query[method] = vi.fn(() => query);
        query.lt = vi.fn(async () => ({ data: completedRows, error: null }));
        query.limit = vi.fn(async () => ({ data: completedRows.slice(0, 8), error: null }));
        return query;
      }),
    };
    const result = await decideLessonConsolidation(state(), db as any, "user");
    if (!expected) {
      expect(result).toBeDefined();
      expect(result.payload).not.toHaveProperty("consolidation");
      return;
    }
    expect(result.payload).toMatchObject({
      consolidation: true,
      consolidation_kind: expected,
      consolidation_trigger_round: completedRounds + 1,
      consolidation_status: "pending",
    });
    expect(result.payload.consolidation_target_words).toHaveLength(expected === "translation" ? 3 : 2);
  });

  it("keeps an already-consumed active cadence marker unchanged across repeated completion events", async () => {
    const marked = state({
      payload: {
        widget: "lesson", mode: "feedback", consolidation: true,
        consolidation_kind: "translation", consolidation_trigger_round: 2,
        consolidation_target_words: ["policy", "pressure"], consolidation_status: "exercise",
        feedback: { is_correct: true, reveal_answer: false },
      },
    });
    await expect(decideLessonConsolidation(marked, {} as any, "user")).resolves.toBe(marked);
  });
});
