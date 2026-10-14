import { AsyncLocalStorage } from "node:async_hooks";

export type Stage = "auth_ms" | "db_read_ms" | "budget_ms" | "ai_generation_ms" | "ai_grading_ms" | "db_write_ms" | "bkt_ms" | "progress_ms" | "response_ms";
const stages: Stage[] = ["auth_ms", "db_read_ms", "budget_ms", "ai_generation_ms", "ai_grading_ms", "db_write_ms", "bkt_ms", "progress_ms", "response_ms"];
type AiAttempt = { call_id?: string; task: string; attempt: number; total_ms: number; outcome: string; retry_reason?: string; http_status?: number };
type Trace = { request_id: string; operation: string; sampled: boolean; started: number; timings: Record<Stage, number>; db_calls: number; ai: AiAttempt[]; memo: WeakMap<object, Map<string, Promise<unknown>>> };
const storage = new AsyncLocalStorage<Trace>();
const rounded = (n: number) => Math.round(Math.max(0, n) * 100) / 100;
export function setTraceOperation(operation: string): void { const t = storage.getStore(); if (t) t.operation = operation; }
export async function measure<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
  const t = storage.getStore(); if (!t) return operation();
  const start = performance.now();
  try { return await operation(); } finally { t.timings[stage] += performance.now() - start; }
}
export function measureSync<T>(stage: Stage, work: () => T): T {
  const t = storage.getStore(); const start = performance.now();
  try { return work(); } finally { if (t) t.timings[stage] += performance.now() - start; }
}
export function recordAiAttempt(attempt: AiAttempt): void {
  const t = storage.getStore(); if (!t) return;
  t.ai.push(attempt);
  t.timings[attempt.task.endsWith("generation") ? "ai_generation_ms" : "ai_grading_ms"] += attempt.total_ms;
}
/** Scoped to this request, database object and user-key. Failed work is never cached. */
export function requestMemo<T>(db: object, key: string, work: () => Promise<T>): Promise<T> {
  const t = storage.getStore(); if (!t) return work();
  let entries = t.memo.get(db); if (!entries) { entries = new Map(); t.memo.set(db, entries); }
  const existing = entries.get(key); if (existing) return existing as Promise<T>;
  const pending = work().catch(error => { entries!.delete(key); throw error; });
  entries.set(key, pending); return pending;
}
/** No URL, query parameters, headers or payloads are retained. Includes body consumption. */
export function instrumentDatabaseFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const t = storage.getStore(); if (!t) return fetcher(input, init);
    t.db_calls++;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const readRpc = /\/(learning_budget_snapshot_v1|user_learning_time_profile_v2|user_learning_time_history_v2|pending_skill_evidence_v1|get_[a-z0-9_]+|list_[a-z0-9_]+|can_access_private_source_v1)$/.test(pathname);
    const stage = method === "GET" || method === "HEAD" || readRpc ? "db_read_ms" : "db_write_ms";
    const result = await measure(stage, () => fetcher(input, init));
    // PostgREST consumes text(); keep the original Response and streaming body.
    // Time consumption when it happens instead of buffering another copy here.
    const text = result.text.bind(result);
    const json = result.json.bind(result);
    result.text = () => measure(stage, text);
    result.json = () => measure(stage, json);
    return result;
  };
}
export async function traceWebRequest(request: Request, options: { sampleRate?: number; serverTiming?: boolean }, work: () => Promise<Response>): Promise<Response> {
  // Accept only a UUID, never arbitrary client-controlled strings in logs.
  const supplied = request.headers.get("x-wordloop-request-id");
  const requestId = supplied && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(supplied) ? supplied : crypto.randomUUID();
  const rate = Number.isFinite(options.sampleRate) ? Math.min(1, Math.max(0, options.sampleRate!)) : 0.1;
  const readOperations: Record<string, string> = {
    "/api/web/bootstrap": "bootstrap", "/api/web/today": "today", "/api/web/budget": "budget",
    "/api/web/evidence": "evidence", "/api/web/analytics": "analytics",
  };
  const operation = request.method === "GET" ? readOperations[new URL(request.url).pathname] ?? "read" : "request";
  const t: Trace = { request_id: requestId, operation, sampled: Math.random() < rate, started: performance.now(), timings: Object.fromEntries(stages.map(s => [s, 0])) as Record<Stage, number>, db_calls: 0, ai: [], memo: new WeakMap() };
  return storage.run(t, async () => {
    let status = 500;
    try {
      const result = await work(); status = result.status;
      const headers = new Headers(result.headers); headers.set("x-wordloop-request-id", requestId);
      if (options.serverTiming) headers.set("server-timing", [...stages.map(s => `${s};dur=${rounded(t.timings[s])}`), `worker_total_ms;dur=${rounded(performance.now() - t.started)}`].join(", "));
      return new Response(result.body, { status, statusText: result.statusText, headers });
    } finally {
      if (t.sampled) console.log(JSON.stringify({ event: "wordloop_request_performance", request_id: requestId, operation: t.operation, worker_total_ms: rounded(performance.now() - t.started), ...Object.fromEntries(stages.map(s => [s, rounded(t.timings[s])])), db_calls: t.db_calls, ai_called: t.ai.length > 0, ai_model: t.ai.length ? "deepseek-flash" : null, ai_call_count: t.ai.filter(a => a.attempt === 1).length, ai_attempt_count: t.ai.length, ai_retry_count: t.ai.filter(a => a.attempt > 1).length, ai_attempts: t.ai, success: status < 400, http_status: status }));
    }
  });
}

export async function perf<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (name === "get_progress") return measure("progress_ms", operation);
  const enabled = typeof process !== "undefined" && process.env.WORDLOOP_PERF_LOG === "1";
  const start = performance.now();
  try { return await operation(); } finally { if (enabled) console.log(`[wordloop perf] ${name} ${rounded(performance.now() - start)}ms`); }
}
