import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildReviewSubmission, gradeReviewCnToEn, isReviewCardAlreadyCompleteResult, ReviewQuestion, shouldAdvanceFsrs } from "../web/src/review/ReviewWidget.js";

const base = {
  meaning_zh: "再次发生；复发",
  part_of_speech: "v.",
  direction: "cn_to_en" as const,
  error_layers: ["meaning"] as const,
  is_due: true,
  review_kind: "both" as const,
  next_review_at: "2026-09-12T00:00:00Z",
};

describe("ReviewQuestion", () => {
  it("keeps the review prompt inside the card", () => {
    const markup = renderToStaticMarkup(<ReviewQuestion item={{ ...base, word: "recur", is_due: true }} />);
    expect(markup).toContain("中 → 英");
    expect(markup).toContain("再次发生；复发");
    expect(markup).toContain("v.");
    expect(markup).not.toContain("recur");
  });

  it("supports English definition review without exposing the Chinese meaning", () => {
    const markup = renderToStaticMarkup(<ReviewQuestion item={{ ...base, word: "recur", direction: "en_definition", error_layers: [], is_due: false, review_kind: "fsrs_due", next_review_at: "2026-09-20T00:00:00Z" }} />);
    expect(markup).toContain("英 → 英");
    expect(markup).toContain("recur");
    expect(markup).toContain("v.");
    expect(markup).not.toContain("再次发生；复发");
  });

  it("grades Chinese-to-English review locally", () => {
    expect(gradeReviewCnToEn(" RECUR ", "recur")).toMatchObject({ is_correct: true, rating: "good", error_layer: "none" });
    expect(gradeReviewCnToEn("recure", "recur")).toMatchObject({ is_correct: true, rating: "hard", error_layer: "spelling" });
    expect(gradeReviewCnToEn("navigate", "recur")).toMatchObject({ is_correct: false, rating: "again", error_layer: "meaning" });
  });

  it("uses the backend review kind without re-querying due state", () => {
    const source = readFileSync(new URL("../web/src/review/ReviewWidget.tsx", import.meta.url), "utf8");
    expect(shouldAdvanceFsrs("error_repair")).toBe(false);
    expect(shouldAdvanceFsrs("fsrs_due")).toBe(true);
    expect(shouldAdvanceFsrs("both")).toBe(true);
    expect(source).not.toContain('callServerTool("get_learning_context"');
    expect(source).not.toContain("dueByWord");
    expect(source).toContain("buildReviewSubmission");
    expect(source).toContain("callServerTool(reviewCall.name");
    expect(source).not.toContain('callServerTool("record_review_result"');
  });

  it("routes both no-answer persistence paths through the shared builder", () => {
    const source = readFileSync(new URL("../web/src/review/ReviewWidget.tsx", import.meta.url), "utf8");
    const markUnknown = source.slice(source.indexOf("async function markUnknown"), source.indexOf("function nextQuestion"));
    expect(source.match(/buildReviewSubmission\(reviewItem/g) ?? []).toHaveLength(1);
    expect(markUnknown).toContain("persistReviewDraft(item, index");
    expect(markUnknown).not.toContain("record_review_submission");
    expect(markUnknown).not.toContain("direction: item.direction");
  });

  it("builds the shared review call used by the UI", () => {
    const call = buildReviewSubmission(
      { word: "recur", direction: "cn_to_en", review_kind: "fsrs_due" },
      { user_answer: "recure", is_correct: true, error_layer: "spelling", rating: "hard" },
    );
    expect(call).toMatchObject({ name: "record_review_submission" });
    expect(call.arguments).toMatchObject({
      word: "recur",
      user_answer: "recure",
      is_correct: true,
      error_layer: "spelling",
      rating: "hard",
      direction: "cn_to_en",
    });
  });

  it("hides stale-widget due errors behind the completed-card message", () => {
    expect(isReviewCardAlreadyCompleteResult({
      isError: true,
      content: [{ type: "text", text: "Database operation failed: FSRS_CARD_NOT_DUE" }],
    })).toBe(true);
    expect(isReviewCardAlreadyCompleteResult({
      isError: true,
      content: [{ type: "text", text: "Database operation failed: another error" }],
    })).toBe(false);
    const source = readFileSync(new URL("../web/src/review/ReviewWidget.tsx", import.meta.url), "utf8");
    expect(source).toContain("这张卡已经完成复习。");
  });
});
