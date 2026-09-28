import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  StandaloneDashboard,
  StandaloneLessonHeader,
  StandaloneResponsiveLayout,
  StandaloneReviewHeader,
  standaloneLessonDisplayTitle,
} from "../web/src/standalone/StandaloneApp.js";
import type { WebApiResponse } from "../web/src/standalone/apiClient.js";

const styles = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

function reviewView(): WebApiResponse {
  return {
    screen: "review",
    session_revision: "responsive-review",
    state: {
      widget: "review",
      phase: "review_question",
      current_index: 18,
      payload: { items: Array.from({ length: 25 }, (_, index) => ({ word: `word-${index}` })) },
    },
    progress: {
      today: { total: 50, completed: 6 },
      review_today: { completed: 18, total: 25, remaining: 7 },
      all_time: { error_book: 30, mastered: 120 },
      fsrs: { due_now: 4, tomorrow: 8, due_next_7_days: 38 },
    },
  };
}

describe("Standalone responsive layout", () => {
  it("keeps a single Dashboard sidebar before one Study region and defines the desktop grid", () => {
    const markup = renderToStaticMarkup(
      <StandaloneResponsiveLayout
        page="study"
        view={reviewView()}
        busy={false}
        onContinue={() => undefined}
        hasMainContent
      >
        <section className="widget-card standalone-card" id="study-title">Review item</section>
      </StandaloneResponsiveLayout>,
    );

    expect(markup).toContain('class="standalone-layout"');
    expect(markup).toContain('class="standalone-sidebar"');
    expect(markup).toContain('class="standalone-main"');
    expect((markup.match(/aria-label="今日学习进度"/g) ?? [])).toHaveLength(1);
    expect((markup.match(/id="study-title"/g) ?? [])).toHaveLength(1);
    expect(markup).toContain("正在学习");
    expect(markup).not.toContain(">继续学习</button>");

    expect(styles).toMatch(/@media \(min-width: 900px\)[\s\S]*?\.standalone-layout\s*\{\s*display: grid;/);
    expect(styles).toContain("grid-template-columns: minmax(260px, 280px) minmax(0, 820px);");
    expect(styles).toContain("@media (min-width: 1200px)");
    expect(styles).toContain("grid-template-columns: minmax(300px, 320px) minmax(0, 820px);");
  });

  it("keeps the mobile back control in the DOM and hides it at the desktop breakpoint", () => {
    const markup = renderToStaticMarkup(
      <StandaloneReviewHeader currentIndex={18} total={25} complete={false} onBack={() => undefined} />,
    );

    expect(markup).toContain('class="standalone-back"');
    expect(styles).toContain(".standalone-back { display: inline-flex;");
    expect(styles).toMatch(/@media \(min-width: 900px\)[\s\S]*?\.standalone-study-heading \.standalone-back\s*\{\s*display: none;/);
  });

  it("hides the Lesson target word during exercises and uses the wrap-up label", () => {
    const exerciseTitle = standaloneLessonDisplayTitle("empire", true, false);
    const markup = renderToStaticMarkup(
      <StandaloneLessonHeader title={exerciseTitle} progressLabel="新词学习 · 6 / 6" onBack={() => undefined} />,
    );

    expect(markup).toContain("填空练习");
    expect(markup).not.toContain("empire");
    expect(standaloneLessonDisplayTitle("empire", true, true)).toBe("本轮收尾");
    expect(standaloneLessonDisplayTitle("empire", false, false)).toBe("empire");
  });

  it("shows a desktop Dashboard prompt without automatically entering Study", () => {
    const markup = renderToStaticMarkup(
      <StandaloneResponsiveLayout
        page="dashboard"
        view={reviewView()}
        busy={false}
        onContinue={() => undefined}
        hasMainContent={false}
      />,
    );

    expect(markup).toContain("选择继续学习以恢复当前任务");
    expect((markup.match(/aria-label="今日学习进度"/g) ?? [])).toHaveLength(1);
    expect((markup.match(/>继续学习<\/button>/g) ?? [])).toHaveLength(1);
    expect(markup).toContain('data-page="dashboard"');
  });

  it("keeps the Study column focused on loading or error content", () => {
    const markup = renderToStaticMarkup(
      <StandaloneResponsiveLayout
        page="dashboard"
        view={reviewView()}
        busy={false}
        onContinue={() => undefined}
        hasMainContent
      >
        <section role="alert">连接失败</section>
      </StandaloneResponsiveLayout>,
    );

    expect(markup).toContain("连接失败");
    expect(markup).not.toContain("选择继续学习以恢复当前任务");
    expect((markup.match(/aria-label="今日学习进度"/g) ?? [])).toHaveLength(1);
  });

  it("shows the active Lesson stage in the reused Dashboard sidebar", () => {
    const lesson = reviewView();
    lesson.screen = "lesson";
    lesson.state = {
      widget: "lesson",
      phase: "lesson_exercise",
      current_index: 5,
      current_word: "empire",
      flow: { relearn_words: [], lesson_words: ["empire", "harvest", "sustain", "vessel", "weary", "yield"] },
      payload: { mode: "exercise" },
    };
    const markup = renderToStaticMarkup(
      <StandaloneDashboard view={lesson} busy={false} onContinue={() => undefined} isStudying />,
    );

    expect(markup).toContain("Lesson · empire");
    expect(markup).toContain("新词学习 · 6 / 6");
    expect(markup).toContain("正在学习");
    expect(markup).not.toContain(">继续学习</button>");
  });

  it("preserves the requested responsive breakpoints and capped content widths", () => {
    expect(styles).toContain("max-width: 680px");
    expect(styles).toContain("@media (min-width: 900px)");
    expect(styles).toContain("@media (min-width: 1100px)");
    expect(styles).toContain("@media (min-width: 1200px)");
    expect(styles).toContain("max-width: 1240px");
    expect(styles).toContain("max-width: 820px");
    expect(styles).toContain("max-width: 68ch");
  });
});
