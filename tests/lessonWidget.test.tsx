import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildLessonSubmissionMessage,
  buildRoundCompleteMessage,
  canStartNextLesson,
  LESSON_WIDGET_LOAD_ERROR,
  LESSON_WIDGET_REFRESH_ERROR,
  LESSON_WIDGET_VERSION,
  isLessonRenderCandidate,
  lessonPayloadSchema,
  routeLessonAppEvent,
  LessonWidget,
} from "../web/src/lesson/LessonWidget.js";

describe("guided lesson widget", () => {
  it("has the three fixed modes and keeps exercise submission in the card", () => {
    const source = readFileSync(new URL("../web/src/lesson/LessonWidget.tsx", import.meta.url), "utf8");
    expect(source).toContain('z.discriminatedUnion("mode"');
    expect(source).toContain('z.literal("explain")');
    expect(source).toContain('z.literal("exercise")');
    expect(source).toContain('z.literal("feedback")');
    expect(source).toContain("modeForPhase");
    expect(source).toContain("提交 WordLoop 正式学习答案。");
    expect(source).toContain("reference_answer");
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

  it("gives the model a direct round-complete fact", () => {
    expect(buildRoundCompleteMessage()).toBe([
      "WORDLOOP_ROUND_COMPLETE",
      "",
      "The current Lesson round is complete.",
      "",
      "This is ROUND completion, not SESSION completion.",
      "",
      "Do exactly one round-end activity:",
      "generate one 考研英语一难度 long sentence naturally using",
      "2–3 words from this completed round.",
      "",
      "Ask the user to identify the sentence backbone first,",
      "then translate it.",
      "",
      "Do NOT start session-end free recall.",
      "Do NOT ask the user to list all learned words.",
      "Do NOT repeat this round-complete instruction.",
      "Do NOT render another vocabulary Lesson card.",
      "",
      "Only when the user explicitly says:",
      "结束学习 / 今天到这里 / 不学了",
      "",
      "enter session-end free recall.",
    ].join("\n"));
  });
});
