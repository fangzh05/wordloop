import { describe, expect, it } from "vitest";
import { dedupeShanbayWords, mapCurrentBook, mapShanbayWord } from "../server/integrations/shanbay/mapper.js";

describe("Shanbay mapping", () => {
  it("maps current book, IPA, and structured senses", () => {
    expect(mapCurrentBook({ materialbook_id: 42, materialbook: { name: "考研英语" } })).toMatchObject({ id: "42", name: "考研英语" });
    expect(mapShanbayWord({ vocabulary: { word: " Plausible ", senses: [{ pos: "adj", definition_cn: "看似合理的" }], sound: { ipa_us: "ˈplɔːzəbəl", ipa_uk: "ˈplɔːzəbl" } } }, "learning", 3)).toMatchObject({
      normalized: "plausible", ipa_us: "ˈplɔːzəbəl", senses: [{ pos: "adj", definition_cn: "看似合理的" }], source_state: "learning",
    });
  });
  it("deduplicates the same word across multiple book states", () => {
    const a = mapShanbayWord({ vocab_with_senses: { word: "Subtle" } }, "unlearned", 0);
    const b = mapShanbayWord({ vocab_with_senses: { word: "subtle" } }, "simple_learned", 1);
    expect(dedupeShanbayWords([a, b])).toHaveLength(1);
  });
});
