import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PretestQuestion } from "../web/src/pretest/PretestWidget.js";

const base = {
  ipa: "/rɪˈkɜːr/",
  part_of_speech: "v.",
  meaning_zh: "再次发生；复发",
};

describe("PretestQuestion", () => {
  it("renders Chinese meaning only for cn_to_en", () => {
    const markup = renderToStaticMarkup(<PretestQuestion item={{ ...base, word: "recur", direction: "cn_to_en" }} />);
    expect(markup).toContain("中 → 英");
    expect(markup).toContain("再次发生；复发");
    expect(markup).not.toContain("recur");
    expect(markup).not.toContain("/rɪˈkɜːr/");
  });

  it("renders the English word and part of speech for en_definition, never prompt or meaning", () => {
    const markup = renderToStaticMarkup(<PretestQuestion item={{
      ...base,
      word: "recur",
      direction: "en_definition",
      prompt: "Give an English definition for recur without using the word itself.",
    }} />);
    expect(markup).toContain("英 → 英");
    expect(markup).toContain("recur");
    expect(markup).toContain("v.");
    expect(markup).not.toContain("再次发生；复发");
    expect(markup).not.toContain("Give an English definition");
  });
});
