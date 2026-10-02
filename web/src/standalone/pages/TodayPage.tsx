import { useEffect, useState } from "react";
import { Button } from "../../components/Button.js";
import { getAnalytics, getTodayOverview, type TodayOverview } from "../apiClient.js";
import type { WebApiResponse } from "../apiClient.js";

type TodaySummary = { due_distribution?: Record<string, unknown>; focus_words?: Array<Record<string, unknown>> };

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function phaseLabel(phase: string): string {
  if (phase === "review") return "复习";
  if (phase === "pretest") return "预测试";
  if (phase === "formal_learning") return "正式学习";
  return "今日学习";
}

function ProgressRow({ title, detail, note }: { title: string; detail: string; note: string }) {
  return <div className="today-progress-row">
    <div><strong>{title}</strong><span title={note}>{note}</span></div>
    <b>{detail}</b>
  </div>;
}

export function TodayPage({ view, busy, busyLabel, tokenKey, onContinue, onStartConsolidation, onOpenCapture, onOpenVocabulary }: {
  view: WebApiResponse | null;
  busy: boolean;
  busyLabel?: string | null;
  tokenKey: string | null;
  onContinue: () => void;
  onStartConsolidation: () => void;
  onOpenCapture: () => void;
  onOpenVocabulary: () => void;
}): React.JSX.Element {
  const [today, setToday] = useState<TodayOverview | null>(null);
  const [todayError, setTodayError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void getTodayOverview(controller.signal).then((result) => {
      if (current) { setToday(result); setTodayError(""); }
    }).catch(() => {
      if (current && !controller.signal.aborted) setTodayError("今日进度暂时不可用，请重试。");
    });
    return () => { current = false; controller.abort(); };
  }, [tokenKey, view?.session_revision]);

  useEffect(() => {
    if (!detailsOpen) return;
    const controller = new AbortController();
    setSummaryLoading(true);
    setSummaryError("");
    void getAnalytics<TodaySummary>("overview", "30d", "", 50, controller.signal).then((result) => {
      setSummary(result.data);
    }).catch(() => {
      if (!controller.signal.aborted) setSummaryError("未来到期与关注词暂时不可用。");
    }).finally(() => {
      if (!controller.signal.aborted) setSummaryLoading(false);
    });
    return () => controller.abort();
  }, [detailsOpen, tokenKey]);

  const progress = today?.progress;
  const review = progress?.review;
  const pretest = progress?.pretest;
  const lesson = progress?.formal_learning;
  const active = today?.active_session.active === true;
  const tasksComplete = !view?.budget_paused && Boolean(progress)
    && !active
    && number(review?.remaining) === 0
    && (number(pretest?.total) === 0 || number(pretest?.completed) >= number(pretest?.total));
  const stage = active ? phaseLabel(today!.active_session.phase) : null;

  return <section className="today-page" aria-labelledby="today-title">
    <header className="page-heading">
      <span className="eyebrow">WordLoop</span>
      <h1 id="today-title">今日</h1>
      <p>{today ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeZone: today.timezone }).format(new Date(today.as_of)) : "学习进度与当前任务"}</p>
    </header>

    <section className="today-focus-card" aria-label="继续今日学习">
      <div>
        <span className="eyebrow">{stage ? `当前阶段 · ${stage}` : "今日学习"}</span>
        <h2>{view?.budget_paused ? "今日预计预算已完成" : stage ? "把这一轮学完。" : tasksComplete ? "今日计划已完成" : "先复习，再学一点新的。"}</h2>
        <p>{active ? `会话开始于 ${today?.active_session.started_at ? new Date(today.active_session.started_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: today.timezone }) : "今天"}。继续上次停下的位置。` : "从今天该做的任务开始。"}</p>
      </div>
      <Button className="primary today-primary-action" type="button" disabled={busy || !view || tasksComplete} onClick={onContinue}>
        {busy ? busyLabel ?? "正在处理…" : view?.budget_paused ? "查看保留的任务" : tasksComplete ? "今日计划已完成" : active ? "继续学习" : "开始今日学习"}
      </Button>
    </section>

    {view?.pending_consolidation && <section className="today-focus-card today-consolidation" aria-label="待做应用巩固">
      <div>
        <span className="eyebrow">应用巩固待做</span>
        <h2>{String(view.pending_consolidation.label ?? "应用任务")}</h2>
        <p>本轮词汇已经完成，再用一道应用题把它串起来。</p>
      </div>
      <Button className="secondary today-primary-action" type="button" disabled={busy} onClick={onStartConsolidation}>
        {busy ? busyLabel ?? "正在处理…" : `做一道，约 ${Math.max(1, Math.round(number(view.pending_consolidation.estimated_seconds) / 60))} 分钟`}
      </Button>
    </section>}

    <section className="today-progress-card" aria-labelledby="today-progress-title">
      <div className="section-heading"><h2 id="today-progress-title">今日进度</h2><span>北京时间 · 服务器记录</span></div>
      {todayError && <p className="standalone-status error" role="alert">{todayError}</p>}
      {!today && !todayError && <p className="standalone-status" role="status">正在读取今日进度…</p>}
      {today && <div className="today-progress-list">
        <ProgressRow title="正式复习" detail={`${number(review?.completed)} / ${number(review?.total)}`} note={review?.scope === "active_session" ? "当前这一轮" : "今日正式复习"} />
        <ProgressRow title="预测试" detail={`${number(pretest?.completed)} / ${number(pretest?.total)}`} note="先判断熟悉程度" />
        <ProgressRow title="正式学习" detail={`${number(lesson?.completed_distinct_words)} 个词`} note={`新词 ${number(lesson?.new_words)} · 复习补学 ${number(lesson?.relearn_words)}`} />
      </div>}
    </section>

    <div className="today-secondary-grid"><section className="today-capture-card" aria-label="划词笔记待整理">
      <div><div><span className="eyebrow">Capture</span><h2>待整理</h2></div><strong>{today ? today.captures.inbox_count : "—"}</strong></div>
      <p>划词只保存笔记；加入学习需要你明确选择。</p>
      <Button className="secondary" type="button" onClick={onOpenCapture}>打开划词笔记</Button>
    </section>

    <section className="today-lower-section">
      <button className="today-disclosure" type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
        <span><strong>接下来 7 天</strong><small>当前已排定到期快照</small></span><span aria-hidden="true">{detailsOpen ? "−" : "+"}</span>
      </button>
      {detailsOpen && <div className="today-lower-content">
        {summaryLoading && <p role="status">正在读取到期安排…</p>}
        {summaryError && <p className="standalone-status error" role="alert">{summaryError}</p>}
        {summary && <>
          <p className="today-snapshot-note">更新时间 {new Date(today?.as_of ?? Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: today?.timezone ?? "Asia/Shanghai" })}。只包含当前已排定的下次到期，不预测复习后产生的任务。</p>
          <div className="today-due-summary">
            <div><span>往日逾期</span><b>{number(summary.due_distribution?.overdue_previous_days)}</b></div>
            <div><span>今日已到期</span><b>{number(summary.due_distribution?.due_today_elapsed)}</b></div>
            <div><span>今日稍后</span><b>{number(summary.due_distribution?.due_today_later)}</b></div>
            {(Array.isArray(summary.due_distribution?.future_days) ? summary.due_distribution?.future_days as Array<Record<string, unknown>> : []).slice(0, 7).map((day) => <div key={String(day.date)}><span>{String(day.date)}</span><b>{number(day.count)}</b></div>)}
          </div>
          <h3>最多 3 个关注词</h3>
          {summary.focus_words?.length ? <ul className="today-focus-list">{summary.focus_words.slice(0, 3).map((word) => <li key={String(word.user_word_id)}><span>{String(word.word || "词条")}</span><small>{(Array.isArray(word.reasons) ? word.reasons : []).map((reason) => ({ active_error:"有活动错误",overdue:"已逾期",r_below_target:"回忆概率低于目标",high_d_low_s:"难度较高、稳定性较低" } as Record<string,string>)[String(reason)] ?? String(reason)).join(" · ")}</small></li>)}</ul> : <p>目前没有需要优先关注的词。</p>}
          <Button className="secondary" type="button" onClick={onOpenVocabulary}>打开词库</Button>
        </>}
      </div>}
    </section></div>
  </section>;
}
