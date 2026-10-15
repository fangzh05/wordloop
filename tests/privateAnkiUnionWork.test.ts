import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assertOfflineLessonQuality, buildPrivateUnionWork, safeReportPath } from "../scripts/import-anki-lesson-cache.js";

describe("private Anki union work list", () => {
  it("keeps the private WordLoop union complete and reuses only unambiguous Anki notes", () => {
    const wordRows = [
      { id: "word-alpha", normalized_word: "alpha", display_word: "alpha", senses: [{ pos: "n.", definition_cn: "首字母" }], ipa_us: null, ipa_uk: null },
      { id: "word-beta", normalized_word: "beta", display_word: "beta", senses: [{ pos: "v.", definition_cn: "使更好" }], ipa_us: null, ipa_uk: null },
      { id: "word-gamma-one", normalized_word: "gamma", display_word: "gamma", senses: [{ pos: "n.", definition_cn: "伽马" }], ipa_us: null, ipa_uk: null },
      { id: "word-gamma-two", normalized_word: "gamma", display_word: "gamma", senses: [{ pos: "n.", definition_cn: "第三项" }], ipa_us: null, ipa_uk: null },
    ];
    const records = [
      {
        normalized_word: "alpha", display_word: "alpha", source_note_id: "note-alpha", source_model_id: "model",
        source_fields: ["Word", "Meaning"], meaning_zh: "首字母", part_of_speech: "n.",
      },
      {
        normalized_word: "gamma", display_word: "gamma", source_note_id: "note-gamma", source_model_id: "model",
        source_fields: ["Word", "Meaning"], meaning_zh: "伽马",
      },
      {
        normalized_word: "orphan", display_word: "orphan", source_note_id: "note-orphan", source_model_id: "model",
        source_fields: ["Word", "Meaning"], meaning_zh: "孤儿",
      },
    ];

    const result = buildPrivateUnionWork(records, wordRows);

    expect(result.entries).toHaveLength(4);
    expect(result.matchedWords).toBe(1);
    expect(result.unmatchedAnkiRecords).toBe(2);
    const alpha = result.entries.find((entry) => entry.row.id === "word-alpha")!;
    const beta = result.entries.find((entry) => entry.row.id === "word-beta")!;
    const gamma = result.entries.filter((entry) => entry.row.normalized_word === "gamma");
    expect(alpha.ankiPresent).toBe(true);
    expect(alpha.material.meaning_zh).toBe(alpha.targetSense);
    expect(beta.ankiPresent).toBe(false);
    expect(beta.record.source_note_id).toBe("no-anki-record");
    expect(beta.material.source_fields).toEqual([]);
    expect(gamma.every((entry) => !entry.ankiPresent)).toBe(true);
    expect(gamma.every((entry) => entry.record.source_note_id === "ambiguous-anki-match")).toBe(true);
  });
});

describe("private Anki Lesson quality gate", () => {
  it("accepts only the canonical headword as a word-recall answer", () => {
    const valid = {
      exercise: { activity_type: "word_recall", accepted_answers: ["Abandon"], prompt: "放弃某项计划" },
    } as never;
    expect(() => assertOfflineLessonQuality(valid, "abandon", "word_recall")).not.toThrow();

    for (const accepted_answers of [["a", "an"], ["abandon", "abandons"], ["abandoner"]]) {
      const invalid = { exercise: { activity_type: "word_recall", accepted_answers } } as never;
      expect(() => assertOfflineLessonQuality(invalid, "a", "word_recall"))
        .toThrow("WORD_RECALL_ACCEPTED_ANSWER_NOT_CANONICAL");
    }
  });
});

describe("private Anki import report path", () => {
  it("accepts absolute and relative report paths outside the checkout only", () => {
    const privateDir = resolve(tmpdir(), "wordloop-private-lesson-cache-tests");
    const relativePath = resolve(privateDir, "run-report.json");
    const absolutePath = resolve(privateDir, "absolute-report.json");

    expect(safeReportPath("run-report.json", privateDir)).toBe(relativePath);
    expect(safeReportPath(absolutePath, privateDir)).toBe(absolutePath);
    expect(() => safeReportPath("should-not-be-written.json", process.cwd()))
      .toThrow("REPORT_MUST_STAY_OUTSIDE_CHECKOUT");
  });
});
