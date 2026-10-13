// These tests isolate the original flow; budget admission is exercised in learningBudget.test.ts.
vi.mock("../server/services/learningBudget.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server/services/learningBudget.js")>(),
  getLearningBudget: vi.fn(async () => ({ date:"2026-10-02",daily_minutes:45,remaining_seconds:2700,estimated_used_seconds:0,due_count:0,overdue_count:0,new_word_cap:50,effective_new_limit:50,enabled:true,forecast:[] })),
  reserveLearningBudget: vi.fn(async () => undefined),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeStudyState } from "../server/services/studySessions.js";
import { getProgress } from "../server/services/progress.js";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getAuthenticatedUserId: vi.fn(() => "user"),
  getActiveStudySession: vi.fn(),
  getUserTimeZone: vi.fn(),
}));

vi.mock("../server/db.js", async () => {
  const actual = await vi.importActual<typeof import("../server/db.js")>("../server/db.js");
  return { ...actual, getDatabase: mocks.getDatabase, getAuthenticatedUserId: mocks.getAuthenticatedUserId };
});

vi.mock("../server/services/studySessions.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/studySessions.js")>("../server/services/studySessions.js");
  return { ...actual, getActiveStudySession: mocks.getActiveStudySession };
});

vi.mock("../server/services/words.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/words.js")>("../server/services/words.js");
  return { ...actual, getUserTimeZone: mocks.getUserTimeZone };
});

function query(result: unknown) {
  const builder: Record<string, any> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.gte = () => builder;
  builder.lt = () => builder;
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe("getProgress with historical session snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const activeLesson = makeStudyState({
      date: "2026-09-28",
      widget: "lesson",
      phase: "lesson_explain",
      current_word: "electrical",
      current_index: 3,
      retry_count: 0,
      flow: {
        relearn_words: ["grieve"],
        lesson_words: ["grieve", "embark", "shallow", "electrical", "chief", "delegate", "textile", "recall"],
      },
      payload: { widget: "lesson", mode: "explain", word: "electrical" },
    });
    const progressSnapshot = {
      today: { total: 50, known: 12, uncertain: 0, unknown: 0, completed: 12 },
      all_time: { total_words: 6593, mastered: 46, learning: 6502, error_book: 45 },
      fsrs: { due_now: 6, due_today: 6, tomorrow: 0, due_next_7_days: 0, average_stability: 1 },
      settings: { daily_new_word_limit: 50 },
    };
    const db = {
      rpc: vi.fn(async () => ({ data: progressSnapshot, error: null })),
      from: vi.fn((table: string) => query(table === "study_sessions"
        ? { data: [{ review_words_count: 17, state: {} }, { review_words_count: 0, state: activeLesson }], error: null }
        : { data: null, error: null, count: 12 })),
    };
    mocks.getDatabase.mockReturnValue(db);
    mocks.getActiveStudySession.mockResolvedValue({ state: activeLesson });
    mocks.getUserTimeZone.mockResolvedValue("Asia/Shanghai");
  });

  it("keeps today's and all-time progress when an ended session has state={}", async () => {
    const progress = await getProgress();

    expect(progress.today).toMatchObject({ total: 50, completed: 12 });
    expect(progress.all_time).toMatchObject({ total_words: 6593, mastered: 46, error_book: 45 });
    expect(progress.fsrs.due_now).toBe(6);
    expect(progress.review_today).toMatchObject({ total: 17, completed: 17, remaining: 0 });
  });
});
