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
  consolidation_kind: z.enum(["translation", "sentence"]).optional(),
  consolidation_trigger_round: z.number().int().positive().optional(),
  consolidation_target_words: z.array(z.string().trim().min(1).max(100)).max(3).optional(),
  consolidation_status: z.enum(["pending", "exercise", "feedback", "completed"]).optional(),
};

const explainPayloadSchema = z.object({
  ...payloadCommon,
  mode: z.literal("explain"),
  progress: z.string().trim().max(40).optional(),
  ipa: z.string().trim().min(1).max(120),
  part_of_speech: z.string().trim().min(1).max(40),
  meaning_zh: z.string().trim().min(1).max(240),
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
}): string {
  const submission = lessonSubmissionSchema.parse({
    word: input.word,
    activity_type: input.activityType,
    prompt: input.prompt,
    answer: input.answer,
  });
  return `提交 WordLoop 正式学习答案。\n\n目标词：${submission.word}\n练习类型：${submission.activity_type}\n题目：${submission.prompt}\n用户答案：${submission.answer.trim()}\n\n判定规则：若练习类型属于确定性题型（pretest_cn_to_en、listen_recall、spelling、word_recall），用确定性判分得到 is_correct 与 error_layer（不要凭语感判断；错误层只允许 none/spelling/meaning）；其余题型按 Teaching Prompt 做语义批改。然后调用 record_attempt 记录本次作答（record_attempt 只负责持久化，不会替你判分）。最后调用 render_lesson_widget mode=feedback，批改用词与解释由你负责。\n\n错误反馈必须帮助用户自纠：第一次答错时，message 要指出用户答案中的至少一个具体错误片段或位置，不能只写“有几处错误”或只报错误层；explanation 要说明为什么错以及下一步改哪里/怎么改，但不能给出完整改后句。第一次答错时设 reveal_answer=false 并省略 reference_answer。只有连续第二次仍错时，才可以提供 reference_answer 和完整 explanation，并设 reveal_answer=true。\n\nThe current submitted answer is authoritative: the 用户答案 field in THIS submission is the only answer to grade. Grade only this submitted answer; do not substitute or reuse an answer from an earlier chat turn.\n\nAfter grading, your response to this submission must complete BOTH tool actions:\n1. call record_attempt exactly once\n2. call render_lesson_widget exactly once with mode="feedback". Reuse this submission's word, current exercise (activity_type and prompt), and user_answer; do not generate another exercise, switch questions, or change words.\n\nDo not output the grading as ordinary chat text. The feedback is not complete until render_lesson_widget succeeds. After the feedback Widget renders successfully, remain silent in chat.`;
}

export function buildLessonConsolidationSubmissionMessage(input: {
  word: string;
  activityType: "translation_en_to_cn" | "sentence";
  kind: "translation" | "sentence";
  prompt: string;
  answer: string;
}): string {
  const submission = lessonSubmissionSchema.parse({
    word: input.word,
    activity_type: input.activityType,
    prompt: input.prompt,
    answer: input.answer,
  });
  const translation = input.kind === "translation";
  return `提交 WordLoop 周期巩固答案。\n\n最后一个 Lesson 词（仅作 attempts 记录锚点）：${submission.word}\n练习类型：${submission.activity_type}\n巩固类型：${input.kind}\n题目：${submission.prompt}\n用户答案：${submission.answer.trim()}\n\n这是一个 one task / one answer / one feedback 的 consolidation。${translation ? "批改重点：句子主干、从句和修饰关系、逻辑关系、目标词义和中文自然度；允许自然且准确的不同译法，不要因措辞不同于参考译文判错。用户可以在同一答案中写“主干：… 翻译：…”，也可以只提交翻译。" : "批改重点：目标词义、搭配、词性、句法位置和自然表达；接受合理的简单句或复合句，不要求学术风格。"} 使用 semantic grading 后，调用 record_attempt exactly once，activity_type=${submission.activity_type}，word 必须使用上面的精确锚点；record_attempt 只记录练习，不推进 FSRS。然后调用 render_lesson_widget mode=feedback、consolidation=true、consolidation_kind=${input.kind}，沿用同一个 word、原题和这次反馈。第一次答错时指出具体错误并给自纠方向，不给完整答案（reveal_answer=false，省略 reference_answer）；允许用户修改同一道题一次。第二次仍错时给参考表达并解释（reveal_answer=true），不要生成新题。\n\nThe current submitted answer is authoritative: grade only the 用户答案 field in THIS submission. After grading, call record_attempt exactly once and render_lesson_widget exactly once. Do not output feedback as ordinary chat text. After the feedback Widget succeeds, remain silent in chat.`;
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
  consolidation?: { kind: "translation" | "sentence"; trigger_round: number; target_words: string[] } | null,
): string {
  const anchor = finalWord?.trim();
  if (!consolidation) {
    return [
      "WORDLOOP_ROUND_COMPLETE",
      "",
      "The server reports no periodic consolidation for this Lesson round.",
      "Call finish_study_session exactly once, then immediately call get_study_bootstrap.",
      "Do not generate any round-end exercise or infer cadence from chat history.",
    ].join("\n");
  }
  const translation = consolidation.kind === "translation";
  return [
    "WORDLOOP_ROUND_COMPLETE",
    "",
    "The current Lesson round is complete.",
    `Server cadence: ${consolidation.kind}, trigger round ${consolidation.trigger_round}.`,
    `Use exactly these server-selected target words: ${consolidation.target_words.join(", ")}.`,
    translation
      ? "Create one natural 25–40-word formal English sentence using at least two target words; ask the user to find its main clause and translate the whole sentence into natural Chinese."
      : "Create one short task asking the user to write one natural 15–30-word English sentence using these target words.",
    "Render exactly one task in the existing LessonWidget; do not add another exercise.",
    `Call render_lesson_widget with mode=exercise, consolidation=true, consolidation_kind=${consolidation.kind},`,
    ...(anchor ? [`word=${anchor} (the exact final Lesson word; bookkeeping anchor only),`] : ["word set to the exact final Lesson word from the completed card,"]),
    `activity_type=${translation ? "translation_en_to_cn" : "sentence"}, multiline=true.`,
    "",
    "The server, not this model or the client, controls cadence. Keep the complete task in the Widget.",
  ].join("\n");
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
          activityType: activityType as "translation_en_to_cn" | "sentence",
          kind: payload.consolidation_kind === "sentence" ? "sentence" : "translation",
          prompt: exercisePrompt,
          answer,
        })
        : payload.mode !== "explain" && payload.wrapup === true
          ? buildLessonWrapupSubmissionMessage({ word: currentWord, prompt: exercisePrompt, answer })
        : buildLessonSubmissionMessage({
          word: currentWord,
          activityType,
          prompt: exercisePrompt,
          answer,
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
        await sendUserMessage("WordLoop 周期巩固已完成批改。请调用 finish_study_session exactly once，然后立即调用 get_study_bootstrap 继续当天剩余学习；不要生成新题。成功渲染下一张 Widget 后保持聊天区安静。");
        nextStatusRef.current = "sent";
        setNextStatus("sent");
        return;
      }
      if (payload.mode !== "explain" && payload.consolidation === true
        && payload.consolidation_status === "pending") {
        const targetWords = payload.consolidation_target_words ?? [];
        await sendUserMessage(buildRoundCompleteMessage(currentWord, {
          kind: payload.consolidation_kind === "sentence" ? "sentence" : "translation",
          trigger_round: payload.consolidation_trigger_round ?? 0,
          target_words: targetWords,
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
        let consolidation: { kind: "translation" | "sentence"; trigger_round: number; target_words: string[] } | null = null;
        if (payload.phase !== "lesson_complete" && !window.__WORDLOOP_PREVIEW__) {
          const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_complete"));
          if (result.isError) throw new Error("无法保存本轮完成状态，请重试。");
          const resultValue = toolResultData(result);
          if (typeof resultValue === "object" && resultValue !== null && !Array.isArray(resultValue)) {
            const parsed = z.object({
              kind: z.enum(["translation", "sentence"]),
              trigger_round: z.number().int().positive(),
              target_words: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
            }).safeParse((resultValue as Record<string, unknown>).consolidation);
            if (parsed.success) consolidation = parsed.data;
          }
        } else if (payload.consolidation === true) {
          const parsed = z.object({
            kind: z.enum(["translation", "sentence"]),
            trigger_round: z.number().int().positive(),
            target_words: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
          }).safeParse({
            kind: payload.consolidation_kind,
            trigger_round: payload.consolidation_trigger_round,
            target_words: payload.consolidation_target_words,
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

  async function retryExercise(): Promise<void> {
    if (!payload || payload.mode !== "feedback") return;
    setSubmitStatus("sending");
    setError("");
    try {
      if (!payload.wrapup && !window.__WORDLOOP_PREVIEW__) {
        const result = await callServerTool("advance_study_session", buildLessonSessionAdvance("lesson_retry"));
        if (result.isError) throw new Error("无法保存重试阶段，请重试。");
      }
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

  if (mode === "exercise") {
    const consolidation = payload.consolidation === true;
    const consolidationTitle = payload.consolidation_kind === "sentence" ? "造句练习" : "长难句翻译";
    return <section className="widget-card lesson-card" aria-labelledby="lesson-exercise-title">
      <header className="widget-header compact-header">
        <div>
          <span className="eyebrow">{consolidation ? consolidationTitle : payload.title ?? "练习"}</span>
          <h1 id="lesson-exercise-title">{consolidation ? payload.progress ?? (payload.consolidation_kind === "sentence" ? "周期巩固 · 主动表达" : "周期巩固 · 英译中") : payload.progress ?? "当前练习"}</h1>
        </div>
        <FocusButton />
      </header>
      <div className="lesson-exercise-heading">
        <strong>{instruction}</strong>
      </div>
      <div className="lesson-prompt">{exercisePrompt}</div>
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
          <span className="eyebrow">{consolidation ? payload.consolidation_kind === "sentence" ? "造句练习" : "长难句翻译" : "批改"}</span>
          <h1 id="lesson-feedback-title">{consolidation ? (correct ? "巩固完成" : "需要修改") : completed ? "本轮词汇已完成" : correct ? "✓ 通过" : "需要修改"}</h1>
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
      {!consolidation && payload.wrapup !== true ? <LessonFeedbackNextStep canContinue={canContinue} navigation={navigation} /> : null}
      {canContinue
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
      {payload.mode === "explain" && payload.part_of_speech ? <span className="part-of-speech">{payload.part_of_speech}</span> : null}
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
