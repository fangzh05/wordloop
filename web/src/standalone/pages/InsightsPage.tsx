import { useEffect, useMemo, useState } from "react";
import { getAnalytics } from "../apiClient.js";
import type { ReadModelEnvelope } from "../apiClient.js";

type Section = "overview" | "memory" | "weakness" | "activity";
type Range = "7d" | "30d" | "90d";
type MatrixDisplay = "count" | "per100";
type AnalyticsData = Record<string, unknown>;

const sections: Array<{ id: Section; label: string }> = [
  { id: "overview", label: "概览" }, { id: "memory", label: "记忆" },
  { id: "weakness", label: "薄弱" }, { id: "activity", label: "活动" },
];
const ranges: Range[] = ["7d", "30d", "90d"];

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(object) : [];
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function count(value: unknown): string {
  const parsed = number(value);
  return parsed === null ? "—" : new Intl.NumberFormat("zh-CN").format(parsed);
}
function percent(value: unknown): string {
  const parsed = number(value);
  return parsed === null ? "—" : `${(parsed * 100).toFixed(1)}%`;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function Metric({ label, value, note }: { label: string; value: string; note?: string }): React.JSX.Element {
  return <div className="insight-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function BarList({ values, onSelect }: { values: Array<Record<string, unknown>>; onSelect?: (row: Record<string, unknown>) => void }): React.JSX.Element {
  const max = Math.max(1, ...values.map((row) => number(row.count) ?? 0));
  return <div className="insight-bar-list">{values.map((row) => {
    const value = number(row.count) ?? 0;
    return <button type="button" className="insight-bar-row" key={String(row.label ?? row.date)} onClick={() => onSelect?.(row)}>
      <span>{String(row.label ?? row.date ?? "")}</span><span className="insight-bar-track"><i style={{ width: `${Math.max(0, (value / max) * 100)}%` }} /></span><b>{count(value)}</b>
    </button>;
  })}</div>;
}

export function InsightsPage({ tokenKey, onOpenWord }: { tokenKey: string | null; onOpenWord: (userWordId: string) => void }): React.JSX.Element {
  const [section, setSection] = useState<Section>("overview");
  const [range, setRange] = useState<Range>("30d");
  const [matrixDisplay, setMatrixDisplay] = useState<MatrixDisplay>("count");
  const [result, setResult] = useState<ReadModelEnvelope<AnalyticsData> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [focusRows, setFocusRows] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setResult(null);
    setError("");
    setCursor(null);
    void getAnalytics<AnalyticsData>(section, range, "", 50, controller.signal).then((response) => {
      if (!active) return;
      setResult(response);
      const focus = rows(object(response.data).focus_words);
      setFocusRows(focus);
      setCursor(response.next_cursor ?? null);
    }).catch(() => {
      if (active && !controller.signal.aborted) setError("这页洞察暂时不可用。再次尝试不会影响学习队列或复习安排。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [section, range, tokenKey]);

  const data = object(result?.data);
  const review = object(data.long_term_first_recall);
  const currentMemory = object(data.current_memory);
  const memory = object(data.current_snapshot);
  const stability = object(memory.stability_days);
  const difficulty = object(memory.difficulty);
  const retrievability = object(memory.retrievability);
  const due = object(data.due_distribution);
  const trend = rows(data.success_trend);
  const memoryScatter = rows(data.scatter_points);
  const weakMatrix = rows(data.historical_error_matrix);
  const activity = rows(data.days);

  const histogramLists = useMemo(() => ({
    stability: rows(stability.histogram), difficulty: rows(difficulty.histogram), retrievability: rows(retrievability.histogram),
  }), [stability.histogram, difficulty.histogram, retrievability.histogram]);

  const loadMoreFocus = async () => {
    if (!cursor || loading) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    try {
      const page = await getAnalytics<AnalyticsData>("weakness", range, cursor, 50, controller.signal);
      setFocusRows((current) => [...current, ...rows(object(page.data).focus_words)]);
      setCursor(page.next_cursor ?? null);
    } catch {
      setError("更多关注词暂时无法读取。");
    } finally { setLoading(false); }
  };

  return <section className="insights-page" aria-labelledby="insights-title">
    <header className="page-heading">
      <span className="eyebrow">Insights</span><h1 id="insights-title">洞察</h1>
      <p>看见记忆的变化，找到下一步值得关注的地方。</p>
    </header>
    <nav className="insight-tabs" aria-label="洞察分区">
      {sections.map((item) => <button type="button" key={item.id} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>{item.label}</button>)}
    </nav>
    <div className="insight-controls">
      <span>历史范围</span>{ranges.map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{value.replace("d", " 天")}</button>)}
      {result && <small>更新于 {new Date(result.as_of).toLocaleString("zh-CN", { timeZone: result.timezone })} · {result.timezone}</small>}
    </div>
    {loading && !result && <p className="standalone-status" role="status">正在读取本页数据…</p>}
    {error && <p className="standalone-status error" role="alert">{error}</p>}
    {result && <div className="insight-content" key={section}>
      {section === "overview" && <>
        <div className="insight-metric-grid">
          <Metric label="长期首次回忆成功率" value={percent(review.success_rate)} note={`${count(review.passes)} / ${count(review.samples)} 个样本${review.small_sample ? " · 样本较少" : ""}`} />
          <Metric label="已进入记忆" value={count(currentMemory.scheduled_word_count)} note="当前快照；仅计算已调度词" />
          <Metric label="平均稳定性" value={number(currentMemory.average_stability_days) === null ? "—" : `${number(currentMemory.average_stability_days)!.toFixed(2)} 天`} />
          <Metric label="目标记忆率" value={percent(result.coverage.target_retention)} note="当前调度配置参照，不是考试分数" />
        </div>
        <section className="insight-panel"><h2>当前到期快照</h2><p className="muted-copy">只统计已排定的下一次到期，不是未来工作量预测。</p>
          <div className="insight-metric-grid compact">
            <Metric label="往日逾期" value={count(due.overdue_previous_days)} />
            <Metric label="今日已到期" value={count(due.due_today_elapsed)} />
            <Metric label="今日稍后" value={count(due.due_today_later)} />
            <Metric label="未来 7 天" value={count(due.future_next_7_days)} />
          </div>
        </section>
        <section className="insight-panel"><h2>关注词</h2><FocusList values={focusRows} onOpenWord={onOpenWord} /></section>
        <section className="insight-panel"><h2>首次回忆成功趋势</h2><TrendBars values={trend} target={number(result.coverage.target_retention)} /></section>
      </>}

      {section === "memory" && <>
        <div className="insight-snapshot-label">当前记忆快照 · 不随历史范围变化</div>
        <div className="insight-metric-grid compact">
          <Metric label="已调度词" value={count(memory.scheduled_word_count)} />
          <Metric label="稳定性均值 / 中位数" value={number(stability.mean) === null || number(stability.median) === null ? "—" : `${number(stability.mean)!.toFixed(2)} / ${number(stability.median)!.toFixed(2)} 天`} />
          <Metric label="难度均值 / 中位数" value={number(difficulty.mean) === null || number(difficulty.median) === null ? "—" : `${number(difficulty.mean)!.toFixed(2)} / ${number(difficulty.median)!.toFixed(2)}`} />
          <Metric label="R 无法计算" value={count(memory.retrievability_missing_count)} note="无最后复习或模型输入无效" />
          <Metric label="无效或排除" value={count(memory.excluded_count)} />
        </div>
        <section className="insight-panel"><h2>稳定性 S（天）</h2><BarList values={histogramLists.stability} /></section>
        <section className="insight-panel"><h2>难度 D</h2><BarList values={histogramLists.difficulty} /></section>
        <section className="insight-panel"><h2>可回忆率 R</h2><p className="muted-copy">模型估计值；低于目标不等于确定忘记。</p><BarList values={histogramLists.retrievability} /></section>
        <section className="insight-panel"><h2>D × S 散点</h2><p className="muted-copy">D 横轴 1–10；S 纵轴为对数天数。点可键盘聚焦后打开词详情。</p><MemoryScatter values={memoryScatter} onOpenWord={onOpenWord} total={number(object(memory.scatter).total) ?? memoryScatter.length} /></section>
        <section className="insight-panel"><h2>首次回忆趋势</h2><TrendBars values={trend} target={number(result.coverage.target_retention)} /></section>
      </>}

      {section === "weakness" && <>
        <section className="insight-panel"><h2>当前活动错误词</h2><div className="insight-metric-grid compact">{Object.entries(object(data.active_error_words)).map(([key, value]) => <Metric key={key} label={key === "distinct_words" ? "不同词" : errorLabel(key)} value={count(value)} />)}</div></section>
        <section className="insight-panel"><h2>所选期间错误事件</h2><p className="muted-copy">错误事件 ÷ 同题型全部 attempts × 100；这是每百次尝试中的错误标注频次，不是能力正确率。一个尝试只归入一个错误层，未标注项单列。</p>
          <div className="matrix-display-controls" role="group" aria-label="错误矩阵显示方式"><button type="button" aria-pressed={matrixDisplay === "count"} onClick={() => setMatrixDisplay("count")}>次数</button><button type="button" aria-pressed={matrixDisplay === "per100"} onClick={() => setMatrixDisplay("per100")}>每 100 次尝试</button></div>
          <div className="table-wrap"><table><thead><tr><th scope="col">题型</th><th scope="col">错误层</th><th scope="col">{matrixDisplay === "count" ? "错误事件数" : "错误事件 / 100 次尝试"}</th><th scope="col">不同词</th><th scope="col">该题型全部尝试</th><th scope="col">已标错误层尝试</th></tr></thead><tbody>{weakMatrix.map((row, index) => {
            const events = number(row.error_events) ?? 0;
            const attempts = number(row.activity_attempts) ?? 0;
            const displayed = matrixDisplay === "count" ? count(events) : attempts > 0 ? `${(events / attempts * 100).toFixed(1)}%` : "—";
            return <tr key={`${String(row.activity_type)}-${String(row.error_layer)}-${index}`}><th scope="row">{activityLabel(String(row.activity_type))}</th><td>{errorLabel(String(row.error_layer))}</td><td>{displayed}</td><td>{count(row.distinct_words)}</td><td>{count(attempts)}</td><td>{count(row.determinable_attempts)}</td></tr>;
          })}</tbody></table></div>
        </section>
        <section className="insight-panel"><h2>关注词</h2><FocusList values={focusRows} onOpenWord={onOpenWord} />{cursor && <button type="button" className="secondary-button" disabled={loading} onClick={() => void loadMoreFocus()}>{loading ? "正在加载…" : "加载更多"}</button>}</section>
      </>}

      {section === "activity" && <>
        <section className="insight-panel"><h2>每日活动</h2><p className="muted-copy">热度以正式 review 次数呈现；各系列独立展示，不能相加成一个学习总量。</p>
          <ActivityGrid values={activity} onSelect={(date) => { const found = activity.find((item) => item.local_date === date); if (found) setResult((current) => current ? { ...current, data: { ...current.data, selected_day: found } } : current); }} />
        </section>
        {data.selected_day && <section className="insight-panel"><h2>{String(object(data.selected_day).local_date)} 明细</h2><div className="insight-metric-grid compact">{Object.entries(object(data.selected_day)).filter(([key]) => key !== "local_date").map(([key, value]) => <Metric key={key} label={activityLabel(key)} value={count(value)} />)}</div></section>}
        <section className="insight-panel"><h2>活动口径</h2><p className="muted-copy">首次引入取每词最早预测试日志。首次正式学习完成和专注时长缺少可靠埋点，因此不显示。</p></section>
      </>}
    </div>}
  </section>;
}

function FocusList({ values, onOpenWord }: { values: Array<Record<string, unknown>>; onOpenWord: (id: string) => void }): React.JSX.Element {
  if (!values.length) return <p>目前没有关注词。</p>;
  return <ul className="focus-word-list">{values.map((word) => <li key={String(word.user_word_id)}><button type="button" onClick={() => onOpenWord(String(word.user_word_id))}><strong>{String(word.word || "词条")}</strong><span>{array(word.reasons).map((reason) => ({ active_error:"有活动错误",overdue:"已逾期",r_below_target:"回忆概率低于目标",high_d_low_s:"难度较高、稳定性较低" } as Record<string,string>)[String(reason)] ?? String(reason)).join(" · ")}</span></button></li>)}</ul>;
}

function TrendBars({ values, target }: { values: Array<Record<string, unknown>>; target: number | null }): React.JSX.Element {
  if (!values.length) return <p>所选期间没有可显示的正式 review 样本。</p>;
  return <div className="trend-scroll"><svg className="trend-chart" viewBox={`0 0 ${Math.max(320, values.length * 20 + 70)} 160`} role="img" aria-label="按日期汇总的滚动首次回忆成功率">
    <line x1="28" y1="16" x2="28" y2="132" /><line x1="28" y1="132" x2={Math.max(290, values.length * 20 + 40)} y2="132" />
    {target !== null && <g className="retention-target"><line x1="28" y1={132-target*108} x2={Math.max(290,values.length*20+40)} y2={132-target*108} strokeDasharray="5 5"/><text x="55" y={125-target*108}>目标 {percent(target)}</text></g>}
    {values.map((row, index) => {
      const rolling = object(row.rolling_7d);
      const rate = number(rolling.rate);
      if (rate === null) return null;
      const x = 34 + index * 20;
      const y = rate === null ? 132 : 132 - Math.max(0, Math.min(1, rate)) * 108;
      return <g key={String(row.date)}><circle cx={x} cy={y} r="3.5" className={rate === null ? "no-data" : ""}><title>{String(row.date)}：{percent(rate)}，{count(rolling.passes)} / {count(rolling.samples)}</title></circle><text x={x} y="151">{String(row.date).slice(-2)}</text></g>;
    })}
  </svg><p className="muted-copy">每个点汇总前 7 天分子与分母后相除；今日点截至当前。留空表示无合格样本。</p></div>;
}

function MemoryScatter({ values, onOpenWord, total }: { values: Array<Record<string, unknown>>; onOpenWord: (id: string) => void; total: number }): React.JSX.Element {
  if (!values.length) return <p>当前没有可绘制的 D/S 记忆卡。</p>;
  const minLog = Math.log10(0.1);
  const maxLog = Math.log10(36500);
  return <div className="scatter-wrap"><svg viewBox="0 0 600 320" role="group" aria-label={`D/S 散点，当前显示 ${values.length} / ${total} 个词`}>
    <line x1="48" y1="20" x2="48" y2="276" /><line x1="48" y1="276" x2="580" y2="276" />
    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((tick) => <g key={tick}><line className="chart-grid-line" x1={48 + (tick - 1) * 59} y1="20" x2={48 + (tick - 1) * 59} y2="276" /><text x={48 + (tick - 1) * 59} y="298">{tick}</text></g>)}
    {[0.1, 1, 10, 100, 1000, 10000].map((tick) => <text key={tick} x="4" y={276 - ((Math.log10(tick) - minLog) / (maxLog - minLog)) * 256}>{tick}d</text>)}
    {values.map((point, index) => {
      const difficulty = number(point.difficulty);
      const stability = number(point.stability_days);
      if (difficulty === null || stability === null || stability <= 0) return null;
      const x = 48 + ((Math.max(1, Math.min(10, difficulty)) - 1) / 9) * 532;
      const plottedStability = Math.max(0.1, Math.min(36500, stability));
      const y = 276 - ((Math.log10(plottedStability) - minLog) / (maxLog - minLog)) * 256;
      return <circle key={String(point.user_word_id ?? index)} cx={x} cy={y} r="4" tabIndex={0} role="button" aria-label={`${String(point.word ?? "词条")}, 难度 ${difficulty}, 稳定性 ${stability.toFixed(1)} 天`} onClick={() => onOpenWord(String(point.user_word_id))} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenWord(String(point.user_word_id)); } }}><title>{String(point.word ?? "词条")} · D {difficulty.toFixed(1)} · S {stability.toFixed(1)} 天</title></circle>;
    })}
  </svg><p className="muted-copy">显示 {values.length} / {total} 个已调度词。点重叠时可使用下方对应记录。</p><div className="scatter-table">{values.map((point) => <button key={String(point.user_word_id)} type="button" onClick={() => onOpenWord(String(point.user_word_id))}>{String(point.word ?? "词条")} · D {number(point.difficulty)?.toFixed(1) ?? "—"} · S {number(point.stability_days)?.toFixed(1) ?? "—"} 天 · R {percent(point.retrievability)}</button>)}</div></div>;
}

function ActivityGrid({ values, onSelect }: { values: Array<Record<string, unknown>>; onSelect: (date: string) => void }): React.JSX.Element {
  if (!values.length) return <p>所选日期范围没有记录。</p>;
  const max = Math.max(1, ...values.map((item) => number(item.formal_review_count) ?? 0));
  return <div className="activity-grid" aria-label="每日正式复习次数">{values.map((item) => {
    const value = number(item.formal_review_count) ?? 0;
    const level = value === 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4));
    return <button key={String(item.local_date)} type="button" className={`activity-day level-${level}`} aria-label={`${String(item.local_date)}，正式复习 ${value} 次`} onClick={() => onSelect(String(item.local_date))}><span>{String(item.local_date).slice(-2)}</span><small>{value}</small></button>;
  })}</div>;
}

function errorLabel(value: string): string {
  return ({ meaning: "词义", collocation: "搭配", grammar: "语法", pronunciation: "发音", spelling: "拼写", unclassified: "未分类" } as Record<string, string>)[value] ?? value;
}
function activityLabel(value: string): string {
  return ({ formal_review_count: "正式 review 次数", distinct_review_words: "不同复习词", pretest_count: "预测试次数", first_introductions: "首次引入", capture_count: "捕获次数", ordinary_attempt_count: "练习尝试", distinct_attempt_words: "练习词数", first_formal_learning_completion: "首次正式学习完成", review: "正式复习", exact_cloze: "语境填空", sentence: "情境造句", translation_en_to_cn: "英译中", translation_cn_to_en: "中译英", pretest_cn_to_en:"预测试", word_recall:"单词回忆", collocation:"搭配" } as Record<string, string>)[value] ?? value;
}
