import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  const q = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length*p)-1)] : null;
  return { n: sorted.length, mean_ms: sorted.length ? sorted.reduce((a,b)=>a+b,0)/sorted.length : null, p50_ms: q(.5), p95_ms: q(.95), p99_ms: q(.99) };
}
type Row = Record<string, any>;
export function summarize(rows: Row[]) {
  const workers = rows.filter(r => r.event === "wordloop_request_performance");
  const clients = new Map(rows.filter(r => r.event === "wordloop_client_performance").map(r=>[r.request_id,r]));
  for (const r of rows.filter(r => r.event === "wordloop_interaction_performance")) clients.set(r.request_id, r);
  const operations: Record<string, any> = {};
  for (const operation of new Set(workers.map(r=>String(r.operation)))) {
    const group = workers.filter(r=>r.operation===operation);
    const joined = group.map(r=>clients.get(r.request_id)).filter((r): r is Row => !!r);
    operations[operation] = {
      worker: distribution(group.map(r=>r.worker_total_ms)), client: distribution(joined.map(r=>r.client_total_ms)),
      client_interaction: distribution(joined.filter(r=>r.event === "wordloop_interaction_performance").map(r=>r.client_total_ms)),
      client_api_only: distribution(joined.filter(r=>r.event === "wordloop_client_performance").map(r=>r.client_total_ms)),
      telemetry_before: distribution(joined.map(r=>r.telemetry_before_ms)), telemetry_after: distribution(joined.map(r=>r.telemetry_after_ms)),
      error_rate: group.filter(r=>!r.success).length/group.length,
      mean_db_calls: group.reduce((n,r)=>n+r.db_calls,0)/group.length,
      stages: Object.fromEntries(["auth_ms","db_read_ms","budget_ms","ai_generation_ms","ai_grading_ms","db_write_ms","bkt_ms","progress_ms","response_ms"].map(stage=>[stage,distribution(group.map(r=>r[stage]))])),
    };
  }
  const aiCalls = new Map<string, Row[]>();
  for (const r of workers) for (const a of r.ai_attempts ?? []) {
    const key = `${r.request_id}:${a.call_id ?? a.task}`;
    const group = aiCalls.get(key) ?? []; group.push(a); aiCalls.set(key,group);
  }
  const tasks: Record<string, any> = {};
  for (const task of new Set([...aiCalls.values()].map(a=>String(a[0]!.task)))) {
    const calls = [...aiCalls.values()].filter(a=>a[0]!.task===task);
    const retryReasons: Record<string,number> = {};
    for (const call of calls) for (const a of call) if (a.retry_reason) retryReasons[a.retry_reason]=(retryReasons[a.retry_reason]??0)+1;
    tasks[task] = { ...distribution(calls.map(c=>c.reduce((n,a)=>n+a.total_ms,0))), error_rate: calls.filter(c=>c.at(-1)!.outcome!=="success").length/calls.length, retry_rate: calls.filter(c=>c.length>1).length/calls.length, retry_reasons: retryReasons };
  }
  return { note: "Sampled worker requests; client matches by request_id. Overlapping stages must not be summed. Small-sample tail estimates are not acceptance evidence.", operations, ai_tasks: tasks };
}
function extract(value: any): Row[] {
  if (typeof value === "string") { try { return extract(JSON.parse(value)); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(extract);
  if (!value || typeof value !== "object") return [];
  if (["wordloop_request_performance","wordloop_interaction_performance","wordloop_client_performance"].includes(value.event)) return [value];
  return extract(value.logs ?? value.message ?? []);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node --import tsx scripts/summarize-learning-performance.ts logs.ndjson [summary.json]");
  const raw = await readFile(process.argv[2], "utf8");
  const rows = raw.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return extract(JSON.parse(line)); } catch { return []; } });
  const result = JSON.stringify(summarize(rows),null,2)+"\n";
  if (process.argv[3]) await writeFile(process.argv[3], result); else console.log(result);
}
