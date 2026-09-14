import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewQuestion } from "../web/src/review/ReviewWidget.js";

const base = {
  meaning_zh: "再次发生；复发",
  part_of_speech: "v.",
  direction: "cn_to_en" as const,
  error_layers: ["meaning"] as const,
};

describe("ReviewQuestion", () => {
  it("keeps the review prompt inside the card", () => {
    const markup = renderToStaticMarkup(<ReviewQuestion item={{ ...base, word: "recur", is_due: true }} />);
    expect(markup).toContain("中 → 英");
    expect(markup).toContain("再次发生；复发");
    expect(markup).not.toContain("recur");
  });

  it("supports English definition review without exposing the Chinese meaning", () => {
    const markup = renderToStaticMarkup(<ReviewQuestion item={{ ...base, word: "recur", direction: "en_definition", error_layers: [], is_due: false }} />);
    expect(markup).toContain("英 → 英");
    expect(markup).toContain("recur");
    expect(markup).toContain("v.");
    expect(markup).not.toContain("再次发生；复发");
  });
});
