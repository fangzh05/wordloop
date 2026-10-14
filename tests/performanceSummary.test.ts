import { describe, expect, it } from "vitest";
import { distribution, summarize } from "../scripts/summarize-learning-performance.js";
describe("performance aggregation", () => {
  it("does not invent values for missing samples", () => { expect(distribution([])).toMatchObject({ n:0, p95_ms:null }); });
  it("joins full interactions and separates distinct AI calls and retries", () => {
    const result = summarize([
      { event:"wordloop_request_performance", request_id:"a", operation:"lesson_submit", worker_total_ms:100, db_calls:4, success:true, ai_attempts:[{call_id:"1",task:"semantic_lesson_grading",attempt:1,total_ms:20,outcome:"retry",retry_reason:"invalid_schema"},{call_id:"1",task:"semantic_lesson_grading",attempt:2,total_ms:30,outcome:"success"},{call_id:"2",task:"semantic_lesson_grading",attempt:1,total_ms:10,outcome:"error"}] },
      { event:"wordloop_interaction_performance", request_id:"a", client_total_ms:300,telemetry_before_ms:100,telemetry_after_ms:100 },
    ]);
    expect(result.operations.lesson_submit.client).toMatchObject({ n:1, p50_ms:300 });
    expect(result.ai_tasks.semantic_lesson_grading).toMatchObject({ n:2, mean_ms:30,error_rate:.5,retry_rate:.5,retry_reasons:{invalid_schema:1} });
    expect(JSON.stringify(result)).not.toContain('"request_id"');
  });
});
