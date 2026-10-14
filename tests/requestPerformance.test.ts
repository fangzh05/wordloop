import { describe, expect, it, vi } from "vitest";
import { traceWebRequest, measure, instrumentDatabaseFetch, recordAiAttempt, setTraceOperation, requestMemo } from "../server/services/perf.js";

describe("request performance tracing", () => {
  it("records success, retries and DB body latency without sensitive content", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const request = new Request("https://wordloop.test/api/web/action", { headers: { "x-wordloop-request-id": "00000000-0000-4000-8000-000000000001", authorization: "Bearer private-jwt" } });
      const response = await traceWebRequest(request, { sampleRate: 1, serverTiming: true }, async () => {
        setTraceOperation("lesson_submit");
        await measure("auth_ms", async () => {});
        const dbFetch = instrumentDatabaseFetch(async () => new Response(new ReadableStream({ async start(c) { await new Promise(r => setTimeout(r, 5)); c.enqueue(new TextEncoder().encode('{"secret":"private-answer"}')); c.close(); } })));
        await dbFetch("https://db.test/rest/v1/users?jwt=private-jwt");
        recordAiAttempt({ task: "semantic_lesson_grading", attempt: 1, total_ms: 10, outcome: "retry", retry_reason: "invalid_schema" });
        recordAiAttempt({ task: "semantic_lesson_grading", attempt: 2, total_ms: 12, outcome: "success" });
        return new Response("{}", { status: 200 });
      });
      const data = JSON.parse(logs.mock.calls[0]![0]);
      expect(data).toMatchObject({ operation: "lesson_submit", db_calls: 1, ai_called: true, ai_retry_count: 1, ai_grading_ms: 22, success: true, http_status: 200 });
      expect(data.db_read_ms).toBeGreaterThanOrEqual(4);
      expect(response.headers.get("server-timing")).toContain("worker_total_ms");
      expect(response.headers.get("x-wordloop-request-id")).toBe(request.headers.get("x-wordloop-request-id"));
      expect(JSON.stringify(data)).not.toMatch(/private|Bearer|db.test/);
    } finally { logs.mockRestore(); }
  });
  it("isolates concurrent requests and retries rejected request caches", async () => {
    const db = {}; let calls = 0;
    const execute = () => traceWebRequest(new Request("https://wordloop.test/api/web/action"), { sampleRate: 0 }, async () => {
      const work = () => requestMemo(db, "user:task", async () => { calls++; await Promise.resolve(); return true; });
      await Promise.all([work(), work()]);
      let failures = 0;
      const retry = () => requestMemo(db, "failure", async () => { if (++failures === 1) throw new Error("fail"); return 1; });
      await expect(retry()).rejects.toThrow("fail"); expect(await retry()).toBe(1);
      return new Response("{}");
    });
    const [a,b] = await Promise.all([execute(), execute()]);
    expect(calls).toBe(2); expect(a.headers.get("x-wordloop-request-id")).not.toBe(b.headers.get("x-wordloop-request-id"));
    expect(a.headers.has("server-timing")).toBe(false);
  });
  it("records failures and rejects arbitrary trace ids", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await traceWebRequest(new Request("https://wordloop.test/api/web/action", { headers: { "x-wordloop-request-id": "secret-answer" } }), { sampleRate: 1 }, async () => new Response("{}", { status: 409 }));
      expect(result.headers.get("x-wordloop-request-id")).not.toBe("secret-answer");
      expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ success: false, http_status: 409 });
    } finally { logs.mockRestore(); }
  });
});
