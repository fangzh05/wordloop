import { useEffect, useState } from "react";
import { Button } from "../../components/Button.js";
import { getBudget, getEvidenceReport, saveEvidenceLabel } from "../apiClient.js";
import type { BudgetSnapshot } from "../../../../server/services/learningBudget.js";

export function LearningBudgetPanel({ revision, paused, onAction, onBudgetChange }: {
  revision?: string | null; paused?: boolean; onAction: (fields: Record<string, unknown>) => Promise<unknown>;
  onBudgetChange?: (budget: BudgetSnapshot) => void;
}) {
  const [budget, setBudget] = useState<BudgetSnapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [extraKey, setExtraKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let alive = true;
    getBudget().then(b => { if (alive) { setBudget(b); setError(""); onBudgetChange?.(b); } })
      .catch(() => { if (alive) setError("学习时间暂时无法加载，请稍后重试。"); });
    return () => { alive = false; };
  }, [revision, paused, onBudgetChange]);
  async function run(action: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const saved = await onAction(action);
      if (!saved) throw new Error("SAVE_UNCONFIRMED");
      const next = await getBudget(); setBudget(next); onBudgetChange?.(next);
      if (action.action === "extend_daily_time_budget") setExtraKey(crypto.randomUUID());
    } catch { setError("设置未能确认保存，请重试。"); } finally { setBusy(false); }
  }
  const totalSeconds = budget ? budget.daily_minutes * 60 + budget.extra_seconds : 0;
  // Reserved tasks are charged against remaining time; the meter and daily
  // total must show the same reserved-aware value, not measured time alone.
  const usedSeconds = budget?.estimated_used_seconds ?? budget?.effective_used_seconds ?? 0;
  const usedPercent = totalSeconds ? Math.min(100, usedSeconds / totalSeconds * 100) : 0;
  const reasons: Record<string, string> = {
    due_review_priority: "今日复习任务优先，已按预计复习时间安排新词。",
    budget_nearly_exhausted: "可分配时间接近用尽，已减少新词。",
    future_workload_high: "未来复习负担偏高，已收紧今天的新词量。",
    new_word_ceiling_reached: "已达到你设置的新词安全上限。",
    low_history_confidence: "个人有效学习样本较少，当前按初始成本估算。",
    exam_deadline_risk: "按当前预算，预计无法在目标日期前覆盖计划词汇；可以增加学习时间或调整目标范围。",
  };
  const reasonText = (budget?.reason_codes ?? []).map(code => reasons[code]).filter(Boolean);
  return <section className="learning-budget-summary" aria-label="学习时间">
    <div className="learning-budget-heading">
      <div><h3>学习时间</h3><p>{budget ? `今日 ${budget.daily_minutes} 分钟${budget.extra_seconds ? ` · 已加练 ${Math.round(budget.extra_seconds / 60)} 分钟` : ""}` : "正在读取今日时间…"}</p></div>
      {budget && <span className="learning-budget-remaining"><b>{Math.floor(budget.remaining_seconds / 60)}</b><span>分钟可用</span></span>}
    </div>
    {budget && <>
      <div className="learning-budget-meter" role="progressbar" aria-label="今日学习时间" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedPercent)} aria-valuetext={`已学习或预留约 ${Math.ceil(usedSeconds / 60)} 分钟`}><span style={{width:`${usedPercent}%`}} /></div>
      <p className="learning-budget-note">{budget.effective_used_seconds !== undefined ? `有效学习 ${Math.ceil(budget.effective_used_seconds / 60)} 分钟` : `已安排约 ${Math.ceil(usedSeconds / 60)} 分钟`}{paused ? " · 待学任务已保留" : " · 当前题目可以完成"}</p>
      <div className="learning-budget-facts">
        <span>到期复习 <b>{budget.due_count}</b></span>
        <span>预计复习 <b>{Math.ceil((budget.estimated_review_seconds ?? budget.due_count * (budget.cost_profile?.review_seconds ?? 8)) / 60)} 分钟</b></span>
        <span>今日已引入 <b>{budget.new_words_started_today ?? 0}</b></span>
        <span>推荐新词 <b>{budget.effective_new_limit ?? 0}</b></span>
        <span>预计今日合计 <b>{Math.ceil((budget.estimated_total_seconds ?? usedSeconds) / 60)} 分钟</b></span>
      </div>
      {reasonText.length > 0 && <ul className="learning-budget-reasons">{reasonText.map((note, index) => <li key={`${budget.date}-${index}`}>{note}</li>)}</ul>}
      {budget.adaptive_plan && <p className="learning-budget-note">未来 7 天正常情景约 {Math.ceil(budget.adaptive_plan.future_burden_normal.next_7_days_seconds / 60)} 分钟，偏高情景约 {Math.ceil(budget.adaptive_plan.future_burden_elevated.next_7_days_seconds / 60)} 分钟。{budget.forecast_assumption}</p>}
    </>}
    <div className="learning-budget-actions">
      <Button className="secondary" type="button" disabled={busy || !budget} onClick={() => void run({ action: "extend_daily_time_budget", request_id: extraKey })}>{busy ? "正在保存…" : "今天加练 15 分钟"}</Button>
    </div>
    {error && <p className="standalone-status error" role="alert">{error}</p>}
  </section>;
}

export function EvidenceEvaluation() {
  const [report, setReport] = useState<any>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function evaluate() { setBusy(true); setError(""); try { setReport(await getEvidenceReport()); } catch { setError("评测暂时无法加载，请重试。"); } finally { setBusy(false); } }
  function download() {
    const file = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file); const a = document.createElement("a"); a.href = url; a.download = "wordloop-evidence-evaluation.json"; a.click(); URL.revokeObjectURL(url);
  }
  return <details className="learning-evidence-settings" onToggle={e => { if (e.currentTarget.open && !report && !busy) void evaluate(); }}>
    <summary>高级 · 学习记录评测</summary>
    <p>用于人工检查技能判断。只有明确保存的人工标注计入评测。</p>
    {busy && <p role="status">正在读取评测…</p>}
    {error && <><p className="standalone-status error" role="alert">{error}</p><Button className="secondary" type="button" onClick={() => void evaluate()}>重试</Button></>}
    {report && <>
      <p>{report.mode === "active" ? "BKT 已参与新一轮 Lesson 选题。" : report.mode === "off" ? "BKT 已关闭。" : "BKT 正在影子模式运行。"}掌握概率是模型估计，尚未校准，不代表已验证的能力。</p>
      <p>人工审核 {report.reviewed_count}/{report.rows.length} · Brier {report.bkt.brier?.toFixed(3) ?? "样本不足"} · Log loss {report.bkt.log_loss?.toFixed(3) ?? "样本不足"}</p>
      <Button className="secondary" type="button" onClick={download}>导出脱敏样本与指标</Button>
      {report.rows.map((row: any) => <EvidenceLabel key={row.id} row={row} onSaved={evaluate} />)}
    </>}
  </details>;
}

function EvidenceLabel({ row, onSaved }: { row: any; onSaved: () => Promise<void> }) {
  const [outcome, setOutcome] = useState(row.gold?.outcome ?? "not_assessed");
  const [layer, setLayer] = useState(row.gold?.error_label ?? "none");
  const [status, setStatus] = useState("");
  return <details className="evidence-label"><summary>{row.skill_id} · {row.quality} · {row.gold ? "已审核" : "待审核"}</summary>
    <p>原题：{row.prompt}</p><p>作答：{row.answer}</p><p>模型标签：{row.outcome}；{row.quality_reason}</p>
    <label>人工结果 <select value={outcome} onChange={e => setOutcome(e.target.value)}>{["correct", "incorrect", "partial", "not_assessed"].map(v => <option key={v}>{v}</option>)}</select></label>
    <label>错误类型 <select value={layer} onChange={e => setLayer(e.target.value)}>{["none","meaning","collocation","grammar","spelling","pronunciation"].map(v => <option key={v}>{v}</option>)}</select></label>
    <Button className="secondary" type="button" disabled={status === "保存中" || row.prompt.startsWith("原题缺失")} onClick={async () => { setStatus("保存中"); try { await saveEvidenceLabel(row.id, outcome, layer); setStatus("已保存"); await onSaved(); } catch { setStatus("保存失败，请重试"); } }}>保存人工标注</Button><span role="status">{status}</span>
  </details>;
}
