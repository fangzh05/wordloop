import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildLessonSubmissionMessage,
  buildRoundCompleteMessage,
  canStartNextLesson,
  LESSON_WIDGET_LOAD_ERROR,
  LESSON_WIDGET_VERSION,
  lessonPayloadSchema,
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
    expect(source).not.toContain("if (!parsed.success) return;");
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
    expect(LESSON_WIDGET_LOAD_ERROR).toBe("WordLoop 学习卡版本不兼容，请重新打开学习。");
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
      "The backend-owned frozen Lesson queue is complete.",
      "Do not call get_next_learning_word again.",
      "Do not select another vocabulary word.",
      "Continue directly with the configured end-of-round activity.",
    ].join("\n"));
  });
});
