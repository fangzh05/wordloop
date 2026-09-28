import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { toolResultData } from "../web/src/mcpBridge.js";
import {
  attachLessonRecoveryLifecycle,
  buildLessonConsolidationSubmissionMessage,
  buildLessonSubmissionMessage,
  buildLessonWrapupSubmissionMessage,
  buildRoundCompleteMessage,
  canStartNextLesson,
  feedbackGuidanceLabel,
  lessonEyebrowLabel,
  LESSON_MOUNT_RECOVERY_DELAY_MS,
  LESSON_VISIBILITY_RECOVERY_DELAY_MS,
  LessonFeedbackNextStep,
  LESSON_WIDGET_LOAD_ERROR,
  LESSON_WIDGET_REFRESH_ERROR,
  LESSON_WIDGET_VERSION,
  isLessonRenderCandidate,
  lessonPayloadSchema,
  scheduleLessonRecovery,
  routeLessonAppEvent,
  shouldScheduleLessonRecovery,
  LessonWidget,
} from "../web/src/lesson/LessonWidget.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("guided lesson widget", () => {
  it("labels Review re-learning separately from new-word Lessons", () => {
    expect(lessonEyebrowLabel("复习补学 3 / 4")).toBe("复习词");
    expect(lessonEyebrowLabel("新词学习 1 / 6")).toBe("新词");
  });

  it("has the three fixed modes and keeps exercise submission in the card", () => {
    const source = readFileSync(new URL("../web/src/lesson/LessonWidget.tsx", import.meta.url), "utf8");
    expect(source).toContain('z.discriminatedUnion("mode"');
    expect(source).toContain('z.literal("explain")');
    expect(source).toContain('z.literal("exercise")');
    expect(source).toContain('z.literal("feedback")');
    expect(source).toContain("modeForPhase");
    expect(source).toContain("提交 WordLoop 正式学习答案。");
    expect(source).toContain("reference_answer");
    expect(source).toContain("feedbackGuidanceLabel(reveal)");
    expect(source).not.toContain("reveal && feedback?.explanation");
    expect(source).not.toContain("feedback?.reveal_answer || feedback?.reference_answer");
    expect(source).toContain("payload.navigation");
    expect(source).toContain("LESSON_WIDGET_PAYLOAD_INVALID");
    expect(source).toContain("widgetLoadError");
    expect(source).toContain('buildLessonSessionAdvance("lesson_complete")');
    expect(source).not.toContain('callServerTool("get_next_learning_word"');
    expect(source).not.toContain("resolveNextLessonToolResult");
    expect(source).toContain("nextStatusRef");
    expect(source).toContain('setNextStatus("sending")');
    expect(source).toContain("buildLessonSessionAdvance(\"lesson_start_exercise\")");
    expect(source).toContain("buildLessonSessionAdvance(\"lesson_retry\")");
    expect(source).not.toContain("exerciseContextRef");
    expect(source).not.toContain("retainedExercise");
    expect(source).not.toContain("请等待练习题目");
    expect(source).not.toContain("updateModelContext");
  });

  it("keeps example and exercise as separate payload fields", () => {
    const source = readFileSync(new URL("../web/src/lesson/LessonWidget.tsx", import.meta.url), "utf8");
    expect(source).toContain("example_en");
    expect(source).toContain("exercisePrompt");
    expect(source).not.toContain("example_en === exercisePrompt");
  });

  it("renders a loading card before the host sends lesson data", () => {
    const markup = renderToStaticMarkup(<LessonWidget />);
    expect(markup).toContain("正在加载学习内容");
  });

  it("waits for the host replay before running the 600ms mount fallback", () => {
    vi.useFakeTimers();
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };
    let hasPayload = false;
    let resumeCalls = 0;
    const canRecover = (): boolean => shouldScheduleLessonRecovery(hasPayload, false, false);

    expect(LESSON_MOUNT_RECOVERY_DELAY_MS).toBe(600);
    scheduleLessonRecovery(timerRef, LESSON_MOUNT_RECOVERY_DELAY_MS, canRecover, async () => { resumeCalls += 1; });
    vi.advanceTimersByTime(599);
    expect(resumeCalls).toBe(0);
    hasPayload = true;
    vi.advanceTimersByTime(1);
    expect(resumeCalls).toBe(0);
    expect(timerRef.current).toBeNull();
  });

  it("runs one recovery after the mount fallback when no host payload arrives", () => {
    vi.useFakeTimers();
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };
    let resumeCalls = 0;
    scheduleLessonRecovery(
      timerRef,
      LESSON_MOUNT_RECOVERY_DELAY_MS,
      () => shouldScheduleLessonRecovery(false, false, false),
      async () => { resumeCalls += 1; },
    );

    vi.advanceTimersByTime(LESSON_MOUNT_RECOVERY_DELAY_MS);
    expect(resumeCalls).toBe(1);
    expect(timerRef.current).toBeNull();
  });

  it("schedules visible and pageshow recovery once, with a 300ms grace window", () => {
    vi.useFakeTimers();
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "hidden" }) as unknown as Document;
    const windowTarget = new EventTarget() as unknown as Window;
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };
    let resumeCalls = 0;
    const canRecover = (): boolean => shouldScheduleLessonRecovery(false, false, false);
    const scheduleRecovery = (delayMs: number): void => scheduleLessonRecovery(
      timerRef,
      delayMs,
      canRecover,
      async () => { resumeCalls += 1; },
    );
    const unsubscribe = attachLessonRecoveryLifecycle(documentTarget, windowTarget, scheduleRecovery);

    expect(LESSON_VISIBILITY_RECOVERY_DELAY_MS).toBe(300);
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(timerRef.current).toBeNull();
    Object.assign(documentTarget, { visibilityState: "visible" });
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(100);
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(299);
    expect(resumeCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(resumeCalls).toBe(1);
    unsubscribe();
  });

  it("does not schedule recovery for a live payload, preview, or an in-flight request", () => {
    expect(shouldScheduleLessonRecovery(true, false, false)).toBe(false);
    expect(shouldScheduleLessonRecovery(false, true, false)).toBe(false);
    expect(shouldScheduleLessonRecovery(false, false, true)).toBe(false);
    expect(shouldScheduleLessonRecovery(false, false, false)).toBe(true);
  });

  it("routes a resumed result through the same Lesson parser for both host transports", () => {
    const exercise = {
      widget: "lesson",
      widget_version: LESSON_WIDGET_VERSION,
      mode: "exercise",
      phase: "lesson_exercise",
      word: "resume",
      progress: "1 / 1",
      activity_type: "cloze",
      instruction: "Complete the sentence.",
      prompt: "Please ___ the result.",
      multiline: false,
    };
    const candidates = [
      toolResultData({ content: [], structuredContent: exercise }),
      toolResultData({ content: [{ type: "text", text: JSON.stringify(exercise) }] }),
    ];
    for (const candidate of candidates) {
      const routed = routeLessonAppEvent({ type: "toolresult", value: { structuredContent: candidate } }, false);
      expect(routed.kind).toBe("render");
      if (routed.kind !== "render") throw new Error("expected the resumed Lesson payload to validate");
      expect(routed.payload).toMatchObject({ mode: "exercise", word: "resume", prompt: "Please ___ the result." });
    }
  });

  it("wires recovery only to missing payload events and calls the existing resume tool", () => {
    const source = readFileSync(new URL("../web/src/lesson/LessonWidget.tsx", import.meta.url), "utf8");
    expect(source).toContain('callServerTool("render_lesson_widget", { resume: true })');
    expect(source).toContain("toolResultData(result)");
    expect(source).toContain("applyLessonAppEvent({ type: \"toolresult\", value: { structuredContent: candidate } })");
    expect(source).toContain("lastGoodPayloadRef.current !== null) return;");
    expect(source).toContain("attachLessonRecoveryLifecycle(document, window, scheduleRecovery)");
    expect(source).toContain("scheduleRecovery(LESSON_MOUNT_RECOVERY_DELAY_MS)");
    expect(source).not.toContain('callServerTool("get_study_bootstrap"');
    expect(source).not.toContain('sendUserMessage("@wordloop 继续")');
  });

  it("classifies only mode-bearing objects as Lesson render candidates", () => {
    expect(isLessonRenderCandidate({ mode: "feedback" })).toBe(true);
    expect(isLessonRenderCandidate({ mode: "explain" })).toBe(true);
    expect(isLessonRenderCandidate({ mode: "exercise" })).toBe(true);
    expect(isLessonRenderCandidate({ event: "lesson_retry" })).toBe(false);
    expect(isLessonRenderCandidate({ active: true, widget: "lesson", phase: "lesson_exercise" })).toBe(false);
    expect(isLessonRenderCandidate({ resume: true })).toBe(false);
    expect(isLessonRenderCandidate(null)).toBe(false);
  });

  it("ignores every Lesson tool input", () => {
    expect(routeLessonAppEvent({ type: "toolinput", value: { mode: "feedback", word: "shrink" } }, false)).toEqual({ kind: "ignore" });
    expect(routeLessonAppEvent({ type: "toolinput", value: { event: "lesson_complete" } }, false)).toEqual({ kind: "ignore" });
  });

  it("ignores incomplete session tool results without a render mode", () => {
    expect(routeLessonAppEvent({
      type: "toolresult",
      value: { structuredContent: { active: true, widget: "lesson", phase: "lesson_complete", current_word: "shrink", current_index: 8 } },
    }, false)).toEqual({ kind: "ignore" });
  });

  it("renders the complete production Lesson feedback payload", () => {
    const routed = routeLessonAppEvent({
      type: "toolresult",
      value: {
        structuredContent: {
          widget: "lesson",
          widget_version: 3,
          mode: "feedback",
          phase: "lesson_complete",
          current_index: 8,
          word: "shrink",
          progress: "9/50",
          exercise: { activity_type: "sentence", instruction: "Use shrink.", prompt: "Describe a shrinking sample.", multiline: false },
          feedback: { is_correct: true, user_answer: "The sample shrank.", reveal_answer: false },
          navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
        },
      },
    }, false);

    expect(routed.kind).toBe("render");
    if (routed.kind !== "render") throw new Error("expected a valid production Lesson feedback render");
    expect(routed.payload).toMatchObject({ widget: "lesson", widget_version: 3, mode: "feedback", word: "shrink", current_index: 8 });
  });

  it("restores omitted null terminal navigation fields from the host transport", () => {
    const routed = routeLessonAppEvent({
      type: "toolresult",
      value: {
        structuredContent: {
          widget: "lesson",
          mode: "feedback",
          phase: "lesson_complete",
          current_index: 8,
          word: "shrink",
          progress: "9 / 9",
          exercise: { activity_type: "sentence", instruction: "Use shrink.", prompt: "Describe a shrinking sample.", multiline: false },
          feedback: { is_correct: true, user_answer: "The sample shrank.", reveal_answer: false },
          navigation: { action: "round_complete", total_count: 9 },
        },
      },
    }, false);

    expect(routed.kind).toBe("render");
    if (routed.kind !== "render") throw new Error("expected terminal Lesson feedback to render");
    expect(routed.payload.navigation).toEqual({ action: "round_complete", next_word: null, next_index: null, total_count: 9 });
  });

  it("keeps the last-good Lesson payload through internal advance events", () => {
    const explain = {
      widget: "lesson",
      mode: "explain" as const,
      phase: "lesson_explain" as const,
      word: "shrink",
      ipa: "/ʃrɪŋk/",
      part_of_speech: "v.",
      meaning_zh: "收缩；缩小",
      collocations: [],
      derivations: [],
      example_en: "The sample began to shrink.",
      note: "Use this verb for becoming smaller.",
      exercise: { activity_type: "sentence", instruction: "Use shrink.", prompt: "Describe a sample.", multiline: false },
    };
    const first = routeLessonAppEvent({ type: "toolresult", value: { structuredContent: explain } }, false);
    expect(first.kind).toBe("render");
    if (first.kind !== "render") throw new Error("expected a valid Lesson render");

    const startInput = routeLessonAppEvent({ type: "toolinput", value: { event: "lesson_start_exercise" } }, true, first.signature);
    const startResult = routeLessonAppEvent({
      type: "toolresult",
      value: { structuredContent: { active: true, widget: "lesson", phase: "lesson_exercise", current_word: "shrink", current_index: 8 } },
    }, true, first.signature);

    expect(startInput).toEqual({ kind: "ignore" });
    expect(startResult).toEqual({ kind: "ignore" });
    expect(first.payload.word).toBe("shrink");
    expect(LESSON_WIDGET_REFRESH_ERROR).toBe("WordLoop 未能刷新学习卡，请重试。");
  });

  it("keeps feedback and round completion events isolated from the card", () => {
    const feedback = {
      widget: "lesson",
      mode: "feedback" as const,
      phase: "lesson_feedback" as const,
      current_index: 8,
      word: "shrink",
      progress: "9 / 9",
      navigation: { action: "round_complete" as const, next_word: null, next_index: null, total_count: 9 },
      exercise: { activity_type: "sentence", instruction: "Use shrink.", prompt: "Describe a sample.", multiline: false },
      feedback: { is_correct: true, user_answer: "The sample shrank.", reveal_answer: false },
    };
    const rendered = routeLessonAppEvent({ type: "toolresult", value: { structuredContent: feedback } }, false);
    expect(rendered.kind).toBe("render");
    if (rendered.kind !== "render") throw new Error("expected a valid feedback render");

    const retryInput = routeLessonAppEvent({ type: "toolinput", value: { event: "lesson_retry" } }, true, rendered.signature);
    const retryResult = routeLessonAppEvent({
      type: "toolresult",
      value: { structuredContent: { active: true, widget: "lesson", phase: "lesson_exercise", current_word: "shrink", current_index: 8 } },
    }, true, rendered.signature);
    const lessonCompleteInput = routeLessonAppEvent({ type: "toolinput", value: { event: "lesson_complete" } }, true, rendered.signature);
    const lessonCompleteResult = routeLessonAppEvent({
      type: "toolresult",
      value: { structuredContent: { active: true, widget: "lesson", phase: "lesson_complete", current_word: "shrink", current_index: 8 } },
    }, true, rendered.signature);

    expect(retryInput).toEqual({ kind: "ignore" });
    expect(retryResult).toEqual({ kind: "ignore" });
    expect(lessonCompleteInput).toEqual({ kind: "ignore" });
    expect(lessonCompleteResult).toEqual({ kind: "ignore" });
    expect(rendered.payload).toMatchObject({ word: "shrink", current_index: 8, navigation: { action: "round_complete" } });
  });

  it("reports malformed render candidates without erasing a last-good payload", () => {
    const malformed = routeLessonAppEvent({
      type: "toolresult",
      value: { structuredContent: { mode: "feedback", widget: "lesson", word: "shrink", progress: "9 / 9" } },
    }, true);
    expect(malformed.kind).toBe("invalid");
    if (malformed.kind !== "invalid") throw new Error("expected an invalid render candidate");
    expect(malformed.blocking).toBe(false);

    const initialFailure = routeLessonAppEvent({
      type: "toolresult",
      value: { structuredContent: { mode: "feedback", widget: "lesson", word: "shrink", progress: "9 / 9" } },
    }, false);
    expect(initialFailure.kind).toBe("invalid");
    if (initialFailure.kind !== "invalid") throw new Error("expected an invalid initial render candidate");
    expect(initialFailure.blocking).toBe(true);
    expect(LESSON_WIDGET_LOAD_ERROR).toBe("WordLoop 学习卡数据不完整，请重新进入学习。");
  });

  it("sends the minimum exercise data directly in the follow-up message", () => {
    const message = buildLessonSubmissionMessage({ word: "planet", activityType: "sentence", prompt: "Use planet in a new scene.", answer: "  My answer  " });
    expect(message).toContain("目标词：planet");
    expect(message).toContain("练习类型：sentence");
    expect(message).toContain("题目：Use planet in a new scene.");
    expect(message).toContain("用户答案：My answer");
    expect(message).toContain("具体错误片段或位置");
    expect(message).toContain("下一步改哪里/怎么改");
    expect(message).toContain("省略 reference_answer");
  });

  it("makes the current submission authoritative and requires terminal Widget feedback", () => {
    const message = buildLessonSubmissionMessage({
      word: "air-conditioning",
      activityType: "word_recall",
      prompt: "What does air-conditioning mean?",
      answer: "air-conditioned",
    });
    expect(message).toContain("用户答案：air-conditioned");
    expect(message).toContain("current submitted answer is authoritative");
    expect(message).toContain("Grade only this submitted answer");
    expect(message).toContain("do not substitute or reuse an answer from an earlier chat turn");
    expect(message).toContain("record_attempt exactly once");
    expect(message).toContain('render_lesson_widget exactly once with mode="feedback"');
    expect(message).toContain("Do not output the grading as ordinary chat text");
    expect(message).toContain("The feedback is not complete until render_lesson_widget succeeds");
    expect(message).toContain("do not generate another exercise, switch questions, or change words");
  });

  it("sends consolidation answers back through the same Lesson Widget without FSRS", () => {
    const message = buildLessonConsolidationSubmissionMessage({
      word: "shrink",
      activityType: "translation_en_to_cn",
      kind: "translation",
      prompt: "Although the sample began to shrink, the researchers continued monitoring it.",
      answer: "主干：researchers continued monitoring; 尽管样本开始缩小，研究人员仍继续监测。",
    });
    expect(message).toContain("周期巩固");
    expect(message).toContain("word 必须使用上面的精确锚点");
    expect(message).toContain("mode=feedback、consolidation=true");
    expect(message).toContain("record_attempt");
    expect(message).toContain("不推进 FSRS");
    expect(message).toContain("current submitted answer is authoritative");
    expect(message).toContain("record_attempt exactly once");
    expect(message).toContain("render_lesson_widget exactly once");
    expect(message).toContain("mode=feedback、consolidation=true");
    expect(message).toContain("Do not output feedback as ordinary chat text");
    expect(message).toContain("After the feedback Widget succeeds, remain silent in chat");
    expect(message).toContain("不要生成新题");
  });

  it("shows the backend next word, round wrap-up, or retry as the feedback next step", () => {
    const nextWord = renderToStaticMarkup(<LessonFeedbackNextStep
      canContinue
      navigation={{ action: "next_word", next_word: "query", next_index: 4, total_count: 10 }}
    />);
    expect(nextWord).toContain("下一词：query");

    const roundComplete = renderToStaticMarkup(<LessonFeedbackNextStep
      canContinue
      navigation={{ action: "round_complete", next_word: null, next_index: null, total_count: 10 }}
    />);
    expect(roundComplete).toContain("下一步：完成本轮并继续");
    expect(roundComplete).not.toContain("下一词：");

    const retry = renderToStaticMarkup(<LessonFeedbackNextStep
      canContinue={false}
      navigation={{ action: "round_complete", next_word: null, next_index: null, total_count: 10 }}
    />);
    expect(retry).toContain("下一步：重做当前题");
  });

  it("labels first-error guidance separately from a revealed explanation", () => {
    expect(feedbackGuidanceLabel(false)).toBe("错因与改法");
    expect(feedbackGuidanceLabel(true)).toBe("解释");
  });

  it("accepts future server metadata without dropping a valid feedback card", () => {
    const parsed = lessonPayloadSchema.safeParse({
      widget: "lesson",
      widget_version: LESSON_WIDGET_VERSION,
      mode: "feedback",
      phase: "lesson_feedback",
      current_index: 8,
      word: "shrink",
      progress: "9 / 9",
      navigation: { action: "round_complete", next_word: null, next_index: null, total_count: 9 },
      exercise: {
        activity_type: "sentence",
        instruction: "Use the word in a new scene.",
        prompt: "Describe a shrinking sample.",
        multiline: false,
      },
      feedback: { is_correct: true, user_answer: "The sample shrank.", reveal_answer: false },
      future_server_field: "x",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.future_server_field).toBe("x");
  });

  it("turns missing required payload data into a visible compatibility error", () => {
    const parsed = lessonPayloadSchema.safeParse({
      widget: "lesson",
      mode: "feedback",
      progress: "9 / 9",
      feedback: { is_correct: false, user_answer: "", reveal_answer: false },
    });
    expect(parsed.success).toBe(false);
    expect(LESSON_WIDGET_LOAD_ERROR).toBe("WordLoop 学习卡数据不完整，请重新进入学习。");
  });

  it("keeps the next lesson request locked while sending or after success", () => {
    expect(canStartNextLesson("idle")).toBe(true);
    expect(canStartNextLesson("error")).toBe(true);
    expect(canStartNextLesson("sending")).toBe(false);
    expect(canStartNextLesson("sent")).toBe(false);
  });

  it("lets backend cadence decide whether round completion has one consolidation", () => {
    expect(buildRoundCompleteMessage()).toBe([
      "WORDLOOP_ROUND_COMPLETE",
      "",
      "The server reports no periodic consolidation for this Lesson round.",
      "Call finish_study_session exactly once, then immediately call get_study_bootstrap.",
      "Do not generate any round-end exercise or infer cadence from chat history.",
    ].join("\n"));
    const translation = buildRoundCompleteMessage("shrink", { kind: "translation", trigger_round: 2, target_words: ["policy", "pressure"] });
    expect(translation).toContain("consolidation_kind=translation");
    expect(translation).toContain("activity_type=translation_en_to_cn");
    expect(translation).toContain("25–40-word formal English sentence");
    const sentence = buildRoundCompleteMessage("shrink", { kind: "sentence", trigger_round: 3, target_words: ["alleviate"] });
    expect(sentence).toContain("consolidation_kind=sentence");
    expect(sentence).toContain("activity_type=sentence");
    expect(sentence).toContain("15–30-word English sentence");
  });
});
