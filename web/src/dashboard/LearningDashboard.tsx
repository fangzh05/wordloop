import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { DailyNewWordControl } from "../components/DailyNewWordControl.js";
import { ArrowIcon } from "../components/Icons.js";
import { sendUserMessage, subscribeToApp } from "../mcpBridge.js";

const progressSchema = z.object({
  today: z.object({ total: z.number(), known: z.number(), uncertain: z.number(), unknown: z.number(), completed: z.number() }),
  review_today: z.object({ completed: z.number(), total: z.number(), remaining: z.number() })
    .default({ completed: 0, total: 0, remaining: 0 }),
  all_time: z.object({ total_words: z.number(), mastered: z.number(), learning: z.number(), error_book: z.number() }),
  fsrs: z.object({ due_now: z.number(), due_today: z.number(), tomorrow: z.number(), due_next_7_days: z.number(), average_stability: z.number() }),
  settings: z.object({ daily_new_word_limit: z.number().int().min(1).max(200) }),
});
const payloadSchema = z.object({
  widget: z.literal("dashboard"),
  progress: progressSchema,
  pending_consolidation: z.object({ activity_type: z.string(), label: z.string(), estimated_seconds: z.number().int().min(1) }).nullable().optional(),
});
type Progress = z.infer<typeof progressSchema>;

export function DashboardProgressBlock({ title, completed, total, emptyText }: {
  title: string;
  completed: number;
  total: number;
  emptyText: string;
}): React.JSX.Element {
  const hasTasks = total > 0;
  const percent = hasTasks ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return <section className="dashboard-progress-block" aria-label={title}>
    <div className="dashboard-progress-heading"><strong>{title}</strong>
      <span>{hasTasks ? `${completed} / ${total} 已完成` : emptyText}</span>
    </div>
    {hasTasks && <div className="progress-track" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(completed, total)}>
      <span style={{ width: `${percent}%` }} />
    </div>}
  </section>;
}

export function LearningDashboard(): React.JSX.Element {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pendingTask, setPendingTask] = useState<z.infer<typeof payloadSchema>["pending_consolidation"]>(null);
  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolresult") return;
    const parsed = payloadSchema.safeParse(event.value.structuredContent);
    if (parsed.success) { setProgress(parsed.data.progress); setPendingTask(parsed.data.pending_consolidation ?? null); }
  }), []);

  if (!progress) return <section className="widget-card skeleton" aria-busy="true"><span>正在读取进度…</span></section>;
  async function followUp(text: string): Promise<void> {
    await sendUserMessage(text);
  }

  return <section className="widget-card" aria-labelledby="dashboard-title">
    <header className="widget-header">
      <div><span className="eyebrow">学习进度</span><h1 id="dashboard-title">WordLoop</h1></div>
    </header>
    <div className="dashboard-progress-list">
      <DashboardProgressBlock
        title="今日复习"
        completed={progress.review_today.completed}
        total={progress.review_today.total}
        emptyText="无到期复习"
      />
      <DashboardProgressBlock
        title="今日新词"
        completed={progress.today.completed}
        total={progress.today.total}
        emptyText="暂无新词"
      />
    </div>
    {pendingTask && <section className="dashboard-progress-block" aria-label="待做应用巩固">
      <div className="dashboard-progress-heading"><strong>应用巩固待做：{pendingTask.label}</strong><span>词汇完成与应用巩固分开记录</span></div>
      <Button onClick={() => void followUp("请开始服务端保存的 pending 应用巩固。必须复用 exercisePlanner 已保存的 plan_id、exercise_id、activity_type、目标和提示程度，不得重选题型或词；按计划生成后只显示这一题。")}>做一道，约 {Math.max(1, Math.round(pendingTask.estimated_seconds / 60))} 分钟</Button>
    </section>}
    <dl className="metrics">
      <div><dt>错词</dt><dd>{progress.all_time.error_book}</dd></div>
      <div><dt>已掌握</dt><dd>{progress.all_time.mastered}</dd></div>
    </dl>
    <DailyNewWordControl
      limit={progress.settings.daily_new_word_limit}
      todayPrepared={progress.today.total}
      onSaved={(value) => setProgress((current) => current ? {
        ...current,
        settings: { ...current.settings, daily_new_word_limit: value.limit },
        today: { ...current.today, total: value.prepared },
      } : current)}
    />
    <div className="section-divider" />
    <span className="eyebrow">复习安排</span>
    <dl className="metrics fsrs-metrics">
      <div><dt>当前到期</dt><dd>{progress.fsrs.due_now}</dd></div>
      <div><dt>明日到期</dt><dd>{progress.fsrs.tomorrow}</dd></div>
      <div><dt>未来 7 天</dt><dd>{progress.fsrs.due_next_7_days}</dd></div>
    </dl>
    <div className="button-row dashboard-actions">
      <Button onClick={() => void followUp("继续今天的英语学习")}>继续学习 <ArrowIcon className="button-icon trailing" /></Button>
      <Button className="secondary" onClick={() => void followUp("抽查")}>复习错词</Button>
      <Button className="secondary" onClick={() => void followUp("小测")}>小测</Button>
    </div>
  </section>;
}
