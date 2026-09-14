import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusButton } from "../web/src/components/FocusButton.js";

const root = new URL("../web/src/", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("widget capability boundaries", () => {
  it("uses one shared focus control and hides it in fullscreen", () => {
    const markup = renderToStaticMarkup(<FocusButton />);
    expect(markup).toContain("focus-button");
    expect(markup).toContain("⛶ 专注");
    expect(source("styles.css")).toContain(':root[data-display-mode="fullscreen"] .focus-button');
  });

  it("adds focus mode only to learning widgets", () => {
    for (const path of [
      "pretest/PretestWidget.tsx",
      "review/ReviewWidget.tsx",
      "lesson/LessonWidget.tsx",
      "dictation/DictationWidget.tsx",
      "pronunciation/PronunciationCards.tsx",
    ]) {
      expect(source(path)).toContain("FocusButton");
    }
    expect(source("dashboard/LearningDashboard.tsx")).not.toContain("FocusButton");
    expect(source("import/WordImport.tsx")).not.toContain("FocusButton");
  });

  it("keeps sampling out of non-semantic learning widgets", () => {
    for (const path of [
      "lesson/LessonWidget.tsx",
      "dictation/DictationWidget.tsx",
      "pronunciation/PronunciationCards.tsx",
      "dashboard/LearningDashboard.tsx",
      "import/WordImport.tsx",
    ]) {
      expect(source(path)).not.toContain("sampleHostText(");
      expect(source(path)).not.toContain("createSamplingMessage(");
    }
  });
});
