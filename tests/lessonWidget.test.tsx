import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildLessonSubmissionMessage, LessonWidget } from "../web/src/lesson/LessonWidget.js";

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
    expect(source).toContain("get_next_learning_word");
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
});
