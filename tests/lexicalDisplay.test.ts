import { describe, expect, it } from "vitest";
import { formatMeaningByPartOfSpeech, formatPartOfSpeech, meaningIncludesPartOfSpeech } from "../shared/lexicalDisplay.js";

describe("formatPartOfSpeech", () => {
  it("keeps all unique dictionary parts of speech in source order", () => {
    expect(formatPartOfSpeech([
      { pos: " n. " },
      { pos: "v." },
      { pos: "N." },
      { pos: "adj." },
      { pos: " " },
    ])).toBe("n./v./adj.");
  });

  it("returns undefined when a word has no saved parts of speech", () => {
    expect(formatPartOfSpeech(undefined)).toBeUndefined();
    expect(formatPartOfSpeech([{ pos: " " }])).toBeUndefined();
  });
});

describe("formatMeaningByPartOfSpeech", () => {
  it("pairs definitions with their part of speech and groups senses", () => {
    expect(formatMeaningByPartOfSpeech([
      { pos: "v.", definition_cn: "分配" },
      { pos: "n.", definition_cn: "分配；拨款" },
      { pos: "v.", definition_cn: "拨出" },
    ])).toBe("v. 分配；拨出　n. 分配；拨款");
  });

  it("keeps unlabelled meanings and omits duplicate senses", () => {
    expect(formatMeaningByPartOfSpeech([
      { pos: "n.", definition_cn: "复发" },
      { pos: "n.", definition_cn: "复发" },
      { definition_cn: "再次发生" },
    ])).toBe("n. 复发　再次发生");
  });
});

describe("meaningIncludesPartOfSpeech", () => {
  it("detects when a Cn-to-En meaning already displays every POS", () => {
    expect(meaningIncludesPartOfSpeech("v. 分配　n. 分配；拨款", "v./n.")).toBe(true);
    expect(meaningIncludesPartOfSpeech("分配；拨款", "v./n.")).toBe(false);
  });
});
