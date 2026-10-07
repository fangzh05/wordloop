import { useEffect, useRef, useState } from "react";
import { ArrowIcon, PlayIcon } from "../components/Icons.js";
import { Button } from "../components/Button.js";
import { FocusButton } from "../components/FocusButton.js";
import { callServerTool, sendUserMessage, subscribeToApp, toolResultData } from "../mcpBridge.js";
import { loadDictionaryPronunciationAudio, playPronunciation, pronunciationButtonLabel, selectEnglishVoice } from "../pronunciation/audio.js";
import { z } from "zod";
import {
  LESSON_WIDGET_VERSION,
  advanceStudySessionSchema,
  lessonNavigationSchema,
  lessonSubmissionSchema,
  type AdvanceStudySessionInput,
} from "../../../shared/toolContracts.js";
import { meaningIncludesPartOfSpeech } from "../../../shared/lexicalDisplay.js";
import { LessonClozeHint, lessonPromptWithMeaning } from "./LessonClozeHint.js";

export { LESSON_WIDGET_VERSION } from "../../../shared/toolContracts.js";

export const LESSON_WIDGET_LOAD_ERROR = "WordLoop 学习卡数据不完整，请重新进入学习。";
export const LESSON_WIDGET_REFRESH_ERROR = "WordLoop 未能刷新学习卡，请重试。";
export const LESSON_MOUNT_RECOVERY_DELAY_MS = 600;
export const LESSON_VISIBILITY_RECOVERY_DELAY_MS = 300;

type LessonRecoveryTimerRef = { current: ReturnType<typeof setTimeout> | null };

export function shouldScheduleLessonRecovery(hasPayload: boolean, isPreview: boolean, inFlight: boolean): boolean {
  return !hasPayload && !isPreview && !inFlight;
}

export function scheduleLessonRecovery(
  timerRef: LessonRecoveryTimerRef,
  delayMs: number,
  canRecover: () => boolean,
  recover: () => Promise<void>,
): void {
  if (!canRecover()) return;
  if (timerRef.current !== null) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    if (canRecover()) void recover();
  }, delayMs);
}

export function attachLessonRecoveryLifecycle(
  documentTarget: Document,
  windowTarget: Window,
  scheduleRecovery: (delayMs: number) => void,
): () => void {
  const onVisibilityChange = (): void => {
    if (documentTarget.visibilityState === "visible") scheduleRecovery(LESSON_VISIBILITY_RECOVERY_DELAY_MS);
  };
  const onPageShow = (): void => scheduleRecovery(LESSON_VISIBILITY_RECOVERY_DELAY_MS);
  documentTarget.addEventListener("visibilitychange", onVisibilityChange);
  windowTarget.addEventListener("pageshow", onPageShow);
  return () => {
    documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
    windowTarget.removeEventListener("pageshow", onPageShow);
  };
}

const exerciseSchema = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
}).strict();

const feedbackSchema = z.object({
  is_correct: z.boolean(),
  user_answer: z.string().max(4000),
  error_layer: z.string().trim().max(80).optional(),
  message: z.string().trim().max(1000).optional(),
  reference_answer: z.string().trim().max(4000).optional(),
  explanation: z.string().trim().max(4000).optional(),
  reveal_answer: z.boolean(),
}).strict();

const payloadCommon = {
  widget: z.literal("lesson"),
  title: z.string().trim().max(120).optional(),
  phase: z.enum(["lesson_explain", "lesson_exercise", "lesson_feedback", "lesson_complete"]).optional(),
  current_index: z.number().int().min(0).optional(),
  word: z.string().trim().min(1).max(100),
  widget_version: z.literal(LESSON_WIDGET_VERSION).optional(),
  // Old persisted payloads may omit this once; the server fills it on resume.
  navigation: lessonNavigationSchema.optional(),
  consolidation: z.literal(true).optional(),
  consolidation_kind: z.enum(["translation", "translation_cn_to_en", "sentence"]).optional(),
  consolidation_trigger_round: z.number().int().positive().optional(),
  consolidation_target_words: z.array(z.string().trim().min(1).max(100)).max(3).optional(),
  consolidation_status: z.enum(["pending", "exercise", "feedback", "completed"]).optional(),
  plan: z.object({
    plan_version: z.literal(1),
    plan_id: z.string().uuid(),
    exercise_id: z.string().uuid(),
    scope: z.enum(["lesson", "review", "consolidation"]),
    planned_activity_type: z.string().trim().min(1).max(80),
    skill_ids: z.array(z.string().trim().min(1).max(120)).max(8),
    skill_goal: z.string().trim().max(300).optional(),
    error_focus: z.string().trim().max(80).nullable().optional(),
    hint_level: z.enum(["none", "meaning", "context", "guided"]),
    estimated_seconds: z.number().int().min(10).max(300),
    selection_reason: z.string().trim().min(1).max(500).optional(),
    coverage_exception_reason: z.string().trim().max(500).optional(),
  }).strict().optional(),
};

const explainPayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("explain"),
  progress: z.string().trim().max(40).optional(),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(120),
  meaning_zh: z.string().trim().min(1).max(1000),
  collocations: z.array(z.string().trim().min(1).max(200)).max(8),
  derivations: z.array(z.string().trim().min(1).max(200)).max(8),
  example_en: z.string().trim().min(1).max(1000),
  example_zh: z.string().trim().min(1).max(1000).optional(),
  note: z.string().trim().min(1).max(1000),
  exercise: exerciseSchema,
}).passthrough();

const exercisePayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("exercise"),
  wrapup: z.literal(true).optional(),
  progress: z.string().trim().min(1).max(40),
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
}).passthrough();

const feedbackPayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("feedback"),
  wrapup: z.literal(true).optional(),
  progress: z.string().trim().min(1).max(40),
  exercise: exerciseSchema,
  feedback: feedbackSchema,
}).passthrough();

export const lessonPayloadSchema = z.discriminatedUnion("mode", [
  explainPayloadSchema,
  exercisePayloadSchema,
  feedbackPayloadSchema,
]);

export type LessonPayload = z.infer<typeof lessonPayloadSchema>;
type Payload = LessonPayload;
type Mode = "explain" | "exercise" | "feedback";
type SubmitStatus = "idle" | "sending" | "sent" | "error";
export type NextLessonStatus = "idle" | "sending" | "sent" | "error";

export function isLessonRenderCandidate(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === "explain" || mode === "exercise" || mode === "feedback";
}

type LessonAppEvent =
  | { type: "toolinput"; value: Record<string, unknown> }
  | { type: "toolresult"; value: { structuredContent?: unknown } };

export type LessonAppEventRoute =
  | { kind: "ignore" }
  | { kind: "invalid"; blocking: boolean; issues: z.ZodIssue[] }
  | { kind: "render"; payload: LessonPayload; signature: string; duplicate: boolean };

function normalizeLessonTransportPayload(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const navigation = candidate.navigation;
  if (typeof navigation !== "object" || navigation === null || Array.isArray(navigation)) return value;
  const navigationRecord = navigation as Record<string, unknown>;
  if (navigationRecord.action !== "round_complete") return value;

  // Some ChatGPT transports omit null-valued object fields. Restore the
  // explicit terminal values before validating against the strict contract.
  return {
    ...candidate,
    navigation: {
      ...navigationRecord,
      next_word: navigationRecord.next_word ?? null,
      next_index: navigationRecord.next_index ?? null,
    },
  };
}

export function routeLessonAppEvent(
  event: LessonAppEvent,
  hasLastGoodPayload: boolean,
  lastSignature = "",
): LessonAppEventRoute {
  if (event.type === "toolinput") return { kind: "ignore" };

  const candidate = event.value.structuredContent;
  if (!isLessonRenderCandidate(candidate) || (candidate as { widget?: unknown }).widget !== "lesson") {
    return { kind: "ignore" };
  }

  const parsed = lessonPayloadSchema.safeParse(normalizeLessonTransportPayload(candidate));
  if (!parsed.success) {
    return { kind: "invalid", blocking: !hasLastGoodPayload, issues: parsed.error.issues };
  }
  const signature = JSON.stringify(parsed.data);
  return { kind: "render", payload: parsed.data, signature, duplicate: signature === lastSignature };
}

type ExercisePayload = z.infer<typeof exerciseSchema>;
type FeedbackPayload = z.infer<typeof feedbackSchema>;

function exerciseFromPayload(payload: Payload): ExercisePayload {
  if (payload.mode === "exercise") {
    return {
      activity_type: payload.activity_type,
      instruction: payload.instruction,
      prompt: payload.prompt,
      multiline: payload.multiline,
    };
  }
  return payload.exercise;
}

function feedbackIsCorrect(feedback: FeedbackPayload | undefined): boolean {
  return feedback?.is_correct === true;
}

function feedbackRevealsAnswer(feedback: FeedbackPayload | undefined): boolean {
  return feedback?.reveal_answer === true;
}

/**
 * The first incorrect attempt should still teach the user how to self-correct.
 * `reference_answer` remains gated by `reveal`, while `explanation` is the
 * actionable hint that is safe to show before the full answer.
 */
export function feedbackGuidanceLabel(reveal: boolean): string {
  return reveal ? "解释" : "错因与改法";
}

export function lessonEyebrowLabel(progress?: string): string {
  if (progress?.startsWith("复习补学")) return "复习词";
  if (progress?.startsWith("新词学习")) return "新词";
  return "学习进度";
}

function modeForPhase(phase: Payload["phase"]): Mode | null {
  if (phase === "lesson_exercise") return "exercise";
  if (phase === "lesson_feedback") return "feedback";
  if (phase === "lesson_explain") return "explain";
  return null;
}

export function buildLessonSubmissionMessage(input: {
  word: string;
  activityType: string;
  prompt: string;
  answer: string;
  submissionId?: string;
  exerciseId?: string;
  planId?: string;
  hintUsed?: boolean;
}): string {
  const submission = lessonSubmissionSchema.parse({
    word: input.word,
    activity_type: input.activityType,
    prompt: input.prompt,
    answer: input.answer,
    ...(input.submissionId ? { submission_id: input.submissionId } : {}),
    ...(input.exerciseId ? { exercise_id: input.exerciseId } : {}),
    ...(input.planId ? { plan_id: input.planId } : {}),
    hint_used: input.hintUsed ?? false,
  });
  return `提交 WordLoop 正式学习答案。\n\n目标词：${submission.word}\n题型：${submission.activity_type}\n题目：${submission.prompt}\n用户答案：${submission.answer.trim()}\nsubmission_id：${submission.submission_id ?? "由服务端兼容生成"}\nexercise_id：${submission.exercise_id ?? "兼容旧题"}\nplan_id：${submission.plan_id ?? "兼容旧题"}\nscope：${submission.scope}\n用户主动查看提示：${submission.hint_used}\n\n程序计划已确定题型、目标、顺序与提示程度；不得替换问题或词。固定答案题由服务端确定性判分，accepted_answers 不可补充到工具参数或聊天文本；开放题按 Teaching Prompt 语义批改。技能按计划提供的 skill_ids 单独判断，skill_results 只包含确有证据的技能，不要把总体对错复制给所有技能；多词技能结果按 word_id 关联。\n\n核心正确只取决于目标词义、核心搭配和主要命题；无关的小冠词或标点可以通过并作为建议。第一次核心错误指出一个具体错误片段并给短提示，不泄漏完整答案；第二次仍错才给参考表达。\n\nThe current answer and submission_id are authoritative. Grade only this answer. Do not change or replace the current question, target word, or activity type. Call render_lesson_widget exactly once with mode=feedback and the same submission_id, exercise_id, and plan_id. Do not call record_attempt for this planned exercise: render_lesson_widget atomically records the attempt, skill evidence, cadence, and session transition. Do not output feedback in ordinary chat.`;
}

export function buildLessonConsolidationSubmissionMessage(input: {
  word: string;
  activityType: "translation_en_to_cn" | "translation_cn_to_en" | "sentence";
  kind: "translation" | "translation_cn_to_en" | "sentence";
  prompt: string;
  answer: string;
  submissionId?: string;
  exerciseId?: string;
  planId?: string;
  hintUsed?: boolean;
}): string {
  const submission = lessonSubmissionSchema.parse({
    word: input.word,
    activity_type: input.activityType,
    prompt: input.prompt,
    answer: input.answer,
    ...(input.submissionId ? { submission_id: input.submissionId } : {}),
    ...(input.exerciseId ? { exercise_id: input.exerciseId } : {}),
    ...(input.planId ? { plan_id: input.planId } : {}),
    scope: "consolidation",
    hint_used: input.hintUsed ?? false,
  });
  const translation = input.kind === "translation";
  const shortTranslation = input.kind === "translation_cn_to_en";
  return `提交 WordLoop 应用巩固答案。\n\n目标词（仅作服务端记录锚点）：${submission.word}\n练习类型：${submission.activity_type}\n巩固类型：${input.kind}\n题目：${submission.prompt}\n用户答案：${submission.answer.trim()}\nsubmission_id：${submission.submission_id ?? "由服务端兼容生成"}\nexercise_id：${submission.exercise_id ?? "兼容旧题"}\nplan_id：${submission.plan_id ?? "兼容旧题"}\nscope：${submission.scope}\n用户主动查看提示：${submission.hint_used}\n\n这是一个 one task / one answer / one feedback 的周期巩固。${translation ? "批改重点：句子主干、从句和修饰关系、逻辑关系、目标词义和中文自然度；接受自然且准确的不同译法。" : shortTranslation ? "只围绕题面指定的一个核心词义或搭配批改，接受不同正确句式与自然表达。" : "批改重点：目标词义、搭配、词性、句法位置和自然表达；接受合理句式，不要求学术风格。"} 技能逐项提供有证据的结果，不要把总体正确复制给全部技能。\n\n第一次答错时指出具体错误并给自纠方向，不给完整答案；允许修改同一道题一次。第二次仍错时给参考表达并解释。\n\nThe current answer and submission_id are authoritative. Grade only this answer. Call render_lesson_widget exactly once with mode=feedback, consolidation=true, and the same submission_id, exercise_id, and plan_id. Do not call record_attempt: the server commits the attempt, evidence, and session state in one transaction. Do not output feedback in ordinary chat.`;
}

export function buildLessonWrapupSubmissionMessage(input: { word: string; prompt: string; answer: string }): string {
  return buildLessonConsolidationSubmissionMessage({
    ...input,
    activityType: "translation_en_to_cn",
    kind: "translation",
  });
}

export function buildLessonSessionAdvance(
  event: "lesson_start_exercise" | "lesson_retry" | "lesson_complete",
): AdvanceStudySessionInput {
  return advanceStudySessionSchema.parse({ event });
}

export function buildNextLessonMessage(nextWord: string): string {
  return `WordLoop backend 指定下一个学习词：\n${nextWord}\n\n请只为这个词按 Teaching Prompt 生成并渲染 LessonWidget mode=explain。\n不要自行更换单词。`;
}

export function buildRoundCompleteMessage(
  finalWord?: string,
  consolidation?: {
    kind: "translation" | "translation_cn_to_en" | "sentence";
    trigger_round: number;
    target_words: string[];
    activity_type?: string;
    plan_id?: string;
    exercise_id?: string;
    skill_goal?: string;
    target_sense?: string;
    estimated_seconds?: number;
  } | null,
): string {
  const anchor = finalWord?.trim();
  if (!consolidation) {
    return [
      "WORDLOOP_ROUND_COMPLETE",
      "",
      "The server reports no periodic consolidation for this Lesson round.",
      "Call finish_study_session exactly once, report this round complete, and wait for the user to start another round.",
      "Do not generate any round-end exercise or infer cadence from chat history.",
    ].join("\n");
  }
  const activity = consolidation.activity_type ?? (consolidation.kind === "translation" ? "translation_en_to_cn" : consolidation.kind);
  const translation = activity === "translation_en_to_cn";
  const shortTranslation = activity === "translation_cn_to_en";
  return [
    "WORDLOOP_ROUND_COMPLETE",
    "",
    "The current Lesson round is complete.",
    `Server cadence: ${consolidation.kind}, trigger round ${consolidation.trigger_round}.`,
    `Use exactly these server-selected target words: ${consolidation.target_words.join(", ")}.`,
    `Persisted plan: plan_id=${consolidation.plan_id ?? "use saved plan"}, exercise_id=${consolidation.exercise_id ?? "use saved exercise id"}, activity_type=${activity}, skill_goal=${consolidation.skill_goal ?? "follow saved plan"}, target_sense=${consolidation.target_sense ?? "follow saved plan"}, estimated_seconds=${consolidation.estimated_seconds ?? 120}.`,
    translation
      ? "Create one natural 25–40-word sentence with one primary structure point; use one suitable target word if natural (a second is optional). Ask for a Chinese translation; main-clause analysis is optional."
      : shortTranslation
        ? "Create one complete, concrete Chinese-to-English translation task for one core word sense or collocation; the Chinese sentence must be clear and expected English output about 12–25 words."
        : "Create one concrete contextual application goal using the displayed target word; ask for one natural English sentence, usually 10–25 words. Mark it as prompted application.",
    "Render exactly one task in the existing LessonWidget; do not add another exercise.",
    `Call render_lesson_widget with mode=exercise, consolidation=true, consolidation_kind=${consolidation.kind},`,
    ...(anchor ? [`word=${anchor} (the exact final Lesson word; bookkeeping anchor only),`] : ["word set to the exact final Lesson word from the completed card,"]),
    `activity_type=${activity}, multiline=true.`,
    "",
    "The server, not this model or the client, controls cadence. Keep the complete task in the Widget.",
  ].join("\n");
}

function consolidationPlanForPayload(payload: Payload): {
  planned_activity_type: string;
  plan_id?: string;
  exercise_id?: string;
  skill_goal?: string;
  target_sense?: string;
  estimated_seconds?: number;
} | undefined {
  const extra = payload as Record<string, unknown>;
  const candidate = extra.consolidation_plan ?? payload.plan;
  const parsed = z.object({
    planned_activity_type: z.string(),
    plan_id: z.string().uuid().optional(),
    exercise_id: z.string().uuid().optional(),
    skill_goal: z.string().optional(),
    target_sense: z.string().optional(),
    estimated_seconds: z.number().int().optional(),
  }).passthrough().safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function canStartNextLesson(status: NextLessonStatus): boolean {
  return status === "idle" || status === "error";
}

export function LessonFeedbackNextStep({ canContinue, navigation }: {
  canContinue: boolean;
  navigation: Payload["navigation"];
}): React.JSX.Element | null {
  if (!canContinue) return <p>下一步：重做当前题</p>;
  if (navigation?.action === "next_word") return <p>下一词：{navigation.next_word}</p>;
  if (navigation?.action === "round_complete") return <p>下一步：完成本轮并继续</p>;
  return null;
}

export function LessonWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [localMode, setLocalMode] = useState<Mode | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [nextStatus, setNextStatus] = useState<NextLessonStatus>("idle");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [dictionaryAudio, setDictionaryAudio] = useState<Record<string, string>>({});
  const [dictionaryReady, setDictionaryReady] = useState(false);
  const submissionIdRef = useRef<string | null>(null);
  const [englishVoiceAvailable, setEnglishVoiceAvailable] = useState(false);
  const [widgetLoadError, setWidgetLoadError] = useState("");
  const signatureRef = useRef("");
  const lastGoodPayloadRef = useRef<Payload | null>(null);
  const recoveryInFlightRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextStatusRef = useRef<NextLessonStatus>("idle");
  const answerRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const speechAvailable = typeof window !== "undefined"
    && "speechSynthesis" in window
    && "SpeechSynthesisUtterance" in window;

  useEffect(() => {
    if (!speechAvailable) return;
    const synthesis = window.speechSynthesis;
    const updateVoiceAvailability = (): void => {
      setEnglishVoiceAvailable(selectEnglishVoice(synthesis.getVoices()) !== null);
    };
    updateVoiceAvailability();
    synthesis.addEventListener("voiceschanged", updateVoiceAvailability);
    return () => synthesis.removeEventListener("voiceschanged", updateVoiceAvailability);
  }, [speechAvailable]);

  useEffect(() => {
    function clearRecoveryTimer(): void {
      if (recoveryTimerRef.current === null) return;
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }

    function applyLessonAppEvent(event: LessonAppEvent): LessonAppEventRoute {
      const routed = routeLessonAppEvent(event, lastGoodPayloadRef.current !== null, signatureRef.current);
      if (routed.kind === "ignore") return routed;
      if (routed.kind === "invalid") {
        if (typeof process === "undefined" || process.env.NODE_ENV !== "production") {
          console.error(
            "LESSON_WIDGET_PAYLOAD_INVALID",
            JSON.stringify(routed.issues.map(({ code, path }) => ({ code, path }))),
          );
        }
        if (routed.blocking) setWidgetLoadError(LESSON_WIDGET_LOAD_ERROR);
        else setError(LESSON_WIDGET_REFRESH_ERROR);
        return routed;
      }
      if (routed.duplicate) return routed;
      clearRecoveryTimer();
      signatureRef.current = routed.signature;
      lastGoodPayloadRef.current = routed.payload;
      setPayload(routed.payload);
      setLocalMode(null);
      setAnswer("");
      setSubmitStatus("idle");
      nextStatusRef.current = "idle";
      setNextStatus("idle");
      setError("");
      setWidgetLoadError("");
      return routed;
    }

    function canRecover(): boolean {
      return shouldScheduleLessonRecovery(
        lastGoodPayloadRef.current !== null,
        Boolean(window.__WORDLOOP_PREVIEW__),
        recoveryInFlightRef.current,
      );
    }

    async function recoverLesson(): Promise<void> {
      if (!canRecover()) return;
      recoveryInFlightRef.current = true;
      try {
        const result = await callServerTool("render_lesson_widget", { resume: true });
        // A replayed host result wins if it arrives while resume is in flight.
        if (lastGoodPayloadRef.current !== null) return;
        if (result.isError) throw new Error(LESSON_WIDGET_LOAD_ERROR);
        const candidate = toolResultData(result);
        const routed = applyLessonAppEvent({ type: "toolresult", value: { structuredContent: candidate } });
        if (routed.kind !== "render" || lastGoodPayloadRef.current === null) {
          setWidgetLoadError(LESSON_WIDGET_LOAD_ERROR);
        }
      } catch {
        if (lastGoodPayloadRef.current === null) setWidgetLoadError(LESSON_WIDGET_LOAD_ERROR);
      } finally {
        recoveryInFlightRef.current = false;
      }
    }

    function scheduleRecovery(delayMs: number): void {
      scheduleLessonRecovery(recoveryTimerRef, delayMs, canRecover, recoverLesson);
    }

    const unsubscribe = subscribeToApp((event) => {
      if (event.type !== "toolinput" && event.type !== "toolresult") return;
      applyLessonAppEvent(event);
    });

    if (typeof document === "undefined" || typeof window === "undefined") return unsubscribe;

    const unsubscribeLifecycle = attachLessonRecoveryLifecycle(document, window, scheduleRecovery);
    scheduleRecovery(LESSON_MOUNT_RECOVERY_DELAY_MS);

    return () => {
      unsubscribe();
      unsubscribeLifecycle();
      clearRecoveryTimer();
    };
  }, []);

  const mode = localMode ?? modeForPhase(payload?.phase) ?? payload?.mode ?? "explain";
  const exercise = payload ? exerciseFromPayload(payload) : null;
  const activityType = exercise?.activity_type ?? "";
  const exercisePrompt = exercise?.prompt ?? "";
  const displayedExercisePrompt = lessonPromptWithMeaning(activityType, exercisePrompt, payload?.cloze_hint);
  const instruction = exercise?.instruction ?? "";
  const multiline = exercise?.multiline ?? false;
  const currentWord = payload?.word ?? "";

  useEffect(() => {
    let cancelled = false;
    if (!currentWord) {
      setDictionaryAudio({});
      setDictionaryReady(true);
      return () => { cancelled = true; };
    }

    setDictionaryAudio({});
    setDictionaryReady(false);
    void loadDictionaryPronunciationAudio([currentWord])
      .then((audio) => {
        if (cancelled) return;
        setDictionaryAudio(audio);
        setDictionaryReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDictionaryAudio({});
        setDictionaryReady(true);
      });
    return () => { cancelled = true; };
  }, [currentWord]);

  const dictionaryAudioAvailable = Boolean(dictionaryAudio[currentWord]);
  const speechPlaybackAvailable = speechAvailable && englishVoiceAvailable;

  function play(): void {
    if (!currentWord) return;
    playPronunciation(currentWord, dictionaryAudio[currentWord], () => setPlaying(true), () => setPlaying(false));
  }

  async function startExercise(): Promise<void> {
    if (!payload || payload.mode !== "explain") return;
    setError("");
    setAnswer("");
    setSubmitStatus("idle");
    submissionIdRef.current = null;
    try {
      if (!window.__WORDLOOP_PREVIEW__) {
        const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_start_exercise"));
        if (result.isError) throw new Error("无法保存练习阶段，请重试。");
      }
      setLocalMode("exercise");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法开始练习，请重试。");
    }
  }

  async function submitExercise(): Promise<void> {
    if (!payload || !exercisePrompt.trim() || !answer.trim() || submitStatus === "sending" || submitStatus === "sent") return;
    setSubmitStatus("sending");
    setError("");
    try {
      const message = payload.mode !== "explain" && payload.consolidation === true
        ? buildLessonConsolidationSubmissionMessage({
          word: currentWord,
          activityType: activityType as "translation_en_to_cn" | "translation_cn_to_en" | "sentence",
          kind: payload.consolidation_kind === "sentence" ? "sentence" : payload.consolidation_kind === "translation_cn_to_en" ? "translation_cn_to_en" : "translation",
          prompt: exercisePrompt,
          answer,
          submissionId: submissionIdRef.current ??= crypto.randomUUID(),
          exerciseId: payload.plan?.exercise_id,
          planId: payload.plan?.plan_id,
          hintUsed: payload.hint_used === true,
        })
        : payload.mode !== "explain" && payload.wrapup === true
          ? buildLessonWrapupSubmissionMessage({ word: currentWord, prompt: exercisePrompt, answer })
        : buildLessonSubmissionMessage({
          word: currentWord,
          activityType,
          prompt: exercisePrompt,
          answer,
          submissionId: submissionIdRef.current ??= crypto.randomUUID(),
          exerciseId: payload.plan?.exercise_id,
          planId: payload.plan?.plan_id,
          hintUsed: false,
        });
      await sendUserMessage(message);
      setSubmitStatus("sent");
    } catch (caught) {
      setSubmitStatus("error");
      setError(caught instanceof Error ? caught.message : "答案未能提交，请重试。");
    }
  }

  async function nextLesson(): Promise<void> {
    if (!payload || !canStartNextLesson(nextStatusRef.current)) return;
    nextStatusRef.current = "sending";
    setNextStatus("sending");
    setError("");
    try {
      if (payload.mode !== "explain" && payload.consolidation === true
        && payload.consolidation_status === "feedback") {
        await sendUserMessage("WordLoop 周期巩固已完成批改。请调用 finish_study_session exactly once，报告本轮学习完成，等待用户主动开始下一轮；不要自动生成新题或调用 get_study_bootstrap。");
        nextStatusRef.current = "sent";
        setNextStatus("sent");
        return;
      }
      if (payload.mode !== "explain" && payload.consolidation === true
        && payload.consolidation_status === "pending") {
        const targetWords = payload.consolidation_target_words ?? [];
        const savedPlan = consolidationPlanForPayload(payload);
        await sendUserMessage(buildRoundCompleteMessage(currentWord, {
          kind: payload.consolidation_kind === "sentence" ? "sentence" : payload.consolidation_kind === "translation_cn_to_en" ? "translation_cn_to_en" : "translation",
          trigger_round: payload.consolidation_trigger_round ?? 0,
          target_words: targetWords,
          activity_type: savedPlan?.planned_activity_type,
          plan_id: savedPlan?.plan_id,
          exercise_id: savedPlan?.exercise_id,
          skill_goal: savedPlan?.skill_goal,
          target_sense: savedPlan?.target_sense,
          estimated_seconds: savedPlan?.estimated_seconds,
        }));
        nextStatusRef.current = "sent";
        setNextStatus("sent");
        return;
      }
      const navigation = payload.navigation;
      if (!navigation) throw new Error("LESSON_NAVIGATION_MISSING");
      if (navigation.action === "next_word") {
        await sendUserMessage(buildNextLessonMessage(navigation.next_word));
      } else {
        let consolidation: {
          kind: "translation" | "translation_cn_to_en" | "sentence";
          trigger_round: number;
          target_words: string[];
          activity_type?: string;
          plan_id?: string;
          exercise_id?: string;
          skill_goal?: string;
          target_sense?: string;
          estimated_seconds?: number;
        } | null = null;
        if (payload.phase !== "lesson_complete" && !window.__WORDLOOP_PREVIEW__) {
          const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_complete"));
          if (result.isError) throw new Error("无法保存本轮完成状态，请重试。");
          const resultValue = toolResultData(result);
          if (typeof resultValue === "object" && resultValue !== null && !Array.isArray(resultValue)) {
            const parsed = z.object({
              kind: z.enum(["translation", "translation_cn_to_en", "sentence"]),
              trigger_round: z.number().int().positive(),
              target_words: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
              activity_type: z.string().optional(),
              plan_id: z.string().uuid().optional(),
              exercise_id: z.string().uuid().optional(),
              skill_goal: z.string().optional(),
              target_sense: z.string().optional(),
              estimated_seconds: z.number().int().optional(),
            }).safeParse((resultValue as Record<string, unknown>).consolidation);
            if (parsed.success) consolidation = parsed.data;
          }
        } else if (payload.consolidation === true) {
          const savedPlan = consolidationPlanForPayload(payload);
          const parsed = z.object({
            kind: z.enum(["translation", "translation_cn_to_en", "sentence"]),
            trigger_round: z.number().int().positive(),
            target_words: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
          }).safeParse({
            kind: payload.consolidation_kind,
          trigger_round: payload.consolidation_trigger_round,
          target_words: payload.consolidation_target_words,
          activity_type: savedPlan?.planned_activity_type,
          plan_id: savedPlan?.plan_id,
          exercise_id: savedPlan?.exercise_id,
          skill_goal: savedPlan?.skill_goal,
          target_sense: savedPlan?.target_sense,
          estimated_seconds: savedPlan?.estimated_seconds,
        });
          if (parsed.success) consolidation = parsed.data;
        }
        await sendUserMessage(buildRoundCompleteMessage(currentWord, consolidation));
      }
      nextStatusRef.current = "sent";
      setNextStatus("sent");
    } catch (caught) {
      nextStatusRef.current = "error";
      setNextStatus("error");
      setError(caught instanceof Error ? caught.message : "无法进入下一步，请重试。");
    }
  }

  async function deferPendingConsolidation(): Promise<void> {
    if (!payload || payload.consolidation_status !== "pending" || nextStatusRef.current === "sending") return;
    nextStatusRef.current = "sending";
    setNextStatus("sending");
    setError("");
    try {
      await sendUserMessage("我选择稍后做这道应用巩固。请对当前持久化的 pending 任务调用 advance_study_session，event=lesson_consolidation_defer；随后 finish_study_session exactly once 结束本轮。不要生成或批改巩固题，不推进 rotation cursor，不增加词汇完成数。最后调用 render_learning_dashboard 显示保留的待做任务，并保持聊天区安静。");
      nextStatusRef.current = "sent";
      setNextStatus("sent");
    } catch (caught) {
      nextStatusRef.current = "error";
      setNextStatus("error");
      setError(caught instanceof Error ? caught.message : "稍后处理没有保存，请重试。");
    }
  }

  async function retryExercise(): Promise<void> {
    if (!payload || payload.mode !== "feedback") return;
    setSubmitStatus("sending");
    setError("");
    try {
      if (!payload.wrapup && !window.__WORDLOOP_PREVIEW__) {
        const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_retry"));
        if (result.isError) throw new Error("无法保存重试阶段，请重试。");
      }
      submissionIdRef.current = null;
      setLocalMode("exercise");
      setAnswer("");
      setSubmitStatus("idle");
    } catch (caught) {
      setSubmitStatus("error");
      setError(caught instanceof Error ? caught.message : "无法开始重试，请重试。");
    }
  }

  if (!payload) {
    if (widgetLoadError) {
      return <section className="widget-card load-error" role="alert"><span>{widgetLoadError}</span></section>;
    }
    return <section className="widget-card skeleton" aria-busy="true"><span>正在加载学习内容…</span></section>;
  }

  const pendingConsolidation = payload.consolidation === true && payload.consolidation_status === "pending";

  if (mode === "exercise") {
    const consolidation = payload.consolidation === true;
    const consolidationTitle = payload.consolidation_kind === "sentence" ? "情境造句"
      : payload.consolidation_kind === "translation_cn_to_en" ? "完整中译英" : "长难句英译中";
    return <section className="widget-card lesson-card" aria-labelledby="lesson-exercise-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">{consolidation ? consolidationTitle : payload.title ?? "练习"}</span>
          <h1 id="lesson-exercise-title">{consolidation ? payload.progress ?? (payload.consolidation_kind === "sentence" ? "应用巩固 · 情境造句" : payload.consolidation_kind === "translation_cn_to_en" ? "应用巩固 · 中译英" : "应用巩固 · 长难句英译中") : payload.progress ?? "当前练习"}</h1>
        </div>
        <FocusButton />
      </header>
      <div className="lesson-exercise-heading">
        <strong>{instruction}</strong>
      </div>
      <div className="lesson-prompt">{displayedExercisePrompt}</div>
      <LessonClozeHint hint={payload.cloze_hint} prompt={exercisePrompt} activityType={activityType} />
      {activityType === "listening" ? <button className="play-button lesson-audio" type="button" onClick={play} disabled={!dictionaryReady || (!dictionaryAudioAvailable && !speechPlaybackAvailable)} aria-label="播放听力">
        <span className="play-icon"><PlayIcon /></span>{pronunciationButtonLabel(dictionaryAudioAvailable, speechPlaybackAvailable, dictionaryReady, playing)}
      </button> : null}
      <label className="answer-label" htmlFor="lesson-answer">你的答案</label>
      {multiline ? <textarea
        ref={(node) => { answerRef.current = node; }}
        id="lesson-answer"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="输入答案…"
        rows={consolidation && payload.consolidation_kind === "sentence" ? 2 : undefined}
        disabled={submitStatus === "sending" || submitStatus === "sent"}
        autoFocus
      /> : <input
        ref={(node) => { answerRef.current = node; }}
        id="lesson-answer"
        className="answer-input"
        type="text"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="输入英文…"
        disabled={submitStatus === "sending" || submitStatus === "sent"}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submitExercise();
          }
        }}
        autoFocus
      />}
      {submitStatus === "sent" ? <p className="answer-status" role="status">已提交，正在批改…</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <Button onClick={() => void submitExercise()} disabled={!answer.trim() || submitStatus === "sending" || submitStatus === "sent"}>
        {submitStatus === "sending" ? "正在提交…" : submitStatus === "sent" ? "已提交" : "提交"}
      </Button>
    </section>;
  }

  if (mode === "feedback" && payload.mode === "feedback") {
    const feedback = payload.feedback;
    const correct = feedbackIsCorrect(feedback);
    const reveal = feedbackRevealsAnswer(feedback);
    const consolidation = payload.consolidation === true;
    const navigation = payload.navigation;
    const roundComplete = navigation?.action === "round_complete";
    const completed = payload.phase === "lesson_complete";
    const canContinue = consolidation || payload.wrapup === true ? correct || reveal : completed || correct || reveal;
    const nextDisabled = nextStatus === "sending" || nextStatus === "sent";
    return <section className="widget-card lesson-card" aria-labelledby="lesson-feedback-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">{consolidation ? payload.consolidation_kind === "sentence" ? "情境造句" : payload.consolidation_kind === "translation_cn_to_en" ? "完整中译英" : "长难句英译中" : "批改"}</span>
          <h1 id="lesson-feedback-title">{pendingConsolidation ? "词汇轮完成" : consolidation ? (correct ? "巩固完成" : "需要修改") : completed ? "本轮词汇已完成" : correct ? "✓ 通过" : "需要修改"}</h1>
        </div>
        <FocusButton />
      </header>
      {feedback?.user_answer || answer ? <div className="lesson-answer"><span>你的答案</span><p>{feedback?.user_answer ?? answer}</p></div> : null}
      {!correct ? <div className="lesson-feedback">
        {feedback?.error_layer ? <p><strong>错误层：</strong>{feedback.error_layer}</p> : null}
        {feedback?.message ? <p><strong>问题：</strong>{feedback.message}</p> : null}
        {reveal && feedback?.reference_answer ? <p><strong>参考：</strong>{feedback.reference_answer}</p> : null}
        {feedback?.explanation ? <p><strong>{feedbackGuidanceLabel(reveal)}：</strong>{feedback.explanation}</p> : null}
      </div> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {pendingConsolidation ? <div className="lesson-feedback">
        <p>应用巩固待做：{payload.consolidation_kind === "sentence" ? "情境造句" : payload.consolidation_kind === "translation_cn_to_en" ? "完整中译英" : "长难句英译中"}。可以现在做（约 2 分钟），也可以稍后从 Dashboard 开始。</p>
      </div> : null}
      {!pendingConsolidation && !consolidation && payload.wrapup !== true ? <LessonFeedbackNextStep canContinue={canContinue} navigation={navigation} /> : null}
      {pendingConsolidation ? <>
        <Button onClick={() => void nextLesson()} disabled={nextDisabled}>{nextStatus === "sending" ? "正在打开…" : "做一道，约 2 分钟"}</Button>
        <Button className="secondary" onClick={() => void deferPendingConsolidation()} disabled={nextDisabled}>{nextStatus === "sending" ? "正在保存…" : "稍后做"}</Button>
      </> : canContinue
        ? <Button onClick={() => void nextLesson()} disabled={nextDisabled}>
          {nextStatus === "sending" ? "正在进入下一步…" : nextStatus === "sent" ? "已进入下一步" : consolidation || payload.wrapup === true ? "继续学习" : roundComplete || completed ? "完成本轮并继续" : "下一词"}
          {nextStatus === "idle" || nextStatus === "error" ? <ArrowIcon className="button-icon trailing" /> : null}
        </Button>
        : <Button className="secondary" onClick={() => void retryExercise()} disabled={submitStatus === "sending"}>重做当前题</Button>}
    </section>;
  }

  return <section className="widget-card lesson-card" aria-labelledby="lesson-explain-title">
    <header className="widget-header compact-header">
      <div>
        <span className="eyebrow">{lessonEyebrowLabel(payload.progress)}</span>
        <h1 id="lesson-explain-title">{payload.progress ?? "单词学习"}</h1>
      </div>
      <FocusButton />
    </header>
    <div className="lesson-word-heading">
      <strong>{payload.word}</strong>
      {payload.mode === "explain" && payload.part_of_speech && !meaningIncludesPartOfSpeech(payload.meaning_zh, payload.part_of_speech) ? <span className="part-of-speech">{payload.part_of_speech}</span> : null}
    </div>
    {payload.mode === "explain" && payload.ipa ? <div className="lesson-ipa">{payload.ipa}</div> : null}
    {payload.mode === "explain" ? <section className="lesson-section"><h2>核心义</h2><p>{payload.meaning_zh}</p></section> : null}
    {payload.mode === "explain" && payload.collocations.length ? <section className="lesson-section"><h2>高频搭配</h2><ul>{payload.collocations.map((entry) => <li key={entry}>{entry}</li>)}</ul></section> : null}
    {payload.mode === "explain" && payload.derivations.length ? <section className="lesson-section"><h2>词族</h2><ul>{payload.derivations.map((entry) => <li key={entry}>{entry}</li>)}</ul></section> : null}
    {payload.mode === "explain" ? <section className="lesson-section"><h2>例句</h2><p className="lesson-example">{payload.example_en}</p>{payload.example_zh ? <p className="lesson-example-translation">{payload.example_zh}</p> : null}</section> : null}
    {payload.mode === "explain" ? <section className="lesson-section"><h2>补充</h2><p>{payload.note}</p></section> : null}
    <button className="play-button lesson-audio" type="button" onClick={play} disabled={!dictionaryReady || (!dictionaryAudioAvailable && !speechPlaybackAvailable)} aria-label={"播放 " + payload.word}>
      <span className="play-icon"><PlayIcon /></span>{pronunciationButtonLabel(dictionaryAudioAvailable, speechPlaybackAvailable, dictionaryReady, playing)}
    </button>
    {dictionaryAudioAvailable ? <div className="dictionary-attribution" aria-label="Pronunciation audio by Merriam-Webster">
      <img src="https://dictionaryapi.com/images/info/branding-guidelines/MWLogo_LightBG_120x120_2x.png" width="50" height="50" alt="Merriam-Webster" />
      <span>发音来自 Merriam-Webster's Learner's Dictionary</span>
    </div> : null}
    <Button onClick={() => void startExercise()}>开始练习 <ArrowIcon className="button-icon trailing" /></Button>
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </section>;
}
