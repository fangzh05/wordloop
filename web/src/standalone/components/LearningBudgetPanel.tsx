import { useEffect, useState } from "react";
import { getBudget, getEvidenceReport, saveEvidenceLabel } from "../apiClient.js";
import type { BudgetSnapshot } from "../../../../server/services/learningBudget.js";

export function LearningBudgetPanel({ revision, paused, onAction }: {
  revision?: string | null; paused?: boolean; onAction: (fields: Record<string, unknown>) => Promise<unknown>;
}) {
  const [budget, setBudget] = useState<BudgetSnapshot>();
  const [minutes, setMinutes] = useState(45);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>();
  const [extraKey, setExtraKey] = useState(() => crypto.randomUUID());
  useEffect(() => { let alive = true; getBudget().then(b => { if (alive) { setBudget(b); setMinutes(b.daily_minutes); } }).catch(() => { if (alive) setError("预算暂时无法加载，请刷新重试。"); }); return () => { alive = false; }; }, [revision, paused]);
  async function run(action: Record<string, unknown>) {
    setBusy(true); setError("");
    try { const saved = await onAction(action); if (!saved) throw new Error("SAVE_UNCONFIRMED"); setBudget(await getBudget()); if (action.action === "extend_daily_time_budget") setExtraKey(crypto.randomUUID()); }
    catch { setError("设置未能确认保存，请重试。"); } finally { setBusy(false); }
  }
  async function evaluate() { setBusy(true); try { setReport(await getEvidenceReport()); } catch { setError("评测暂时无法加载。"); } finally { setBusy(false); } }
  function download() {
    const file = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file); const a = document.createElement("a"); a.href = url; a.download = "wordloop-evidence-evaluation.json"; a.click(); URL.revokeObjectURL(url);
  }
  return <section className="learning-budget-panel" aria-label="学习时间预算">
    <strong>{paused ? "今日预计预算已完成，待学任务已保留" : "每日学习时间"}</strong>
    {budget && <>
      <p>{budget.daily_minutes} 分钟预算 · 预计已安排 {Math.ceil(budget.estimated_used_seconds / 60)} 分钟 · 剩余 {Math.floor(budget.remaining_seconds / 60)} 分钟</p>
      <p>待复习 {budget.due_count} 词 · 逾期 {budget.overdue_count} 词 · 可新增额度 {budget.effective_new_limit} 词</p>
      <details><summary>未来 7 天预计复习负担</summary><ul>{budget.forecast.map(d => <li key={d.date}>{d.date}：{Math.ceil(d.review_seconds / 60)} 分钟</li>)}</ul><small>{budget.forecast_assumption}</small></details>
    </>}
    <div className="learning-budget-controls">
      <label>每日分钟数 <input aria-label="每日学习分钟数" type="number" min={5} max={240} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
      <button disabled={busy || !Number.isInteger(minutes) || minutes < 5 || minutes > 240} onClick={() => void run({ action: "set_daily_time_budget", minutes })}>保存</button>
      <button disabled={busy} onClick={() => void run({ action: "extend_daily_time_budget", request_id: extraKey })}>今天加练 15 分钟</button>
    </div>
    <small>用时由固定成本估计，不是实际计时。未做复习仍保持到期。</small>
    {error && <p role="alert">{error}</p>}
    <details onToggle={e => { if (e.currentTarget.open && !report) void evaluate(); }}>
      <summary>技能证据评测 · BKT 影子模式</summary>
      <p>掌握概率尚未校准，不参与选题。仅你明确保存的标注计入人工 gold。</p>
      {report && <>
        <p>人工审核 {report.reviewed_count}/{report.rows.length} · Brier {report.bkt.brier?.toFixed(3) ?? "样本不足"} · Log loss {report.bkt.log_loss?.toFixed(3) ?? "样本不足"}</p>
        <button onClick={download}>导出脱敏样本与指标</button>
        {report.rows.map((row: any) => <EvidenceLabel key={row.id} row={row} onSaved={evaluate} />)}
      </>}
    </details>
  </section>;
}

function EvidenceLabel({ row, onSaved }: { row: any; onSaved: () => Promise<void> }) {
  const [outcome, setOutcome] = useState(row.gold?.outcome ?? "not_assessed");
  const [layer, setLayer] = useState(row.gold?.error_label ?? "none");
  const [status, setStatus] = useState("");
  return <details className="evidence-label"><summary>{row.skill_id} · {row.quality} · {row.gold ? "已审核" : "待审核"}</summary>
    <p>原题：{row.prompt}</p><p>作答：{row.answer}</p><p>模型标签：{row.outcome}；{row.quality_reason}</p>
    <label>人工结果 <select value={outcome} onChange={e => setOutcome(e.target.value)}>{["correct", "incorrect", "partial", "not_assessed"].map(v => <option key={v}>{v}</option>)}</select></label>
    <label>错误类型 <select value={layer} onChange={e => setLayer(e.target.value)}>{["none","meaning","collocation","grammar","spelling","pronunciation"].map(v => <option key={v}>{v}</option>)}</select></label>
    <button disabled={status === "保存中" || row.prompt.startsWith("原题缺失")} onClick={async () => { setStatus("保存中"); try { await saveEvidenceLabel(row.id, outcome, layer); setStatus("已保存"); await onSaved(); } catch { setStatus("保存失败，请重试"); } }}>保存人工标注</button><span role="status">{status}</span>
  </details>;
}
