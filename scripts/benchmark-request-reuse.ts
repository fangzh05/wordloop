import { writeFile } from "node:fs/promises";
import { configureRuntimeEnv } from "../server/db.js";
import { reserveLearningBudget } from "../server/services/learningBudget.js";
import { getUserTimeZone } from "../server/services/words.js";
import { traceWebRequest } from "../server/services/perf.js";

// Controlled transport fixture, NOT a production latency benchmark.
const delayMs = Number(process.env.PERF_FIXTURE_RTT_MS ?? 20);
const samples = Number(process.env.PERF_FIXTURE_SAMPLES ?? 40);
const user = "00000000-0000-4000-8000-000000000001";
let calls = 0;
const delay = async () => { calls++; await new Promise(r => setTimeout(r, delayMs)); };
const db: any = {
  rpc: async (name: string) => { await delay(); return { data: name === "reserve_learning_budget_v1" ? true : [], error: null }; },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { await delay(); return { data: { timezone: "Asia/Shanghai" }, error: null }; } }) }) }),
};
configureRuntimeEnv({ WORDLOOP_TIME_CALIBRATION_V2: "true" });
await reserveLearningBudget("warm", "word_recall", "lesson", db, user);
calls = 0;
const durations: number[] = [];
for (let i = 0; i < samples; i++) {
  const start = performance.now();
  await traceWebRequest(new Request("https://fixture.invalid/api/web/action"), { sampleRate: 0 }, async () => {
    await reserveLearningBudget(`exercise:${i}`, "word_recall", "lesson", db, user);
    await getUserTimeZone(db, user); // completion date
    await reserveLearningBudget(`exercise:${i}`, "word_recall", "lesson", db, user); // persistence guard
    await getUserTimeZone(db, user); // response time context
    await getUserTimeZone(db, user); // review progress
    return new Response("{}");
  });
  durations.push(performance.now() - start);
}
const sorted = durations.slice().sort((a,b) => a-b);
const percentile = (p: number) => sorted[Math.ceil(p * sorted.length)-1];
const result = { evidence: "controlled helper-path fixture; not production E2E", fixture_rtt_ms: delayMs, samples, db_calls: calls, calls_per_sample: calls/samples, ai_calls: 0, mean_ms: durations.reduce((a,b)=>a+b,0)/samples, p50_ms: percentile(.5), p95_ms: percentile(.95), p99_ms: percentile(.99) };
console.log(JSON.stringify(result, null, 2));
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2)+"\n");
