import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonWidget } from "../web/src/lesson/LessonWidget.js";

describe("guided lesson widget", () => {
  it("has the three fixed modes and keeps exercise submission in the card", () => {
    const source = readFileSync(new URL("../web/src/lesson/LessonWidget.tsx", import.meta.url), "utf8");
    expect(source).toContain('["explain", "exercise", "feedback"]');
    expect(source).toContain("exercise_prompt");
    expect(source).toContain("提交 WordLoop 正式学习答案。");
    expect(source).toContain("reference_answer");
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
});
