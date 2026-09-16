import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("WordLoop hot-path query boundaries", () => {
  it("uses the progress snapshot RPC instead of the full vocabulary scan", () => {
    const code = source("server/services/progress.ts");
    expect(code).toContain("get_progress_snapshot_v1");
    expect(code).not.toContain("getAllUserWords(");
    expect(code).not.toContain("getTodayWords(");
    expect(code).not.toContain("getDailyNewWordLimit(");
    expect(code).not.toContain("getUserTimeZone(");
  });

  it("uses review candidates from SQL and keeps learning context lightweight", () => {
    const review = source("server/services/review.ts");
    expect(review).toContain("get_review_candidates_v1");
    expect(review).toContain("get_due_review_candidates_v1");
    expect(review).toContain("selectDueReviewWords");
    expect(review).not.toContain("getAllUserWords(");
    expect(review).toContain("Promise.all");
  });

  it("restores pretest state through the small active-session response", () => {
    const pretest = source("web/src/pretest/PretestWidget.tsx");
    expect(pretest).toContain("buildPretestActiveSessionRequest()");
    expect(pretest).not.toContain('callServerTool("get_learning_context"');
  });

  it("does not put dashboard progress in model context or fetch it a second time", () => {
    const dashboard = source("web/src/dashboard/LearningDashboard.tsx");
    expect(dashboard).not.toContain("updateModelContext");
    expect(dashboard).not.toContain('callServerTool("get_progress"');
  });

  it("saves the daily limit and prepares the queue in one widget call", () => {
    const control = source("web/src/components/DailyNewWordControl.tsx");
    expect(control.match(/callServerTool\(/g) ?? []).toHaveLength(1);
    expect(control).toContain('callServerTool("set_daily_new_word_limit"');
    expect(control).not.toContain('callServerTool("prepare_daily_new_words"');
  });

  it("short-circuits bootstrap before review and queue work when a session is active", () => {
    const bootstrap = source("server/services/studyBootstrap.ts");
    const reviewCall = bootstrap.indexOf("const review = await getDueReviewSelection");
    expect(bootstrap).not.toContain("getAllUserWords(");
    expect(bootstrap.indexOf("if (active?.state)"))
      .toBeLessThan(reviewCall);
    expect(bootstrap).toContain("ensureTodayQueue(db, userId)");
    expect(bootstrap.indexOf("const queue = await ensureTodayQueue"))
      .toBeLessThan(reviewCall);
    expect(bootstrap).toContain("getTodayWords(queue.date, db, userId)");
  });

  it("ensures the daily queue before the dashboard reads progress", () => {
    const renderer = source("server/tools/renderWidgets.ts");
    expect(renderer).toContain("await ensureTodayQueue();");
    expect(renderer.indexOf("await ensureTodayQueue();"))
      .toBeLessThan(renderer.indexOf("await getProgress()"));
  });

  it("passes known lesson sessions through persistence and uses the pure queue selector", () => {
    const renderer = source("server/tools/renderWidgets.ts");
    expect(renderer).toContain("findNextLearningWord(queue, active.state.current_word)");
    expect(renderer).toContain("getSessionLearningQueue");
    expect(renderer).toContain("knownActive: active");
    expect(renderer).not.toContain("getNextLearningWord(active.state.current_word)");
  });
});
