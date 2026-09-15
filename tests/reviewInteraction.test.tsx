import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { gradeReviewCnToEn, ReviewQuestion, shouldAdvanceFsrs } from "../web/src/review/ReviewWidget.js";

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
  });
});
