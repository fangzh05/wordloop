import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildPronunciationRecallAdvance,
  classifyPronunciationRecall,
  effectivePretestDirection,
  gradeCnToEn,
  gradePretestAnswer,
  isExactPronunciationRecall,
  PRETEST_RECALL_CORRECT_ADVANCE_DELAY_MS,
  PRETEST_RECALL_ADVANCE_DELAY_MS,
  pretestActivityType,
  PretestQuestion,
  pronunciationIndexForSourceIndex,
  schedulePretestAdvance,
  selectPronunciationWords,
  sourceIndexForPronunciationWord,
} from "../web/src/pretest/PretestWidget.js";

const item = {
  word: "navigate",
  ipa: "/ˈnævɪɡeɪt/",
  part_of_speech: "v.",
  meaning_zh: "导航；航行",
  direction: "cn_to_en" as const,
};

describe("pretest capability fallback", () => {
  it("grades cn_to_en locally and never samples", async () => {
    const sample = vi.fn(async () => "{\"result\":\"unknown\",\"feedback\":\"不要调用\"}");
    const graded = await gradePretestAnswer(item, " NAVIGATE ", false, sample);

    expect(graded.result).toBe("known");
    expect(sample).not.toHaveBeenCalled();
  });

  it("marks a one-character typo as uncertain", () => {
    expect(gradeCnToEn("navigat", "navigate").result).toBe("uncertain");
  });

  it("falls back en_definition to the Chinese-to-English card without an error", () => {
    const fallbackDirection = effectivePretestDirection("en_definition", false);
    const markup = renderToStaticMarkup(<PretestQuestion item={{ ...item, direction: fallbackDirection }} />);

    expect(fallbackDirection).toBe("cn_to_en");
    expect(markup).toContain("中 → 英");
    expect(markup).toContain("导航；航行");
    expect(markup).not.toContain("不支持智能批改");
    expect(pretestActivityType(fallbackDirection)).toBe("pretest_cn_to_en");
  });

  it("keeps semantic grading when sampling is available", async () => {
    const semanticItem = { ...item, word: "recur", meaning_zh: "再次发生；复发", direction: "en_definition" as const };
    const sample = vi.fn(async (_prompt: string, _systemPrompt: string) => "{\"result\":\"known\",\"feedback\":\"表达了再次发生\"}");
    const graded = await gradePretestAnswer(semanticItem, "happen again", true, sample);

    expect(graded.result).toBe("known");
    expect(sample).toHaveBeenCalledTimes(1);
    expect(pretestActivityType(semanticItem.direction)).toBe("pretest_en_definition");
  });

  it("does not grade or persist a semantic answer when sampling disappears", async () => {
    const semanticItem = { ...item, word: "recur", meaning_zh: "再次发生；复发", direction: "en_definition" as const };
    const sample = vi.fn(async () => { throw new Error("Sampling unavailable."); });
    await expect(gradePretestAnswer(semanticItem, "happen again", true, sample)).rejects.toThrow("Sampling unavailable.");
    expect(sample).toHaveBeenCalledTimes(1);
  });
});

describe("pretest auto advance", () => {
  it("advances after about 600ms", () => {
    vi.useFakeTimers();
    try {
      const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
      let index = 0;
      schedulePretestAdvance(timerRef, () => { index += 1; });

      vi.advanceTimersByTime(599);
      expect(index).toBe(0);
      vi.advanceTimersByTime(1);
      expect(index).toBe(1);
      expect(timerRef.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("enters the completion page after the last item delay", () => {
    vi.useFakeTimers();
    try {
      const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
      let completed = false;
      schedulePretestAdvance(timerRef, () => { completed = true; });

      vi.advanceTimersByTime(600);
      expect(completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same delay when the user clicks 不会", () => {
    vi.useFakeTimers();
    try {
      const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
      let advanced = false;
      schedulePretestAdvance(timerRef, () => { advanced = true; });

      vi.advanceTimersByTime(600);
      expect(advanced).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("embedded pronunciation recall", () => {
  it("selects only uncertain and unknown words and compares recall locally", () => {
    const words = [
      item,
      { ...item, word: "recur" },
      { ...item, word: "subtle" },
    ];
    const pronunciationWords = selectPronunciationWords(words, [
      { word: "navigate", result: "known" },
      { word: "recur", result: "uncertain" },
      { word: "subtle", result: "unknown" },
    ]);

    expect(pronunciationWords.map((entry) => entry.word)).toEqual(["recur", "subtle"]);
    expect(isExactPronunciationRecall("  RECUR ", "recur")).toBe(true);
    expect(isExactPronunciationRecall("recurred", "recur")).toBe(false);
  });

  const mixedItems = [
    { ...item, word: "known" },
    { ...item, word: "first" },
    { ...item, word: "second" },
  ];
  const mixedResults = [
    { word: "known", result: "known" as const },
    { word: "first", result: "unknown" as const },
    { word: "second", result: "uncertain" as const },
  ];

  it("advances the first wrong recall answer to the second pronunciation word", () => {
    expect(classifyPronunciationRecall("not-first", "first")).toBe("wrong");
    expect(buildPronunciationRecallAdvance(mixedItems, mixedResults, 0)).toEqual({
      stage: "listen_repeat",
      pronunciationIndex: 1,
      sourceIndex: 2,
    });
  });

  it("lets an empty 不会 action use the same advancing transition", () => {
    expect(classifyPronunciationRecall("", "first", true)).toBe("wrong");
    expect(buildPronunciationRecallAdvance(mixedItems, mixedResults, 0)).toEqual({
      stage: "listen_repeat",
      pronunciationIndex: 1,
      sourceIndex: 2,
    });
  });

  it("enters ready after the last wrong recall answer", () => {
    expect(classifyPronunciationRecall("not-second", "second")).toBe("wrong");
    expect(buildPronunciationRecallAdvance(mixedItems, mixedResults, 1)).toEqual({
      stage: "ready",
      pronunciationIndex: 1,
      sourceIndex: mixedItems.length,
    });
  });

  it("keeps source indexes separate from the pronunciation subset indexes", () => {
    expect(selectPronunciationWords(mixedItems, mixedResults).map((entry) => entry.word)).toEqual(["first", "second"]);
    expect(sourceIndexForPronunciationWord(mixedItems, "second")).toBe(2);
    expect(pronunciationIndexForSourceIndex(mixedItems, mixedResults, 2)).toBe(1);
  });

  it("resumes listen_recall on the source word represented by the saved index", () => {
    const pronunciationWords = selectPronunciationWords(mixedItems, mixedResults);
    const restoredPronunciationIndex = pronunciationIndexForSourceIndex(mixedItems, mixedResults, 2);
    expect(pronunciationWords[restoredPronunciationIndex]?.word).toBe("second");
  });

  it("auto-advances failed recall within the required delay", () => {
    expect(PRETEST_RECALL_CORRECT_ADVANCE_DELAY_MS).toBe(600);
    expect(PRETEST_RECALL_ADVANCE_DELAY_MS).toBeGreaterThanOrEqual(600);
    expect(PRETEST_RECALL_ADVANCE_DELAY_MS).toBeLessThanOrEqual(1000);
    vi.useFakeTimers();
    try {
      const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
      let advanced = false;
      schedulePretestAdvance(timerRef, () => { advanced = true; }, PRETEST_RECALL_ADVANCE_DELAY_MS);
      vi.advanceTimersByTime(PRETEST_RECALL_ADVANCE_DELAY_MS - 1);
      expect(advanced).toBe(false);
      vi.advanceTimersByTime(1);
      expect(advanced).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
