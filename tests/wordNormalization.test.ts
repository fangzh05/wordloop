import { describe, expect, it } from "vitest";
import { parsePastedWords, prepareWordList } from "../server/services/wordNormalization.js";

describe("word imports", () => {
  it("deduplicates case-insensitively and preserves first-seen order", () => {
    expect(prepareWordList(["Empirical", " subtle ", "empirical", "rigorous"])).toEqual([
      { display: "Empirical", normalized: "empirical", position: 0 },
      { display: "subtle", normalized: "subtle", position: 1 },
      { display: "rigorous", normalized: "rigorous", position: 2 },
    ]);
  });

  it("ignores empty lines but rejects an empty import", () => {
    expect(() => prepareWordList(["", "   "])).toThrow("No valid words");
  });

  it("rejects malformed word entries", () => {
    expect(() => prepareWordList(["empirical123"])).toThrow();
  });

  it("parses spaces, newlines, commas, and semicolons", () => {
    expect(parsePastedWords("empirical subtle\nconstrain,plausible;rigorous")).toEqual([
      "empirical", "subtle", "constrain", "plausible", "rigorous",
    ]);
  });
});

