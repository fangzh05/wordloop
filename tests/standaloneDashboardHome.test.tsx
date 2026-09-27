import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  activeStudySummary,
  dashboardContinueBehavior,
  lessonDraftAnswerForWord,
  StandaloneDashboard,
  StandaloneReviewHeader,
  visibleStandalonePage,
} from "../web/src/standalone/StandaloneApp.js";
import type { WebApiResponse } from "../web/src/standalone/apiClient.js";

const progress = {
  today: { total: 50, known: 0, uncertain: 0, unknown: 0, completed: 0 },
  review_today: { completed: 18, total: 25, remaining: 7 },
  all_time: { total_words: 500, mastered: 120, learning: 350, error_book: 30 },
  fsrs: { due_now: 4, due_today: 11, tomorrow: 8, due_next_7_days: 38, average_stability: 12.4 },
  settings: { daily_new_word_limit: 50 },
};

function reviewView(): WebApiResponse {
  return {
    screen: "review",
    session_revision: "review-revision-18",
    state: {
      widget: "review",
      phase: "review_question",
      current_index: 18,
      current_word: "constrain",
      payload: { items: Array.from({ length: 25 }, (_, index) => ({ word: `word-${index}` })) },
    },
    progress,
  };
}

describe("Standalone Dashboard and Study navigation", () => {
  it("shows independent daily progress and resumes the active Review cursor from Dashboard", () => {
    const view = reviewView();
    const markup = renderToStaticMarkup(<StandaloneDashboard view={view} busy={false} onContinue={() => undefined} />);

    expect(visibleStandalonePage("dashboard", view.screen)).toBe("dashboard");
    expect(markup).toContain("今日复习");
    expect(markup).toContain("18 / 25");
    expect(markup).toContain("今日新词");
    expect(markup).toContain("0 / 50");
    expect(markup).toContain("当前学习");
    expect(markup).toContain("复习 · 第 19 / 25 题");
    expect(markup).toContain("错词");
    expect(markup).toContain("30");
    expect(markup).toContain("已掌握");
    expect(markup).toContain("120");
    expect(markup).toContain("当前到期");
    expect(markup).toContain("4");
    expect(markup).toContain("明日到期");
    expect(markup).toContain("8");
    expect(markup).toContain("未来 7 天");
    expect(markup).toContain("38");
    expect(activeStudySummary(view)).toBe("复习 · 第 19 / 25 题");
    expect(dashboardContinueBehavior(view.screen)).toBe("study");
    expect(view.session_revision).toBe("review-revision-18");
  });

  it("returns from Review with a local navigation target and keeps the same cursor", () => {
    const view = reviewView();
    const markup = renderToStaticMarkup(<StandaloneReviewHeader
      currentIndex={18}
      total={25}
      complete={false}
      onBack={() => undefined}
    />);

    expect(markup).toContain("← 返回");
    expect(markup).toContain("19 / 25");
    expect(visibleStandalonePage("study", view.screen)).toBe("study");
    expect(dashboardContinueBehavior(view.screen)).toBe("study");
    expect(view.state.current_index).toBe(18);
    expect(view.session_revision).toBe("review-revision-18");
  });

  it("restores a Lesson draft only for the same current word", () => {
    const stored = JSON.stringify({ word: "constrain", answer: "because..." });
    expect(lessonDraftAnswerForWord(stored, "constrain")).toBe("because...");
    expect(lessonDraftAnswerForWord(stored, "different-word")).toBeNull();
  });

  it("shows the active Pretest position and Lesson word on Dashboard", () => {
    const pretest: WebApiResponse = {
      ...reviewView(),
      screen: "pretest",
      state: {
        widget: "pretest",
        phase: "pretest",
        current_index: 2,
        payload: { items: Array.from({ length: 7 }, () => ({ word: "fixture" })) },
      },
    };
    const lesson: WebApiResponse = {
      ...reviewView(),
      screen: "lesson",
      state: { widget: "lesson", phase: "lesson_exercise", current_word: "constrain", payload: { mode: "exercise" } },
    };

    expect(activeStudySummary(pretest)).toBe("预测试 · 第 3 / 7 题");
    expect(activeStudySummary(lesson)).toBe("Lesson · constrain");
  });

  it("renders a done response as Dashboard and routes Continue through the backend action", () => {
    const doneView: WebApiResponse = {
      screen: "done",
      session_revision: null,
      state: {},
      progress,
    };
    const markup = renderToStaticMarkup(<StandaloneDashboard view={doneView} busy={false} onContinue={() => undefined} />);

    expect(visibleStandalonePage("study", doneView.screen)).toBe("dashboard");
    expect(activeStudySummary(doneView)).toBeNull();
    expect(dashboardContinueBehavior(doneView.screen)).toBe("continue");
    expect(markup).toContain("继续学习");
    expect(markup).not.toContain("今日学习完成");
    expect(markup).not.toContain("刷新进度");
  });
});
