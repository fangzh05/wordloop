import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { DailyNewWordControl } from "../components/DailyNewWordControl.js";
import { ArrowIcon } from "../components/Icons.js";
import { callServerTool, sendUserMessage, structuredContentOf, subscribeToApp, updateModelContext } from "../mcpBridge.js";

const progressSchema = z.object({
  today: z.object({ total: z.number(), known: z.number(), uncertain: z.number(), unknown: z.number(), completed: z.number() }),
  all_time: z.object({ total_words: z.number(), mastered: z.number(), learning: z.number(), error_book: z.number() }),
  fsrs: z.object({ due_now: z.number(), due_today: z.number(), tomorrow: z.number(), due_next_7_days: z.number(), average_stability: z.number() }),
  settings: z.object({ daily_new_word_limit: z.number().int().min(1).max(200) }),
});
const payloadSchema = z.object({ widget: z.literal("dashboard"), progress: progressSchema });
type Progress = z.infer<typeof progressSchema>;

export function LearningDashboard(): React.JSX.Element {
  const [progress, setProgress] = useState<Progress | null>(null);
  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolresult") return;
    const parsed = payloadSchema.safeParse(event.value.structuredContent);
    if (parsed.success) setProgress(parsed.data.progress);
  }), []);

  if (!progress) return <section className="widget-card skeleton" aria-busy="true"><span>正在读取进度…</span></section>;
  const percent = progress.today.total === 0 ? 0 : Math.round(progress.today.completed / progress.today.total * 100);
  const learningToday = Math.max(0, progress.today.completed - progress.today.known);

  async function followUp(text: string): Promise<void> {
    await updateModelContext("Current Wordloop progress is attached.", { wordloopProgress: progress });
    await sendUserMessage(text);
  }

  async function refreshProgress(): Promise<void> {
    const result = await callServerTool("get_progress", {});
    const parsed = progressSchema.safeParse(structuredContentOf(result));
    if (!result.isError && parsed.success) setProgress(parsed.data);
  }

  return <section className="widget-card" aria-labelledby="dashboard-title">
    <header className="widget-header dashboard-heading">
      <div><span className="eyebrow">学习进度</span><h1 id="dashboard-title">今日单词</h1></div>
      <div className="progress-number"><strong>{progress.today.completed}</strong><span>/ {progress.today.total}</span></div>
    </header>
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={progress.today.total} aria-valuenow={progress.today.completed}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <dl className="metrics">
      <div><dt>已会</dt><dd>{progress.today.known}</dd></div>
      <div><dt>学习中</dt><dd>{learningToday}</dd></div>
      <div><dt>错词</dt><dd>{progress.all_time.error_book}</dd></div>
    </dl>
    <DailyNewWordControl limit={progress.settings.daily_new_word_limit} todayPrepared={progress.today.total} onSaved={() => void refreshProgress()} />
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
