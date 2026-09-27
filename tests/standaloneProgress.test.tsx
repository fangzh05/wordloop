import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardProgressBlock } from "../web/src/dashboard/LearningDashboard.js";
import {
  StandaloneProgressBlock,
  StandaloneReviewFeedback,
  StandaloneReviewHeader,
  StandaloneReviewQuestion,
  todayTasksComplete,
} from "../web/src/standalone/StandaloneApp.js";

describe("shared Review and daily progress presentation", () => {
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
