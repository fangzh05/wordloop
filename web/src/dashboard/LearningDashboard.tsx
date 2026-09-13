import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { ArrowIcon } from "../components/Icons.js";
import { sendUserMessage, subscribeToApp, updateModelContext } from "../mcpBridge.js";

const progressSchema = z.object({
  today: z.object({ total: z.number(), known: z.number(), uncertain: z.number(), unknown: z.number(), completed: z.number() }),
  all_time: z.object({ total_words: z.number(), mastered: z.number(), learning: z.number(), error_book: z.number() }),
  fsrs: z.object({ due_now: z.number(), due_today: z.number(), tomorrow: z.number(), due_next_7_days: z.number(), average_stability: z.number() }),
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

  if (!progress) return <section className="widget-card skeleton" aria-busy="true"><span>Loading progress…</span></section>;
  const percent = progress.today.total === 0 ? 0 : Math.round(progress.today.completed / progress.today.total * 100);
  const learningToday = Math.max(0, progress.today.completed - progress.today.known);

  async function followUp(text: string): Promise<void> {
    await updateModelContext("Current Wordloop progress is attached.", { wordloopProgress: progress });
    await sendUserMessage(text);
  }

  return <section className="widget-card" aria-labelledby="dashboard-title">
    <header className="widget-header dashboard-heading">
      <div><span className="eyebrow">Learning progress</span><h1 id="dashboard-title">Today&apos;s vocabulary</h1></div>
      <div className="progress-number"><strong>{progress.today.completed}</strong><span>/ {progress.today.total}</span></div>
    </header>
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={progress.today.total} aria-valuenow={progress.today.completed}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <dl className="metrics">
      <div><dt>Known</dt><dd>{progress.today.known}</dd></div>
      <div><dt>Learning</dt><dd>{learningToday}</dd></div>
      <div><dt>Error book</dt><dd>{progress.all_time.error_book}</dd></div>
    </dl>
    <div className="section-divider" />
    <span className="eyebrow">FSRS review forecast</span>
    <dl className="metrics fsrs-metrics">
      <div><dt>Due now</dt><dd>{progress.fsrs.due_now}</dd></div>
      <div><dt>Tomorrow</dt><dd>{progress.fsrs.tomorrow}</dd></div>
      <div><dt>Next 7 days</dt><dd>{progress.fsrs.due_next_7_days}</dd></div>
    </dl>
    <div className="button-row dashboard-actions">
      <Button onClick={() => void followUp("继续今天的英语学习")}>Continue learning <ArrowIcon className="button-icon trailing" /></Button>
      <Button className="secondary" onClick={() => void followUp("抽查")}>Review errors</Button>
      <Button className="secondary" onClick={() => void followUp("小测")}>Quiz</Button>
    </div>
  </section>;
}
