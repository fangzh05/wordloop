import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { DailyNewWordLimitEditor, type DailyNewWordLimitSaveResult } from "../components/DailyNewWordLimitEditor.js";
import { CaptureNotesPage } from "./CaptureNotesPage.js";
import { Icon } from "./DesignIcons.js";
import { SelectionCapture } from "./SelectionCapture.js";
import { AppNavigation, SettingsSheet, type AppSection, type Appearance } from "./AppShell.js";
import { TodayPage } from "./pages/TodayPage.js";
import { InsightsPage } from "./pages/InsightsPage.js";
import { VocabularyPage } from "./pages/VocabularyPage.js";
import { WordDetailPanel } from "./components/WordDetailPanel.js";
import { shouldSubmitMultiline, shouldSubmitSingleLine } from "./studyInput.js";
import {
  ApiError,
  StaleStudyStateError,
  UnauthorizedError,
  clearToken,
  getBootstrap,
  getCaptureNotes,
  postAction,
  saveToken,
  type CaptureListResponse,
  type WebAction,
  type WebApiResponse,
} from "./apiClient.js";

type PageStatus = "loading" | "auth" | "ready";
type StandalonePage = "dashboard" | "study" | "notes";
type RetryFields = Record<string, unknown> | null;

export function visibleStandalonePage(
  page: StandalonePage,
  screen: WebApiResponse["screen"] | null,
): StandalonePage {
  return page === "study" && screen === "done" ? "dashboard" : page;
}

function initialToken(): string | null {
  try {
    return localStorage.getItem("wordloop_web_token");
  } catch {
    return null;
  }
}

function initialAppearance(): Appearance {
  try {
    const value = localStorage.getItem("wordloop_appearance");
    return value === "light" || value === "dark" ? value : "system";
  } catch { return "system"; }
}

function sectionFromHash(): AppSection | null {
  if (typeof window === "undefined") return null;
  const value = window.location.hash.slice(1);
  return ["today", "study", "capture", "insights", "vocabulary"].includes(value) ? value as AppSection : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasDashboardProgress(value: unknown): boolean {
  const progress = record(value);
  const sections = ["today", "review_today", "all_time", "fsrs"].map((key) => record(progress[key]));
  if (!["today", "review_today", "all_time", "fsrs"].every((key) => {
    const section = progress[key];
    return typeof section === "object" && section !== null && !Array.isArray(section);
  })) return false;
  const values = [
    sections[0]?.total, sections[0]?.completed,
    sections[1]?.completed, sections[1]?.total, sections[1]?.remaining,
    sections[2]?.error_book, sections[2]?.mastered,
    sections[3]?.due_now, sections[3]?.tomorrow, sections[3]?.due_next_7_days,
  ];
  return values.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

export function deepSeekMessage(code: string, task: "grading" | "generation"): string {
  const target = task === "grading" ? "批改" : "学习内容生成";
  if (code === "DEEPSEEK_TIMEOUT") return task === "grading" ? "批改超时，请重试" : "内容生成超时，请重试";
  if (code === "DEEPSEEK_HTTP_ERROR") return task === "grading" ? "批改服务暂时不可用，请重试" : "内容生成服务暂时不可用，请重试";
  if (code === "DEEPSEEK_INVALID_OUTPUT" || code === "DEEPSEEK_INVALID_JSON") {
    return task === "grading" ? "批改结果格式异常，请重试" : "生成内容格式异常，请重试";
  }
  if (code === "DEEPSEEK_NOT_CONFIGURED") return "AI 服务尚未配置，请稍后再试。";
  return `${target}暂时无法完成，请重试。`;
}

function messageFor(error: unknown, deepSeekTask: "grading" | "generation" = "grading"): string {
  if (error instanceof ApiError) {
    if (error.code === "INTERNAL_SERVER_ERROR") return "请求未完成，请重试。";
    if (error.code.startsWith("DEEPSEEK_")) return deepSeekMessage(error.code, deepSeekTask);
    return error.message;
  }
  return "连接失败，请检查网络后重试。";
}

function wordsFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((word): word is string => typeof word === "string") : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function todayTasksComplete(value: unknown): boolean {
  const progress = record(value);
  const review = record(progress.review_today);
  const today = record(progress.today);
  const reviewDone = numberValue(review.total) === 0 || numberValue(review.completed) >= numberValue(review.total);
  const newWordsDone = numberValue(today.total) > 0 && numberValue(today.completed) >= numberValue(today.total);
  return reviewDone && newWordsDone;
}

export function standaloneLessonProgressLabel(
  relearnWords: readonly string[],
  queue: readonly string[],
  index: number,
  consolidationKind: "translation" | "sentence" | boolean | null = null,
): string {
  if (consolidationKind === "translation" || consolidationKind === true) return "周期巩固 · 英译中";
  if (consolidationKind === "sentence") return "周期巩固 · 主动表达";
  const relearn = new Set(relearnWords.map((word) => word.trim().toLocaleLowerCase()));
  const relearnTotal = queue.filter((word) => relearn.has(word.trim().toLocaleLowerCase())).length;
  return index < relearnTotal
    ? `复习补学 · ${Math.min(index + 1, relearnTotal)} / ${relearnTotal}`
    : `新词学习 · ${Math.min(index - relearnTotal + 1, Math.max(1, queue.length - relearnTotal))} / ${Math.max(0, queue.length - relearnTotal)}`;
}

export function standaloneLessonDisplayTitle(word: string, exerciseMode: boolean, consolidationKind: "translation" | "sentence" | boolean | null): string {
  if (consolidationKind === "translation" || consolidationKind === true) return "长难句翻译";
  if (consolidationKind === "sentence") return "造句练习";
  if (!exerciseMode) return word || "Lesson";
  return "填空练习";
}

export function dashboardContinueBehavior(view: WebApiResponse): "study" | "continue" {
  const phase = record(view.state).phase;
  return view.screen === "done" || ["review_complete", "pretest_complete", "lesson_complete"].includes(String(phase))
    ? "continue"
    : "study";
}

export function dashboardNextStep(view: WebApiResponse): string {
  const phase = record(view.state).phase;
  if (view.screen === "review" && phase === "review_complete") {
    if (!hasDashboardProgress(view.progress)) return "继续学习";
    const today = record(record(view.progress).today);
    return numberValue(today.total) > numberValue(today.completed) ? "预测试" : "正式学习";
  }
  if (view.screen === "pretest" && phase === "pretest_complete") return "正式学习";
  if (view.screen === "pretest") return "预测试";
  if (view.screen === "review") return "复习";
  if (view.screen === "lesson") return "正式学习";
  if (!hasDashboardProgress(view.progress)) return "继续学习";
  const today = record(record(view.progress).today);
  return numberValue(today.total) > numberValue(today.completed) ? "预测试" : "今日任务已完成";
}

export function activeStudySummary(view: WebApiResponse | null): string | null {
  if (!view || view.screen === "done") return null;
  const state = record(view.state);
  const payload = record(state.payload);
  const currentIndex = numberValue(state.current_index);
  if (view.screen === "lesson") {
    const word = String(state.current_word ?? payload.word ?? "").trim();
    return word ? `Lesson · ${word}` : "Lesson";
  }

  const items = list(payload.items);
  const total = items.length;
  if (total === 0) return view.screen === "review" ? "复习进行中" : "预测试进行中";
  const phaseComplete = view.screen === "review"
    ? state.phase === "review_complete"
    : state.phase === "pretest_complete";
  const current = phaseComplete ? total : Math.min(Math.max(currentIndex + 1, 1), total);
  const name = view.screen === "review" ? "复习" : "预测试";
  return phaseComplete
    ? `${name} · 已完成 ${current} / ${total} 题`
    : `${name} · 第 ${current} / ${total} 题`;
}

export function lessonDraftAnswerForWord(stored: string | null, currentWord: string): string | null {
  if (!stored) return null;
  try {
    const draft = JSON.parse(stored) as { word?: unknown; answer?: unknown };
    return draft.word === currentWord && typeof draft.answer === "string" ? draft.answer : null;
  } catch {
    return null;
  }
}

export function lessonDraftAnswerForState(stored: string | null, currentWord: string, phase: string, prompt: string): string | null {
  if (!stored) return null;
  try {
    const draft = JSON.parse(stored) as { word?: unknown; phase?: unknown; prompt?: unknown; answer?: unknown };
    return draft.word === currentWord && draft.phase === phase && draft.prompt === prompt && typeof draft.answer === "string"
      ? draft.answer
      : null;
  } catch {
    return null;
  }
}

type MutableRef<T> = { current: T };

export async function runForegroundRequest<T>(
  requestInFlightRef: MutableRef<boolean>,
  request: () => Promise<T>,
  afterRelease?: () => void,
): Promise<{ started: boolean; result?: T }> {
  if (requestInFlightRef.current) return { started: false };
  requestInFlightRef.current = true;
  try {
    return { started: true, result: await request() };
  } finally {
    requestInFlightRef.current = false;
    afterRelease?.();
  }
}

export function deferVisibilityBootstrap(
  requestInFlightRef: MutableRef<boolean>,
  refreshPendingRef: MutableRef<boolean>,
): boolean {
  if (!requestInFlightRef.current) return false;
  refreshPendingRef.current = true;
  return true;
}

function lessonDraftContext(state: Record<string, unknown> | undefined): { word: string; phase: string; prompt: string } | null {
  if (!state || state.widget !== "lesson") return null;
  const payload = record(state.payload);
  const consolidationDraft = state.phase === "lesson_complete" && payload.mode === "exercise" && payload.consolidation === true;
  if (state.phase !== "lesson_exercise" && !consolidationDraft) return null;
  const plan = record(payload.plan);
  const word = typeof plan.exercise_id === "string" ? plan.exercise_id
    : typeof state.current_word === "string" ? state.current_word : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!word || !prompt) return null;
  return { word, phase: String(state.phase), prompt };
}

export function lessonDraftTransitioned(
  left: ReturnType<typeof lessonDraftContext>,
  right: ReturnType<typeof lessonDraftContext>,
): boolean {
  return left !== null && !(right !== null
    && left.word === right.word && left.phase === right.phase && left.prompt === right.prompt);
}

export function reviewNoticeForCard(notice: string, noticeIndex: number | null, currentIndex: number): string {
  return noticeIndex === currentIndex ? notice : "";
}

export function StandaloneReviewQuestion({ item, direction }: {
  item: Record<string, unknown>;
  direction: "cn_to_en" | "en_definition";
}): React.JSX.Element {
  const partOfSpeech = typeof item.part_of_speech === "string" && item.part_of_speech.trim()
    ? item.part_of_speech
    : null;
  return <div className="question-block">
    <span className="question-label">{direction === "cn_to_en" ? "中 → 英" : "请用简单英文解释"}</span>
    {direction === "cn_to_en" ? <>
      {partOfSpeech && <span className="part-of-speech">{partOfSpeech}</span>}
      <p className="question-prompt" data-capture-text="true" data-capture-source="review_question" data-capture-type="word">{String(item.meaning_zh ?? "")}</p>
    </> : <>
      <p className="question-word" data-capture-text="true" data-capture-source="review_question" data-capture-type="word">{String(item.word ?? "")}</p>
      {partOfSpeech && <span className="part-of-speech">{partOfSpeech}</span>}
    </>}
  </div>;
}

export function StandaloneReviewFeedback({ notice, noticeIndex, currentIndex }: {
  notice: string;
  noticeIndex: number | null;
  currentIndex: number;
}): React.JSX.Element | null {
  const visibleNotice = reviewNoticeForCard(notice, noticeIndex, currentIndex);
  return visibleNotice ? <p className="standalone-status" role="status">{visibleNotice}</p> : null;
}

export function StandalonePretestAnswerReveal({
  source,
  word,
  answer,
  status,
  errorLayer,
  markedFamiliar,
  busy,
  onContinue,
  onMarkFamiliar,
}: {
  source: string;
  word: string;
  answer: string;
  status: string;
  errorLayer: string;
  markedFamiliar: boolean;
  busy: boolean;
  onContinue: () => void;
  onMarkFamiliar: () => void;
}): React.JSX.Element {
  const known = status === "known";
  const feedback = markedFamiliar
    ? "已标记为熟词。"
    : known
      ? "拼写正确。"
      : errorLayer === "spelling"
        ? "拼写接近，但仍有拼写错误。"
        : "这次没有准确回忆出这个词。";
  const canMarkFamiliar = source === "new_word" && !known;

  return <div className="pretest-reveal standalone-pretest-reveal" role="status">
    <p>你的答案：<strong>{answer || "未作答"}</strong></p>
    <p>正确答案：<strong>{word}</strong></p>
    <p className="pretest-reveal-feedback">{feedback}</p>
    <div className="standalone-actions standalone-pretest-result-actions">
      <Button type="button" disabled={busy} onClick={onContinue}>继续学习</Button>
      {canMarkFamiliar ? <div className="familiar-action-wrap">
        <Button className="secondary familiar-action" type="button" disabled={busy} onClick={onMarkFamiliar}>我本来会这个词</Button>
        <small>标记后将跳过本轮新词学习，但未来仍可能正常复习。</small>
      </div> : null}
    </div>
  </div>;
}

export function StandaloneProgressBlock({ title, completed, total, emptyText, detail }: {
  title: string;
  completed: number;
  total: number;
  emptyText: string;
  detail: string;
}): React.JSX.Element {
  const hasTasks = total > 0;
  const percent = hasTasks ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return <div className="standalone-progress-block" aria-label={title}>
    <div className="standalone-progress-heading"><strong>{title}</strong></div>
    <div className="standalone-progress-number">{hasTasks ? `${completed} / ${total}` : emptyText}</div>
    {hasTasks && <>
      <div className="standalone-progress-track" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(completed, total)}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="standalone-progress-detail">{detail}</span>
    </>}
  </div>;
}

export function StandaloneDashboard({ view, busy, onContinue, onSaveDailyNewWordLimit, isStudying = false, onOpenNotes = () => undefined, captureInboxCount = null }: {
  view: WebApiResponse;
  busy: boolean;
  onContinue: () => void;
  onSaveDailyNewWordLimit?: (limit: number) => Promise<DailyNewWordLimitSaveResult>;
  isStudying?: boolean;
  onOpenNotes?: () => void;
  captureInboxCount?: number | null;
}): React.JSX.Element {
  const [dailyLimitExpanded, setDailyLimitExpanded] = useState(false);
  const dailyLimitEditorId = useId();
  const hasProgress = hasDashboardProgress(view.progress);
  const progress = record(view.progress);
  const review = record(progress.review_today);
  const today = record(progress.today);
  const settings = record(progress.settings);
  const dailyLimitValue = settings.daily_new_word_limit;
  const dailyLimit = typeof dailyLimitValue === "number" && Number.isInteger(dailyLimitValue)
    && dailyLimitValue >= 1 && dailyLimitValue <= 200 ? dailyLimitValue : null;
  const allTime = record(progress.all_time);
  const fsrs = record(progress.fsrs);
  const activeSummary = activeStudySummary(view);
  const nextStep = dashboardNextStep(view);
  const state = record(view.state);
  const flow = record(state.flow);
  const lessonProgress = view.screen === "lesson"
    ? standaloneLessonProgressLabel(
      wordsFrom(flow.relearn_words),
      wordsFrom(flow.lesson_words),
      numberValue(state.current_index),
      state.phase === "lesson_complete" && record(state.payload).consolidation === true
        ? record(state.payload).consolidation_kind === "sentence" ? "sentence" : "translation"
        : state.phase === "lesson_complete" && record(state.payload).wrapup === true,
    )
    : null;

  return <>
    <section className="widget-card standalone-card standalone-progress-card" aria-label="今日学习进度">
      {hasProgress ? <>
        <StandaloneProgressBlock
          title="今日复习"
          completed={numberValue(review.completed)}
          total={numberValue(review.total)}
          emptyText="无到期复习"
          detail={`已完成 · 剩余 ${numberValue(review.remaining)}`}
        />
        <StandaloneProgressBlock
          title="今日新词"
          completed={numberValue(today.completed)}
          total={numberValue(today.total)}
          emptyText="暂无新词"
          detail={`已完成 · 剩余 ${Math.max(0, numberValue(today.total) - numberValue(today.completed))}`}
        />
        {dailyLimit !== null && <div className="standalone-daily-goal">
          <button
            className="standalone-daily-goal-toggle"
            type="button"
            aria-expanded={dailyLimitExpanded}
            aria-controls={dailyLimitEditorId}
            disabled={busy}
            onClick={() => setDailyLimitExpanded((expanded) => !expanded)}
          >
            <span>每日目标</span><strong>{dailyLimit}</strong><span className="standalone-daily-goal-chevron" aria-hidden="true">{dailyLimitExpanded ? "⌄" : "›"}</span>
          </button>
          <div id={dailyLimitEditorId} hidden={!dailyLimitExpanded}>
            {dailyLimitExpanded && onSaveDailyNewWordLimit && <DailyNewWordLimitEditor
              limit={dailyLimit}
              onSave={onSaveDailyNewWordLimit}
              compact
              disabled={busy}
            />}
          </div>
        </div>}
        {todayTasksComplete(view.progress) && <p className="standalone-status" role="status">今日任务完成</p>}
      </> : <p className="standalone-status" role="status">进度暂时无法读取</p>}
      {activeSummary && <div className="standalone-active-study">
        <span className="eyebrow">当前学习</span>
        <p>{activeSummary}</p>
        {lessonProgress && <p className="standalone-current-study-stage">{lessonProgress}</p>}
      </div>}
      <div className="standalone-active-study">
        <p><span>当前下一步：</span><strong>{nextStep}</strong></p>
        {isStudying && <p className="standalone-current-learning" role="status">正在学习</p>}
      </div>
      {!isStudying && <div className="standalone-actions">
        <Button className="primary" type="button" disabled={busy} onClick={onContinue}>继续学习</Button>
        {onOpenNotes && <Button className="secondary" type="button" disabled={busy} onClick={onOpenNotes}>划词笔记</Button>}
      </div>}
    </section>

    {hasProgress && <section className="widget-card standalone-card" aria-label="学习状态">
      <span className="eyebrow">学习状态</span>
      <dl className="metrics standalone-metrics-lifetime">
        <div><dt>错词</dt><dd>{numberValue(allTime.error_book)}</dd></div>
        <div><dt>已掌握</dt><dd>{numberValue(allTime.mastered)}</dd></div>
      </dl>
      <span className="eyebrow">复习安排</span>
      <dl className="metrics standalone-metrics-fsrs">
        <div><dt>当前到期</dt><dd>{numberValue(fsrs.due_now)}</dd></div>
        <div><dt>明日到期</dt><dd>{numberValue(fsrs.tomorrow)}</dd></div>
        <div><dt>未来 7 天</dt><dd>{numberValue(fsrs.due_next_7_days)}</dd></div>
      </dl>
    </section>}

    <section className="widget-card standalone-card capture-dashboard-card" aria-label="划词笔记">
      <div className="capture-dashboard-heading">
        <div><span className="eyebrow">Capture</span><strong>划词笔记</strong></div>
        <span className="capture-dashboard-count">{captureInboxCount ?? "—"}</span>
      </div>
      <p>先捕获，后整理；只有你明确加入学习的项目才会进入 WordLoop 学习队列。</p>
      <Button className="secondary" type="button" disabled={busy} onClick={onOpenNotes}>打开待整理</Button>
    </section>
  </>;
}

export function StandaloneResponsiveLayout({ page, view, busy, onContinue, onSaveDailyNewWordLimit, onOpenNotes = () => undefined, captureInboxCount = null, hasMainContent, children }: {
  page: StandalonePage;
  view: WebApiResponse | null;
  busy: boolean;
  onContinue: () => void;
  onSaveDailyNewWordLimit?: (limit: number) => Promise<DailyNewWordLimitSaveResult>;
  onOpenNotes?: () => void;
  captureInboxCount?: number | null;
  hasMainContent: boolean;
  children?: ReactNode;
}): React.JSX.Element {
  if (page === "study") return <div className="standalone-layout standalone-study-layout" data-page={page}>
    <section className="standalone-main" aria-label="沉浸式学习区">{children}</section>
  </div>;
  return <div
    className="standalone-layout"
    data-page={page}
    data-has-dashboard={view ? "true" : "false"}
    data-main-content={hasMainContent ? "true" : "false"}
  >
    <aside className="standalone-sidebar" aria-label="Dashboard" aria-hidden={!view}>
      {view && <StandaloneDashboard view={view} busy={busy} onContinue={onContinue} onSaveDailyNewWordLimit={onSaveDailyNewWordLimit} onOpenNotes={onOpenNotes} captureInboxCount={captureInboxCount} />}
    </aside>
    <section className="standalone-main" aria-label="学习区">
      {children}
      {page === "dashboard" && view && !hasMainContent && <section className="widget-card standalone-card standalone-desktop-prompt" aria-label="学习提示">
        <p>选择继续学习以恢复当前任务。</p>
      </section>}
    </section>
  </div>;
}

function StandaloneStudyBackButton({ onBack }: { onBack: () => void }): React.JSX.Element {
  return <button className="standalone-back" type="button" onClick={onBack}>← 返回</button>;
}

export function StandaloneReviewHeader({ currentIndex, total, complete, onBack }: {
  currentIndex: number;
  total: number;
  complete: boolean;
  onBack: () => void;
}): React.JSX.Element {
  return <header className="widget-header compact-header">
    <div className="standalone-study-heading"><StandaloneStudyBackButton onBack={onBack} /><div><span className="eyebrow">WordLoop</span><h1 id="study-title">复习</h1></div></div>
    <span className="standalone-count">{complete ? total : `${Math.min(currentIndex + 1, total)} / ${total}`}</span>
  </header>;
}

export function StandaloneLessonHeader({ title, progressLabel, onBack }: {
  title: string;
  progressLabel: string;
  onBack: () => void;
}): React.JSX.Element {
  return <header className="widget-header compact-header">
    <div className="standalone-study-heading"><StandaloneStudyBackButton onBack={onBack} /><div><span className="eyebrow">{progressLabel}</span><div className="lesson-word-heading"><strong id="study-title">{title}</strong></div></div></div>
  </header>;
}

export default function StandaloneApp(): React.JSX.Element {
  const [page, setPage] = useState<StandalonePage>(() => sectionFromHash() === "capture" ? "notes" : "dashboard");
  const [appSection, setAppSection] = useState<AppSection>(() => sectionFromHash() ?? "today");
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedVocabularyWordId, setSelectedVocabularyWordId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(initialToken);
  const [tokenInput, setTokenInput] = useState("");
  const [view, setView] = useState<WebApiResponse | null>(null);
  const [pageStatus, setPageStatus] = useState<PageStatus>(token ? "loading" : "auth");
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeIndex, setNoticeIndex] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [retryFields, setRetryFields] = useState<RetryFields>(null);
  const [captureCounts, setCaptureCounts] = useState<CaptureListResponse["counts"] | null>(null);
  const requestInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const refreshProgressPendingRef = useRef(false);
  const tokenRef = useRef(token);
  const sessionRevisionRef = useRef<string | null>(view?.session_revision ?? null);
  const loadBootstrapRef = useRef<() => Promise<void>>(async () => undefined);
  const loadDashboardProgressRef = useRef<() => Promise<void>>(async () => undefined);
  tokenRef.current = token;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = appearance;
    try { localStorage.setItem("wordloop_appearance", appearance); } catch { /* storage is optional */ }
  }, [appearance]);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--visual-viewport-height");
    if (page !== "study") return () => undefined;
    const viewport = window.visualViewport;
    const updateViewportHeight = () => {
      root.style.setProperty("--visual-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    };
    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    viewport?.addEventListener("resize", updateViewportHeight);
    viewport?.addEventListener("scroll", updateViewportHeight);
    return () => {
      window.removeEventListener("resize", updateViewportHeight);
      viewport?.removeEventListener("resize", updateViewportHeight);
      viewport?.removeEventListener("scroll", updateViewportHeight);
      if (previous) root.style.setProperty("--visual-viewport-height", previous);
      else root.style.removeProperty("--visual-viewport-height");
    };
  }, [page]);

  useEffect(() => {
    const restoreSection = () => {
      const section = sectionFromHash();
      if (!section) return;
      setAppSection(section);
      setPage(section === "study" && view?.screen !== "done" ? "study" : section === "capture" ? "notes" : "dashboard");
      setSelectedVocabularyWordId(null);
    };
    window.addEventListener("popstate", restoreSection);
    return () => window.removeEventListener("popstate", restoreSection);
  }, [view?.screen]);

  const navigateSection = useCallback((section: AppSection) => {
    if (section === "study") {
      setAppSection("study");
      if (view) continueFromDashboard();
      else { setAppSection("today"); setPage("dashboard"); }
      return;
    }
    setAppSection(section);
    setPage(section === "capture" ? "notes" : "dashboard");
    if (section !== "vocabulary") setSelectedVocabularyWordId(null);
    if (typeof window !== "undefined") window.history.pushState({ wordloopSection: section }, "", `#${section}`);
  }, [view]);

  const flushPendingRefresh = useCallback(() => {
    const needsBootstrap = refreshPendingRef.current;
    const needsProgress = refreshProgressPendingRef.current;
    if (!needsBootstrap && !needsProgress) return;
    refreshPendingRef.current = false;
    refreshProgressPendingRef.current = false;
    queueMicrotask(() => {
      if (!tokenRef.current) return;
      if (needsBootstrap) {
        if (needsProgress) refreshProgressPendingRef.current = true;
        void loadBootstrapRef.current();
      } else if (needsProgress) void loadDashboardProgressRef.current();
    });
  }, []);

  const enterAuth = useCallback((wrongToken = false) => {
    clearToken();
    tokenRef.current = null;
    sessionRevisionRef.current = null;
    setToken(null);
    setView(null);
    setBusy(null);
    setRetryFields(null);
    setPage("dashboard");
    setAppSection("today");
    setPageStatus("auth");
    setAuthError(wrongToken ? "访问密钥错误" : "");
  }, []);

  const loadDashboardProgress = useCallback(async () => {
    const run = await runForegroundRequest(requestInFlightRef, async () => {
      setBusy("refresh_progress");
      try {
        const progressView = await postAction({ action: "refresh_progress", expected_revision: sessionRevisionRef.current });
        sessionRevisionRef.current = progressView.session_revision ?? sessionRevisionRef.current;
        if (progressView.progress) {
          setView((current) => current?.progress ? current : progressView);
        }
      } catch {
        // Keep the safe generation error and retry action visible if progress is unavailable.
      } finally {
        setBusy(null);
      }
    }, flushPendingRefresh);
    if (!run.started) refreshProgressPendingRef.current = true;
  }, [flushPendingRefresh]);

  const loadBootstrap = useCallback(async (preserveError = false, overrideToken?: string, retryStale = true) => {
    const run = await runForegroundRequest(requestInFlightRef, async () => {
      const activeToken = overrideToken ?? tokenRef.current;
      if (!activeToken) {
        setPageStatus("auth");
        return;
      }
      setBusy("bootstrap");
      setPageStatus((current) => current === "auth" ? "auth" : "loading");
      if (!preserveError) setErrorMessage("");
      try {
        const next = await getBootstrap(overrideToken ?? activeToken);
        sessionRevisionRef.current = next.session_revision ?? null;
        setView(next);
        if (appSection === "study" && next.screen !== "done") setPage("study");
        setPageStatus("ready");
        setNotice("");
        setNoticeIndex(null);
        if (!preserveError) {
          setRetryFields(null);
          setErrorMessage("");
        }
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          enterAuth(true);
        } else if (error instanceof StaleStudyStateError) {
          sessionRevisionRef.current = null;
          setView(null);
          setPageStatus("loading");
          if (retryStale) setTimeout(() => void loadBootstrap(preserveError, overrideToken, false), 0);
          else {
            setPageStatus("ready");
            setErrorMessage("学习状态正在其他客户端更新，请重试。");
          }
        } else {
          setPageStatus("ready");
          if (error instanceof ApiError && error.code.startsWith("DEEPSEEK_")) {
            setPage("dashboard");
            setErrorMessage(deepSeekMessage(error.code, "generation"));
            setRetryFields(null);
            if (!view?.progress) await loadDashboardProgress();
          } else {
            setErrorMessage(messageFor(error, "generation"));
            setRetryFields(null);
          }
        }
      } finally {
        setBusy(null);
      }
    }, flushPendingRefresh);
    if (!run.started) refreshPendingRef.current = true;
  }, [appSection, enterAuth, flushPendingRefresh, loadDashboardProgress, view?.progress]);

  loadBootstrapRef.current = () => loadBootstrap(false, tokenRef.current ?? undefined);
  loadDashboardProgressRef.current = loadDashboardProgress;

  const refreshCaptureCounts = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const response = await getCaptureNotes("inbox", 1);
      setCaptureCounts(response.counts);
    } catch {
      // Capture notes are optional to the study flow; do not block learning if this side panel fails.
    }
  }, []);

  useEffect(() => {
    if (token) void refreshCaptureCounts();
  }, [token, refreshCaptureCounts]);

  useEffect(() => {
    if (token) void loadBootstrap();
  }, []);

  useEffect(() => {
    if (view?.screen === "done") setPage((currentPage) => {
      if (currentPage !== "study") return currentPage;
      setAppSection("today");
      return "dashboard";
    });
  }, [view?.screen]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible" || !token) return;
      if (!deferVisibilityBootstrap(requestInFlightRef, refreshPendingRef)) void loadBootstrap();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [loadBootstrap, token]);

  useEffect(() => {
    const state = view?.state;
    if (!state) return;
    const payload = record(state.payload);
    const draftContext = lessonDraftContext(state);
    if (draftContext) {
      try {
        const stored = sessionStorage.getItem("wordloop_draft");
        const draftAnswer = lessonDraftAnswerForState(stored, draftContext.word, draftContext.phase, draftContext.prompt);
        if (draftAnswer !== null) {
          setAnswer(draftAnswer);
          return;
        }
        sessionStorage.removeItem("wordloop_draft");
      } catch {
        // A malformed local draft is discarded; the server state remains authoritative.
      }
    } else {
      try { sessionStorage.removeItem("wordloop_draft"); } catch { /* storage is optional */ }
    }
    if (payload.mode !== "exercise") setAnswer("");
  }, [view?.session_revision, view?.state.current_word, view?.state.phase, view?.state.payload]);

  const saveAnswer = (value: string) => {
    setAnswer(value);
    const state = view?.state;
    const draftContext = lessonDraftContext(state);
    if (!draftContext) return;
    try { sessionStorage.setItem("wordloop_draft", JSON.stringify({ ...draftContext, answer: value })); } catch { /* storage is optional */ }
  };

  const submitToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = tokenInput.trim();
    if (!candidate) return;
    if (requestInFlightRef.current) return;
    await runForegroundRequest(requestInFlightRef, async () => {
      setBusy("auth");
      setAuthError("");
      try {
        const next = await getBootstrap(candidate);
        saveToken(candidate);
        tokenRef.current = candidate;
        sessionRevisionRef.current = next.session_revision ?? null;
        setToken(candidate);
        setView(next);
        setPage("dashboard");
        setAppSection("today");
        setPageStatus("ready");
        setTokenInput("");
        setErrorMessage("");
      } catch (error) {
        if (error instanceof UnauthorizedError) setAuthError("访问密钥错误");
        else if (error instanceof ApiError && error.code.startsWith("DEEPSEEK_")) {
          saveToken(candidate);
          tokenRef.current = candidate;
          setToken(candidate);
          setPage("dashboard");
          setPageStatus("ready");
          setTokenInput("");
          setErrorMessage(deepSeekMessage(error.code, "generation"));
          setRetryFields(null);
          await loadDashboardProgress();
        } else setAuthError(messageFor(error, "generation"));
      } finally {
        setBusy(null);
      }
    }, flushPendingRefresh);
  };

  const dispatch = async (fields: Record<string, unknown>): Promise<WebApiResponse | null> => {
    const actionName = String(fields.action ?? "");
    const answerActions = new Set(["review_submit", "pretest_submit", "lesson_submit", "consolidation_submit", "wrapup_submit"]);
    if (answerActions.has(actionName) && fields.mark_unknown !== true
      && (typeof fields.answer !== "string" || !fields.answer.trim())) return null;
    if (requestInFlightRef.current) return null;
    const stableFields = ["lesson_submit", "consolidation_submit", "wrapup_submit"].includes(actionName)
      ? { ...fields, submission_id: typeof fields.submission_id === "string" ? fields.submission_id : crypto.randomUUID() }
      : fields;
    const revision = view?.session_revision ?? null;
    const action = { ...stableFields, expected_revision: revision } as WebAction;
    const submittedIndex = typeof view?.state.current_index === "number" ? view.state.current_index : null;
    const previousDraftContext = lessonDraftContext(view?.state);
    let actionResponse: WebApiResponse | null = null;
    await runForegroundRequest(requestInFlightRef, async () => {
      setBusy(actionName || "action");
      setErrorMessage("");
      setNotice("");
      setNoticeIndex(null);
      setRetryFields(stableFields);
      try {
        const next = await postAction(action);
        actionResponse = next;
        sessionRevisionRef.current = next.session_revision ?? sessionRevisionRef.current;
        if (actionName === "refresh_progress") {
          setView((previous) => previous ? { ...previous, progress: next.progress } : next);
    } else {
      setView(next);
      if (actionName === "continue") setPage(next.screen === "done" ? "dashboard" : "study");
      if (actionName === "consolidation_start") { setAppSection("study"); setPage("study"); }
      if (actionName === "consolidation_defer") { setAppSection("today"); setPage("dashboard"); }
          setRetryFields(null);
          const nextDraftContext = lessonDraftContext(next.state);
          if (lessonDraftTransitioned(previousDraftContext, nextDraftContext)) {
            try { sessionStorage.removeItem("wordloop_draft"); } catch { /* storage is optional */ }
            setAnswer("");
          } else if (["review_submit", "pretest_submit", "pretest_continue", "pretest_mark_familiar"].includes(actionName)) {
            setAnswer("");
          }
          if (actionName === "review_submit") {
            const nextIndex = typeof next.state.current_index === "number" ? next.state.current_index : null;
            if (submittedIndex !== null && nextIndex === submittedIndex && next.result?.message) {
              setNotice(next.result.message);
              setNoticeIndex(submittedIndex);
            }
          } else if (next.result?.message) setNotice(next.result.message);
        }
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          enterAuth(true);
        } else if (error instanceof StaleStudyStateError) {
          sessionRevisionRef.current = null;
          setView(null);
          setNotice("");
          setRetryFields(null);
          await loadBootstrap();
        } else {
          if (error instanceof ApiError && error.code.startsWith("DEEPSEEK_")) {
            const generationAction = actionName === "continue" || actionName === "lesson_next";
            if (generationAction) {
              setPage("dashboard");
              setErrorMessage(deepSeekMessage(error.code, "generation"));
              if (!view?.progress) await loadDashboardProgress();
            } else {
              setErrorMessage(deepSeekMessage(error.code, "grading"));
            }
          } else {
            setErrorMessage(messageFor(error, actionName === "continue" || actionName === "lesson_next" ? "generation" : "grading"));
          }
        }
      } finally {
        setBusy(null);
      }
    }, flushPendingRefresh);
    return actionResponse;
  };

  const saveDailyNewWordLimit = async (limit: number): Promise<DailyNewWordLimitSaveResult> => {
    const response = await dispatch({ action: "set_daily_new_word_limit", limit });
    if (!response?.settings_update) throw new Error("每日目标未能保存，请重试。");
    return response.settings_update;
  };

  const retry = () => {
    if (retryFields) void dispatch(retryFields);
    else void loadBootstrap();
  };

  const continueFromDashboard = () => {
    if (!view) return;
    setAppSection("study");
    if (typeof window !== "undefined") window.history.pushState({ wordloopSection: "study" }, "", "#study");
    if (dashboardContinueBehavior(view) === "study") {
      setPage("study");
      return;
    }
    void dispatch({ action: "continue" });
  };

  const backToToday = () => {
    setPage("dashboard");
    setAppSection("today");
    if (typeof window !== "undefined") window.history.pushState({ wordloopSection: "today" }, "", "#today");
  };

  const openVocabularyWord = (userWordId: string) => {
    setSelectedVocabularyWordId(userWordId);
  };

  const saveAppearance = (value: Appearance) => setAppearance(value);

  const state = view?.state ?? {};
  const payload = record(state.payload);
  const visiblePage = visibleStandalonePage(page, view?.screen ?? null);
  const currentIndex = typeof state.current_index === "number" ? state.current_index : 0;
  const busyLabel = busy === "lesson_next"
    ? payload.navigation && record(payload.navigation).action === "round_complete" ? "正在检查本轮任务…" : "正在生成下一词…"
    : busy === "lesson_submit" || busy === "consolidation_submit" || busy === "wrapup_submit" ? "正在批改…"
      : busy === "bootstrap" ? "正在加载今日学习…"
        : busy === "pretest_submit" || busy === "review_submit" ? "正在保存…"
          : null;

  if (pageStatus === "auth" || !token) {
    return <main className="standalone-shell">
      <div className="standalone-brand"><span className="standalone-mark">W</span>WordLoop</div>
      <section className="widget-card standalone-card" aria-labelledby="auth-title">
        <header className="widget-header">
          <span className="eyebrow">WordLoop</span>
          <h1 id="auth-title">访问密钥</h1>
          <p>输入个人访问密钥以继续今日学习。</p>
        </header>
        <form onSubmit={(event) => void submitToken(event)}>
          <label className="answer-label" htmlFor="web-token">访问密钥</label>
          <input id="web-token" className="answer-input standalone-input" type="password" autoComplete="current-password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} />
          {authError && <p className="standalone-status error" role="alert">{authError}</p>}
          <div className="standalone-actions"><Button type="submit" disabled={busy === "auth" || !tokenInput.trim()}>{busy === "auth" ? "正在验证…" : "进入"}</Button></div>
        </form>
      </section>
    </main>;
  }

  const hasMainContent = true;
  const captureSelectionEnabled = pageStatus === "ready" && visiblePage === "study"
    && view?.screen === "lesson"
    && (["lesson_explain", "lesson_feedback"].includes(String(state.phase))
      || (state.phase === "lesson_complete" && record(state.payload).mode === "feedback"));

  return <main className="standalone-shell wordloop-shell" data-study-open={visiblePage === "study" ? "true" : "false"}>
    <div className={`wordloop-app-grid${visiblePage === "study" ? " is-immersive" : ""}`} data-section={appSection}>
    {visiblePage !== "study" && <AppNavigation section={appSection} onNavigate={navigateSection} />}
    <StandaloneResponsiveLayout
      page={visiblePage}
      view={null}
      busy={busy !== null}
      onContinue={continueFromDashboard}
      onSaveDailyNewWordLimit={saveDailyNewWordLimit}
      onOpenNotes={() => navigateSection("capture")}
      captureInboxCount={captureCounts?.inbox ?? null}
      hasMainContent={hasMainContent}
    >

    {visiblePage !== "study" && <header className="wordloop-topbar">
      <div className="standalone-brand"><span className="standalone-mark">W</span>WordLoop</div>
      <button type="button" className="settings-open-button" aria-haspopup="dialog" aria-label="设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
    </header>}

    {visiblePage === "dashboard" && appSection === "today" && <TodayPage
      view={view}
      busy={busy !== null}
      tokenKey={token}
      onContinue={continueFromDashboard}
      onStartConsolidation={() => { setAppSection("study"); setPage("study"); void dispatch({ action: "consolidation_start" }); }}
      onOpenCapture={() => navigateSection("capture")}
      onOpenVocabulary={() => navigateSection("vocabulary")}
    />}

    {appSection === "capture" && visiblePage === "notes" && <CaptureNotesPage
      onBack={backToToday}
      onCountsChange={setCaptureCounts}
    />}

    {appSection === "insights" && visiblePage === "dashboard" && <InsightsPage tokenKey={token} onOpenWord={openVocabularyWord} />}

    {appSection === "vocabulary" && visiblePage === "dashboard" && <VocabularyPage
      tokenKey={token}
      initialUserWordId={selectedVocabularyWordId}
      onDetailChange={setSelectedVocabularyWordId}
    />}

    {errorMessage && <section className="widget-card standalone-card" role="alert">
      <p className="standalone-status error">{errorMessage}</p>
      <div className="standalone-actions"><Button type="button" disabled={busy !== null} onClick={retry}>重试</Button></div>
    </section>}

    {pageStatus === "loading" && <section className="widget-card standalone-card"><div className="widget-header"><h1>WordLoop</h1><p>{busyLabel ?? "正在加载今日学习…"}</p></div></section>}

    {pageStatus === "ready" && !view && !errorMessage && <section className="widget-card standalone-card"><div className="widget-header"><h1>WordLoop</h1><p>正在加载今日学习…</p></div></section>}

    {visiblePage === "study" && view?.screen === "review" && (() => {
      const items = list(payload.items);
      const item = items[currentIndex] ?? {};
      const complete = state.phase === "review_complete";
      const direction = item.direction === "en_definition" ? "en_definition" : "cn_to_en";
      return <section className="widget-card standalone-card" aria-labelledby="study-title">
        <StandaloneReviewHeader currentIndex={currentIndex} total={items.length} complete={complete} onBack={backToToday} />
        {complete ? <div className="standalone-content"><p>本轮复习完成。</p><div className="standalone-actions"><Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "continue" })}>继续学习</Button></div></div> : <div className="standalone-content">
          <StandaloneReviewQuestion item={item} direction={direction} />
          <label className="answer-label" htmlFor="study-answer">{direction === "cn_to_en" ? "写出英文单词" : "英文释义"}</label>
          <input id="study-answer" className="answer-input standalone-input" value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (shouldSubmitSingleLine({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); if (!answer.trim() || busy !== null) return; void dispatch({ action: "review_submit", answer }); } }} />
          <StandaloneReviewFeedback notice={notice} noticeIndex={noticeIndex} currentIndex={currentIndex} />
          <div className="standalone-actions standalone-two-actions">
            <Button className="secondary" type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "review_submit", answer: "", mark_unknown: true })}>不会</Button>
            <Button type="button" disabled={busy !== null || !answer.trim()} onClick={() => void dispatch({ action: "review_submit", answer })}>提交</Button>
          </div>
        </div>}
        {busyLabel && <p className="standalone-status" role="status">{busyLabel}</p>}
      </section>;
    })()}

    {visiblePage === "study" && view?.screen === "pretest" && (() => {
      const items = list(payload.items);
      const item = items[currentIndex] ?? {};
      const complete = state.phase === "pretest_complete";
      const summary = view.pretest_summary ?? { known: 0, uncertain: 0, unknown: 0 };
      const resultStage = state.phase === "pretest_result";
      const result = { ...record(view.pretest_result), ...record(view.result) };
      const audioStage = ["listen_repeat", "listen_recall"].includes(String(state.phase));
      return <section className="widget-card standalone-card" aria-labelledby="study-title">
        <header className="widget-header compact-header"><div className="standalone-study-heading"><StandaloneStudyBackButton onBack={backToToday} /><div><span className="eyebrow">WordLoop</span><h1 id="study-title">预测试</h1></div></div><span className="standalone-count">{complete ? items.length : `${Math.min(currentIndex + 1, items.length)} / ${items.length}`}</span></header>
        {complete ? <div className="standalone-content">
          <p>预测试完成</p>
          <div className="standalone-result-grid">
            <div><strong>{summary.known}</strong><span>已掌握</span></div>
            <div><strong>{summary.uncertain}</strong><span>不确定</span></div>
            <div><strong>{summary.unknown}</strong><span>不会</span></div>
          </div>
          <div className="standalone-actions"><Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "continue" })}>开始正式学习</Button></div>
        </div> : resultStage ? <div className="standalone-content">
          <StandalonePretestAnswerReveal
            source={String(payload.source ?? "")}
            word={String(item.word ?? state.current_word ?? "")}
            answer={String(result.user_answer ?? "")}
            status={String(result.status ?? "")}
            errorLayer={String(result.error_layer ?? "")}
            markedFamiliar={result.mark_familiar === true}
            busy={busy !== null}
            onContinue={() => void dispatch({ action: "pretest_continue", current_index: currentIndex })}
            onMarkFamiliar={() => void dispatch({ action: "pretest_mark_familiar", word: String(item.word ?? state.current_word ?? ""), current_index: currentIndex })}
          />
        </div> : audioStage ? <div className="standalone-content"><p>当前预测试正在 ChatGPT 听音阶段，请在 ChatGPT 完成此阶段。</p></div> : <div className="standalone-content">
          <div className="question-block">
            <span className="question-label">中文核心义</span>
            <p className="question-prompt">{String(item.meaning_zh ?? "")}</p>
            {typeof item.part_of_speech === "string" && <p className="answer-hint">{item.part_of_speech}</p>}
          </div>
          <label className="answer-label" htmlFor="study-answer">写出英文单词</label>
          <input id="study-answer" className="answer-input standalone-input" value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (shouldSubmitSingleLine({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); if (!answer.trim() || busy !== null) return; void dispatch({ action: "pretest_submit", answer }); } }} />
          {notice && <p className="standalone-status" role="status">{notice}</p>}
          <div className="standalone-actions standalone-two-actions">
            <Button className="secondary" type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "pretest_submit", answer: "", mark_unknown: true })}>不会</Button>
            <Button type="button" disabled={busy !== null || !answer.trim()} onClick={() => void dispatch({ action: "pretest_submit", answer })}>提交</Button>
          </div>
        </div>}
        {busyLabel && <p className="standalone-status" role="status">{busyLabel}</p>}
      </section>;
    })()}

    {visiblePage === "study" && view?.screen === "lesson" && (() => {
      const flow = record(state.flow);
      const queue = wordsFrom(flow.lesson_words);
      const feedback = record(payload.feedback);
      const exercise = payload.mode === "exercise" ? payload : record(payload.exercise);
      const navigation = record(payload.navigation);
      const title = String(state.current_word ?? payload.word ?? "Lesson");
      const consolidationKind = payload.consolidation === true
        ? payload.consolidation_kind === "sentence" ? "sentence" : "translation"
        : null;
      const feedbackMode = payload.mode === "feedback";
      const exerciseMode = payload.mode === "exercise";
      const phase = String(state.phase ?? "");
      const displayTitle = standaloneLessonDisplayTitle(title, exerciseMode, consolidationKind);
      const progressLabel = String(payload.progress ?? standaloneLessonProgressLabel(wordsFrom(flow.relearn_words), queue, currentIndex, consolidationKind));
      return <section className="widget-card standalone-card lesson-card" aria-labelledby="study-title">
        <StandaloneLessonHeader title={displayTitle} progressLabel={progressLabel} onBack={backToToday} />

        {phase === "lesson_explain" && payload.mode === "explain" && <div className="standalone-content" data-capture-root="true">
          <div className="lesson-ipa">{String(payload.ipa ?? "")}{view.pronunciation_audio_url ? <button className="play-button lesson-audio" type="button" aria-label="播放发音" onClick={() => { const audio = new Audio(view.pronunciation_audio_url!); void audio.play().catch(() => speak(title)); }}>▶</button> : <button className="play-button lesson-audio" type="button" aria-label="朗读单词" onClick={() => speak(title)}>▶</button>}</div>
          <section className="lesson-section"><h2>词性与核心义</h2><p>{String(payload.part_of_speech ?? "")} · {String(payload.meaning_zh ?? "")}</p></section>
          <section className="lesson-section" data-capture-context="true"><h2>例句</h2><p className="lesson-example standalone-reading-width">{String(payload.example_en ?? "")}</p>{typeof payload.example_zh === "string" && payload.example_zh && <details className="lesson-translation"><summary>展开译文</summary><p className="lesson-example-translation standalone-reading-width">{payload.example_zh}</p></details>}</section>
          <div className="lesson-detail-grid">
          <section className="lesson-section"><h2>高价值搭配</h2><ul>{wordsFrom(payload.collocations).slice(0, 3).map((value) => <li key={value}>{value}</li>)}</ul></section>
            <section className="lesson-section"><h2>常见派生</h2><ul>{wordsFrom(payload.derivations).map((value) => <li key={value}>{value}</li>)}</ul></section>
          </div>
          <section className="lesson-section"><h2>易混提醒</h2><p className="standalone-reading-width">{String(payload.note ?? "")}</p></section>
          <div className="standalone-actions"><Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "lesson_start_exercise" })}>开始练习</Button></div>
        </div>}

        {phase === "lesson_exercise" && exerciseMode && <div className="standalone-content">
          <p className="lesson-exercise-heading">{String(exercise.instruction ?? "")}</p>
          <div className="lesson-prompt standalone-reading-width" data-capture-text="true" data-capture-source="lesson_prompt" data-capture-type="phrase">{String(exercise.prompt ?? "")}</div>
          {exercise.multiline === true
            ? <textarea className="standalone-input" aria-label="你的答案" value={answer} onChange={(event) => saveAnswer(event.target.value)} onKeyDown={(event) => { if (shouldSubmitMultiline({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); if (!answer.trim() || busy !== null) return; void dispatch({ action: "lesson_submit", answer }); } }} />
            : <input className="answer-input standalone-input" aria-label="你的答案" value={answer} onChange={(event) => saveAnswer(event.target.value)} onKeyDown={(event) => { if (shouldSubmitSingleLine({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); if (!answer.trim() || busy !== null) return; void dispatch({ action: "lesson_submit", answer }); } }} />}
          <div className="standalone-actions"><Button type="button" disabled={busy !== null || !answer.trim()} onClick={() => void dispatch({ action: "lesson_submit", answer })}>提交</Button></div>
        </div>}

        {phase === "lesson_feedback" && feedbackMode && <div className="standalone-content">
          <div className="standalone-feedback standalone-reading-width" data-capture-root="true"><p><strong>{feedback.is_correct === true ? "正确" : "需要修改"}</strong></p><p>你的答案：{String(feedback.user_answer ?? "")}</p>{typeof feedback.error_layer === "string" && <p>错误层：{feedback.error_layer}</p>}<p>{String(feedback.message ?? "")}</p><p>{String(feedback.explanation ?? "")}</p>{feedback.reveal_answer === true && typeof feedback.reference_answer === "string" && <p>参考答案：{feedback.reference_answer}</p>}</div>
          {notice && <p className="standalone-status" role="status">{notice}</p>}
          <div className="standalone-actions">
            {feedback.is_correct !== true && feedback.reveal_answer !== true
              ? <Button className="secondary" type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "lesson_retry" })}>重做当前题</Button>
              : navigation.action === "next_word"
                ? <Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "lesson_next" })}>下一词</Button>
                : <Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "lesson_next" })}>完成本轮并继续</Button>}
          </div>
        </div>}

        {phase === "lesson_complete" && exerciseMode && consolidationKind && <div className="standalone-content">
          <p className="lesson-exercise-heading">{String(exercise.instruction ?? "")}</p>
          <div className="lesson-prompt standalone-reading-width">{String(exercise.prompt ?? "")}</div>
          <textarea className={`standalone-input consolidation-input ${consolidationKind === "sentence" ? "sentence-consolidation-input" : ""}`} rows={consolidationKind === "sentence" ? 2 : 5} aria-label={consolidationKind === "translation" ? "长难句翻译与结构分析" : "造句练习答案"} value={answer} onChange={(event) => saveAnswer(event.target.value)} onKeyDown={(event) => { if (shouldSubmitMultiline({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing })) { event.preventDefault(); if (!answer.trim() || busy !== null) return; void dispatch({ action: "consolidation_submit", answer }); } }} />
          <div className="standalone-actions"><Button type="button" disabled={busy !== null || !answer.trim()} onClick={() => void dispatch({ action: "consolidation_submit", answer })}>{consolidationKind === "translation" ? "提交翻译" : "提交句子"}</Button></div>
        </div>}

        {phase === "lesson_complete" && feedbackMode && consolidationKind && <div className="standalone-content">
          <div className="standalone-feedback standalone-reading-width" data-capture-root="true"><p><strong>{feedback.is_correct === true ? "正确" : "需要修改"}</strong></p><p>你的答案：{String(feedback.user_answer ?? "")}</p>{typeof feedback.error_layer === "string" && <p>错误层：{feedback.error_layer}</p>}<p>{String(feedback.message ?? "")}</p><p>{String(feedback.explanation ?? "")}</p>{feedback.reveal_answer === true && typeof feedback.reference_answer === "string" && <p>参考答案：{feedback.reference_answer}</p>}</div>
          <div className="standalone-actions">
            {feedback.is_correct === true || feedback.reveal_answer === true
              ? <Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "consolidation_finish" })}>继续学习</Button>
              : <Button className="secondary" type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "consolidation_retry" })}>修改一次</Button>}
          </div>
        </div>}

        {phase === "lesson_complete" && payload.consolidation === true && payload.consolidation_status === "pending" && <div className="standalone-content">
          <p>本轮词汇已完成。应用巩固待做：{String(record(payload.consolidation_plan).planned_activity_type === "translation_en_to_cn" ? "长难句英译中" : record(payload.consolidation_plan).planned_activity_type === "translation_cn_to_en" ? "完整中译英" : record(payload.consolidation_plan).planned_activity_type === "sentence" ? "情境造句" : "应用任务")}。</p>
          <div className="standalone-actions standalone-two-actions">
            <Button className="secondary" type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "consolidation_defer" })}>稍后做</Button>
            <Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "consolidation_start" })}>做一道，约 2 分钟</Button>
          </div>
        </div>}

        {phase === "lesson_complete" && feedbackMode && !consolidationKind && <div className="standalone-content">
          <p>本轮 Lesson 已完成，可以继续当天的学习流程。</p>
          <div className="standalone-actions"><Button type="button" disabled={busy !== null} onClick={() => void dispatch({ action: "lesson_next" })}>完成本轮并继续</Button></div>
        </div>}

        {busyLabel && <p className="standalone-status" role="status">{busyLabel}</p>}
      </section>;
    })()}

    {pageStatus === "loading" && view && <p className="standalone-status" role="status">{busyLabel ?? "正在同步学习状态…"}</p>}
    </StandaloneResponsiveLayout>
    </div>
    <SettingsSheet
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      appearance={appearance}
      onAppearanceChange={saveAppearance}
      dailyLimit={numberValue(record(record(view?.progress).settings).daily_new_word_limit) || null}
      busy={busy !== null}
      onSaveDailyNewWordLimit={saveDailyNewWordLimit}
    />
    {selectedVocabularyWordId && appSection !== "vocabulary" && <WordDetailPanel
      userWordId={selectedVocabularyWordId}
      tokenKey={token}
      onClose={() => setSelectedVocabularyWordId(null)}
    />}
    <SelectionCapture
      enabled={captureSelectionEnabled}
      sourceType={visiblePage === "study"
        ? view?.screen === "lesson" ? "lesson" : view?.screen === "review" ? "review" : view?.screen === "pretest" ? "pretest" : "manual"
        : "lesson"}
      sourceRef={visiblePage === "study" ? `${view?.screen ?? "study"}:${String(state.current_word ?? currentIndex)}` : null}
      onCaptured={() => void refreshCaptureCounts()}
    />
  </main>;
}

function speak(word: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  window.speechSynthesis.speak(utterance);
}
