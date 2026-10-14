import { afterEach, describe, expect, it } from "vitest";
import { configureRuntimeEnv } from "../server/db.js";
import { reserveLearningBudget, LearningBudgetReached } from "../server/services/learningBudget.js";
import { getUserTimeZone } from "../server/services/words.js";
import { traceWebRequest } from "../server/services/perf.js";
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const scoped = (work: () => Promise<void>) => traceWebRequest(new Request("https://wordloop.test/api/web/action"), { sampleRate: 0 }, async () => { await work(); return new Response("{}"); });
afterEach(() => configureRuntimeEnv({}));
describe("learning request reuse", () => {
  it("reserves once for concurrent same-task callers and retains cross-request guards", async () => {
    configureRuntimeEnv({ WORDLOOP_TIME_CALIBRATION_V2: "false" });
    const calls: string[] = [];
    const db: any = { rpc: async (_: string, args: any) => { calls.push(args.p_task_key); await Promise.resolve(); return { data: true, error: null }; } };
    const reserve = () => reserveLearningBudget("exercise:a", "word_recall", "lesson", db, user);
    await scoped(async () => { await Promise.all([reserve(), reserve()]); await reserve(); });
    expect(calls).toEqual(["exercise:a"]);
    await scoped(async () => { await reserve(); }); expect(calls).toHaveLength(2);
    await scoped(async () => { await reserve(); await reserveLearningBudget("exercise:a", "word_recall", "lesson", db, other); await reserveLearningBudget("exercise:b", "word_recall", "lesson", db, user); });
    expect(calls).toHaveLength(5);
  });
  it("does not memoize exhausted budgets or failed reads", async () => {
    configureRuntimeEnv({ WORDLOOP_TIME_CALIBRATION_V2: "false" });
    let calls = 0;
    const db: any = { rpc: async () => ({ data: ++calls > 1, error: null }) };
    await scoped(async () => {
      await expect(reserveLearningBudget("exercise:a", "word_recall", "lesson", db, user)).rejects.toBeInstanceOf(LearningBudgetReached);
      await reserveLearningBudget("exercise:a", "word_recall", "lesson", db, user);
    }); expect(calls).toBe(2);
  });
  it("shares timezone reads by user and database and refreshes on a new request", async () => {
    let calls = 0; let timezone = "Asia/Shanghai";
    const db: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { calls++; return { data: { timezone }, error: null }; } }) }) }) };
    await scoped(async () => { expect(await getUserTimeZone(db, user)).toBe(timezone); await getUserTimeZone(db,user); await getUserTimeZone(db,other); }); expect(calls).toBe(2);
    timezone = "UTC";
    await scoped(async () => { expect(await getUserTimeZone(db,user)).toBe("UTC"); }); expect(calls).toBe(3);
  });
});
