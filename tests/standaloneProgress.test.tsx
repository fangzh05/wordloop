import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DashboardProgressBlock } from "../web/src/dashboard/LearningDashboard.js";
import {
  StandaloneProgressBlock,
  StandaloneReviewFeedback,
  StandaloneReviewHeader,
  StandaloneReviewQuestion,
  deepSeekMessage,
  deferVisibilityBootstrap,
  lessonDraftAnswerForState,
  lessonDraftTransitioned,
  runForegroundRequest,
  standaloneLessonProgressLabel,
  todayTasksComplete,
} from "../web/src/standalone/StandaloneApp.js";

describe("shared Review and daily progress presentation", () => {
  it("defers visibility bootstrap until an active mutation releases the request lock", async () => {
    const requestInFlightRef = { current: false };
    const refreshPendingRef = { current: false };
    let finishMutation!: () => void;
    let bootstrapCalls = 0;
    const mutation = runForegroundRequest(requestInFlightRef, () => new Promise<void>((resolve) => {
      finishMutation = resolve;
    }), () => {
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        bootstrapCalls += 1;
      }
    });

    expect(requestInFlightRef.current).toBe(true);
    expect(deferVisibilityBootstrap(requestInFlightRef, refreshPendingRef)).toBe(true);
    expect(bootstrapCalls).toBe(0);
    finishMutation();
    await mutation;
    expect(bootstrapCalls).toBe(1);
    expect(requestInFlightRef.current).toBe(false);
  });

  it("drops a rapid second action before it can send another POST", async () => {
    const requestInFlightRef = { current: false };
    let finishPost!: () => void;
    let postCount = 0;
    const firstClick = runForegroundRequest(requestInFlightRef, () => {
      postCount += 1;
      return new Promise<void>((resolve) => { finishPost = resolve; });
    });
    const secondClick = await runForegroundRequest(requestInFlightRef, async () => {
      postCount += 1;
    });

    expect(secondClick.started).toBe(false);
    expect(postCount).toBe(1);
    finishPost();
    await firstClick;
    expect(postCount).toBe(1);
  });

  it("restores a Lesson draft only for the same word, phase, and prompt", () => {
    const stored = JSON.stringify({
      word: "electrician", phase: "lesson_exercise", prompt: "A team of ___ arrived.", answer: "electricians",
    });
    expect(lessonDraftAnswerForState(stored, "electrician", "lesson_exercise", "A team of ___ arrived."))
      .toBe("electricians");
    expect(lessonDraftAnswerForState(stored, "electrician", "lesson_exercise", "A different ___ arrived."))
      .toBeNull();
    expect(lessonDraftAnswerForState(stored, "electrician", "lesson_complete", "A team of ___ arrived."))
      .toBeNull();
    expect(lessonDraftAnswerForState(stored, "electricians", "lesson_exercise", "A team of ___ arrived."))
      .toBeNull();
    expect(lessonDraftTransitioned(
      { word: "electrician", phase: "lesson_exercise", prompt: "A team of ___ arrived." },
      { word: "electrician", phase: "lesson_exercise", prompt: "A team of ___ arrived." },
    )).toBe(false);
    expect(lessonDraftTransitioned(
      { word: "electrician", phase: "lesson_exercise", prompt: "A team of ___ arrived." },
      null,
    )).toBe(true);
  });

  it("keeps the stored answer across a failed Lesson request", () => {
    const source = readFileSync(new URL("../web/src/standalone/StandaloneApp.tsx", import.meta.url), "utf8");
    const dispatch = source.slice(source.indexOf("const dispatch = async"), source.indexOf("const retry ="));
    const catchBody = dispatch.slice(dispatch.indexOf("} catch (error)"), dispatch.lastIndexOf("} finally"));
    expect(catchBody).not.toContain('sessionStorage.removeItem("wordloop_draft")');
    expect(catchBody).not.toContain('setAnswer("")');
    expect(lessonDraftAnswerForState(
      JSON.stringify({ word: "electrician", phase: "lesson_exercise", prompt: "A team of ___ arrived.", answer: "electricians" }),
      "electrician", "lesson_exercise", "A team of ___ arrived.",
    )).toBe("electricians");
  });

  it("shows distinct DeepSeek errors for grading and generation", () => {
    expect(deepSeekMessage("DEEPSEEK_TIMEOUT", "grading")).toBe("批改超时，请重试");
    expect(deepSeekMessage("DEEPSEEK_HTTP_ERROR", "grading")).toBe("批改服务暂时不可用，请重试");
    expect(deepSeekMessage("DEEPSEEK_INVALID_OUTPUT", "grading")).toBe("批改结果格式异常，请重试");
    expect(deepSeekMessage("DEEPSEEK_TIMEOUT", "generation")).toBe("内容生成超时，请重试");
    expect(deepSeekMessage("DEEPSEEK_INVALID_OUTPUT", "generation")).toBe("生成内容格式异常，请重试");
  });

  it("shows Review re-learning in its own Lesson progress segment", () => {
    const relearn = ["pirate", "feeble", "intensive", "nerve"];
    const queue = [...relearn, "new-1", "new-2"];
    expect(standaloneLessonProgressLabel(relearn, queue, 2)).toBe("复习补学 · 3 / 4");
    expect(standaloneLessonProgressLabel(relearn, queue, 4)).toBe("新词学习 · 1 / 2");
    expect(standaloneLessonProgressLabel(
      ["grieve"],
      ["grieve", "embark", "shallow", "electrical", "chief", "delegate", "textile", "recall"],
      3,
    )).toBe("新词学习 · 3 / 7");
    expect(standaloneLessonProgressLabel(relearn, queue, 4, true)).toBe("本轮收尾");
  });

  it("shows part of speech and Chinese meaning on cn_to_en Review cards", () => {
    const markup = renderToStaticMarkup(<StandaloneReviewQuestion
      direction="cn_to_en"
      item={{ direction: "cn_to_en", part_of_speech: "adj.", meaning_zh: "虚弱的；脆弱的" }}
    />);
    expect(markup).toContain("中 → 英");
    expect(markup).toContain("adj.");
    expect(markup).toContain("虚弱的；脆弱的");
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("词性未标注");
  });

  it("does not carry the previous Review result into the next card", () => {
    const markup = renderToStaticMarkup(<StandaloneReviewFeedback
      notice="答案正确。"
      noticeIndex={18}
      currentIndex={19}
    />);
    expect(markup).not.toContain("答案正确");
    expect(renderToStaticMarkup(<StandaloneReviewFeedback
      notice="答案正确。"
      noticeIndex={18}
      currentIndex={18}
    />)).toContain("答案正确");
    expect(renderToStaticMarkup(<StandaloneReviewHeader currentIndex={18} total={25} complete={false} />))
      .toContain("19 / 25");
  });

  it("shows independent Review and new-word progress without a 0 / 0 label", () => {
    const review = renderToStaticMarkup(<DashboardProgressBlock
      title="今日复习" completed={18} total={25} emptyText="无到期复习"
    />);
    const newWords = renderToStaticMarkup(<StandaloneProgressBlock
      title="今日新词" completed={0} total={50} emptyText="暂无新词" detail="已完成"
    />);
    const noReview = renderToStaticMarkup(<DashboardProgressBlock
      title="今日复习" completed={0} total={0} emptyText="无到期复习"
    />);
    const noNewWords = renderToStaticMarkup(<StandaloneProgressBlock
      title="今日新词" completed={0} total={0} emptyText="暂无新词" detail="已完成"
    />);

    expect(review).toContain("18 / 25 已完成");
    expect(newWords).toContain("0 / 50");
    expect(noReview).toContain("无到期复习");
    expect(noReview).not.toContain("0 / 0");
    expect(noNewWords).toContain("暂无新词");
    expect(noNewWords).not.toContain("0 / 0");
  });

  it("marks today's tasks complete only when both independent totals are done", () => {
    expect(todayTasksComplete({
      review_today: { completed: 25, total: 25, remaining: 0 },
      today: { completed: 20, total: 50 },
    })).toBe(false);
    expect(todayTasksComplete({
      review_today: { completed: 25, total: 25, remaining: 0 },
      today: { completed: 50, total: 50 },
    })).toBe(true);
    expect(todayTasksComplete({
      review_today: { completed: 0, total: 0, remaining: 0 },
      today: { completed: 50, total: 50 },
    })).toBe(true);
    expect(todayTasksComplete({
      review_today: { completed: 25, total: 25, remaining: 0 },
      today: { completed: 0, total: 0 },
    })).toBe(false);
  });
});
