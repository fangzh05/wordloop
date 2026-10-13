import { BetaAccounts } from "./BetaAccounts.js";
import { getAuthClient } from "./authClient.js";
import { clearToken } from "./apiClient.js";
import { EvidenceEvaluation } from "./components/LearningBudgetPanel.js";
import { Icon } from "./DesignIcons.js";
import { useEffect, useId, useRef, useState } from "react";
import { DailyNewWordLimitEditor, type DailyNewWordLimitSaveResult } from "../components/DailyNewWordLimitEditor.js";
import { getBudget, getTodayOverview } from "./apiClient.js";

export type AppSection = "today" | "study" | "capture" | "insights" | "vocabulary";
const navItems: Array<{ section: AppSection; label: string; icon: string }> = [
  { section: "today", label: "今日", icon: "today" }, { section: "study", label: "学习", icon: "study" },
  { section: "capture", label: "划词", icon: "capture" }, { section: "insights", label: "洞察", icon: "insights" },
  { section: "vocabulary", label: "词库", icon: "vocabulary" },
];
export function AppNavigation({ section, onNavigate }: { section: AppSection; onNavigate: (section: AppSection) => void }): React.JSX.Element {
  const items = <>{navItems.map((item) => <button key={item.section} type="button" className="app-nav-item" aria-current={section === item.section ? "page" : undefined} onClick={() => onNavigate(item.section)}><Icon name={item.icon} /><b>{item.label}</b></button>)}</>;
  return <>
    <nav className="app-navigation app-navigation-desktop" aria-label="主导航"><div className="nav-brand"><span><Icon name="loop" /></span><strong>WordLoop</strong></div><p className="nav-caption">你的学习空间</p><div className="nav-list">{items}</div><div className="nav-personal"><span>W</span><div><strong>WordLoop</strong><small>个人学习空间</small></div></div></nav>
    <nav className="app-navigation app-navigation-mobile" aria-label="主导航">{items}</nav>
  </>;
}

export type Appearance = "system" | "light" | "dark";

export function SettingsSheet({ open, onClose, appearance, onAppearanceChange, dailyLimit, busy, onSaveDailyNewWordLimit, onSaveDailyTimeBudget, onSaveExamGoal }: {
  open: boolean;
  onClose: () => void;
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
  dailyLimit: number | null;
  busy: boolean;
  onSaveDailyNewWordLimit?: (limit: number) => Promise<DailyNewWordLimitSaveResult>;
  onSaveDailyTimeBudget?: (minutes: number) => Promise<unknown>;
  onSaveExamGoal?: (targetDate: string | null, coverageTarget: number | null) => Promise<unknown>;
}): React.JSX.Element | null {
  const headingId = useId();
  const [saveError, setSaveError] = useState("");
  const [targetRetention, setTargetRetention] = useState<number | null>(null);
  const [dailyMinutes, setDailyMinutes] = useState(45);
  const [resolvedDailyLimit, setResolvedDailyLimit] = useState(dailyLimit);
  const [examBookId, setExamBookId] = useState<string | null>(null);
  const [examDate, setExamDate] = useState("");
  const [coverageTarget, setCoverageTarget] = useState("");
  const sheetRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeHandlerRef = useRef(onClose);
  closeHandlerRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHandlerRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void Promise.all([getTodayOverview(controller.signal), getBudget()]).then(([today, budget]) => {
      if (controller.signal.aborted) return;
      setTargetRetention(today.target_retention);
      setDailyMinutes(budget.daily_minutes);
      setResolvedDailyLimit(budget.new_word_cap);
      setExamBookId(budget.exam_goal?.book_id ?? null);
      setExamDate(budget.exam_goal?.target_date ?? "");
      setCoverageTarget(budget.exam_goal?.coverage_target ? String(budget.exam_goal.coverage_target) : "");
    }).catch(() => {
      if (!controller.signal.aborted) setTargetRetention(null);
    });
    return () => controller.abort();
  }, [open]);
  if (!open) return null;
  return <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={sheetRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
      <header><div><span className="eyebrow">WordLoop</span><h2 id={headingId}>设置</h2></div><button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭设置" onClick={onClose}>×</button></header>
      <div className="settings-section"><h3>外观</h3><div className="appearance-options" role="group" aria-label="外观模式">
        {(["system", "light", "dark"] as const).map((value) => <button type="button" key={value} aria-pressed={appearance === value} onClick={() => onAppearanceChange(value)}>{value === "system" ? "跟随系统" : value === "light" ? "浅色" : "深色"}</button>)}
      </div></div>
      <div className="settings-section"><h3>每日学习时间</h3><p>时间用来安排今日任务；到时后会暂停自动安排新任务，已展示题目可以完成。</p>
        <div className="settings-budget-control"><label htmlFor="daily-study-minutes">每日预算</label><select id="daily-study-minutes" value={dailyMinutes} disabled={busy || !onSaveDailyTimeBudget} onChange={event => setDailyMinutes(Number(event.target.value))}>
          {!([20, 30, 45, 60, 90, 120] as number[]).includes(dailyMinutes) && <option value={dailyMinutes}>{dailyMinutes} 分钟（当前）</option>}
          {[20, 30, 45, 60, 90, 120].map(value => <option key={value} value={value}>{value} 分钟</option>)}
        </select><button type="button" className="secondary-button" disabled={busy || !onSaveDailyTimeBudget} onClick={async () => { setSaveError(""); try { await onSaveDailyTimeBudget?.(dailyMinutes); const budget = await getBudget(); setDailyMinutes(budget.daily_minutes); } catch (error) { setSaveError(error instanceof Error ? error.message : "时间预算保存失败，请重试。"); } }}>保存时间预算</button></div>
      </div>
      <div className="settings-section"><h3>考试目标</h3><p>{examBookId ? `当前词书：${examBookId}。覆盖统计按唯一词头计算。` : "请先在今日页面选择目标考试词书。"}</p>
        <div className="settings-budget-control"><label htmlFor="exam-deadline">考试日期（可选）</label><input id="exam-deadline" type="date" value={examDate} disabled={busy || !examBookId} onChange={event => setExamDate(event.target.value)} /></div>
        <div className="settings-budget-control"><label htmlFor="exam-coverage-target">计划覆盖词量（可选）</label><input id="exam-coverage-target" type="number" min={1} max={100000} placeholder="全部词书词汇" value={coverageTarget} disabled={busy || !examBookId} onChange={event => setCoverageTarget(event.target.value)} /></div>
        <button type="button" className="secondary-button" disabled={busy || !onSaveExamGoal || !examBookId || (coverageTarget !== "" && (!Number.isInteger(Number(coverageTarget)) || Number(coverageTarget) < 1 || Number(coverageTarget) > 100000))} onClick={async () => { setSaveError(""); try { await onSaveExamGoal?.(examDate || null, coverageTarget ? Number(coverageTarget) : null); const budget = await getBudget(); setExamBookId(budget.exam_goal?.book_id ?? null); setExamDate(budget.exam_goal?.target_date ?? ""); setCoverageTarget(budget.exam_goal?.coverage_target ? String(budget.exam_goal.coverage_target) : ""); } catch (error) { setSaveError(error instanceof Error ? error.message : "考试目标保存失败，请重试。"); } }}>保存考试目标</button>
      </div>
      <details className="settings-section settings-advanced"><summary>高级设置</summary><div><h3>每日新词安全上限</h3><p>这是最多新增多少个词，不是每天必须完成的数量。降低上限不会删除已学记录。</p>{resolvedDailyLimit !== null && onSaveDailyNewWordLimit ? <DailyNewWordLimitEditor limit={resolvedDailyLimit} onSave={async (limit) => { setSaveError(""); try { return await onSaveDailyNewWordLimit(limit); } catch (error) { setSaveError(error instanceof Error ? error.message : "上限保存失败，请重试。"); throw error; } }} onSaved={({ limit }) => setResolvedDailyLimit(limit)} disabled={busy} /> : <p>当前上限暂时不可读取。</p>}</div></details>
      {saveError && <p role="alert" className="standalone-status error">{saveError}</p>}
      <div className="settings-section"><h3>目标记忆率</h3><p>{targetRetention === null ? "暂时不可读取" : `${(targetRetention * 100).toFixed(0)}%`} · 只读，由当前 FSRS 调度配置决定。</p></div>
      <div className="settings-section"><h3>账号</h3><a className="auth-link" href="/reset-password">设置 / 修改密码</a><button type="button" className="settings-open-button" disabled={busy} onClick={async () => { try { const auth = await getAuthClient(); const result = await auth.auth.signOut({ scope: "local" }); if (result.error) throw result.error; clearToken(); sessionStorage.removeItem("wordloop_draft"); window.location.assign("/login"); } catch { setSaveError("退出失败，请重试。"); } }}>退出登录</button></div>
      <BetaAccounts />
      <div className="settings-section"><EvidenceEvaluation /></div>
    </section>
  </div>;
}
