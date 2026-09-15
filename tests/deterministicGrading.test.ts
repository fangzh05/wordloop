import { describe, expect, it } from "vitest";
import {
  assertGradeInvariants,
  editDistance,
  gradeExactCloze,
  gradeExactRecall,
  gradeSemanticAnswer,
  gradeTargetWord,
  gradingRoute,
  gradingRouteForDirection,
  isDeterministicActivityType,
  isDeterministicallyGraded,
  normalizeAnswer,
  GradeInvariantError,
} from "../web/src/grading/deterministic.js";

describe("deterministic grading module", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(normalizeAnswer("  RECUR  ")).toBe("recur");
  });

  it("computes edit distance symmetrically", () => {
    expect(editDistance("recur", "recur")).toBe(0);
    expect(editDistance("recure", "recur")).toBe(1);
    expect(editDistance("recur", "recure")).toBe(1);
    expect(editDistance("navigate", "recur")).toBeGreaterThan(1);
  });

  it("recognizes only the deterministic activity types", () => {
    expect(isDeterministicActivityType("pretest_cn_to_en")).toBe(true);
    expect(isDeterministicActivityType("listen_recall")).toBe(true);
    expect(isDeterministicActivityType("translation_cn_to_en")).toBe(false);
    expect(isDeterministicActivityType("sentence")).toBe(false);
    expect(isDeterministicActivityType("cloze")).toBe(false);
  });

  it("grades an exact match as correct and Good", () => {
    expect(gradeTargetWord(" RECUR ", "recur")).toMatchObject({
      is_correct: true,
      rating: "good",
      error_layer: "none",
    });
  });

  it("grades a single-edit miss as correct but Hard with a spelling layer", () => {
    expect(gradeTargetWord("recure", "recur")).toMatchObject({
      is_correct: true,
      rating: "hard",
      error_layer: "spelling",
    });
  });

  it("does not treat a short target's near miss as spelling", () => {
    const grade = gradeTargetWord("cat", "car");
    expect(grade.error_layer).not.toBe("spelling");
    expect(grade.is_correct).toBe(false);
  });

  it("flags a plausible wrong word as a meaning error", () => {
    expect(gradeTargetWord("navigate", "recur")).toMatchObject({
      is_correct: false,
      rating: "again",
      error_layer: "meaning",
    });
  });

  it("does not invent an error layer for an unusable answer", () => {
    expect(gradeTargetWord("", "recur").error_layer).toBe("none");
    expect(gradeTargetWord("??", "recur").error_layer).toBe("none");
  });

  it("never rates a non-exact match as Good", () => {
    for (const answer of ["", "recure", "navigate", "recurr", "rc"]) {
      expect(gradeTargetWord(answer, "recur").rating, `answer ${answer}`).not.toBe("good");
    }
  });
});

describe("grading router", () => {
  it("routes fixed-answer questions to code and open questions to the model", () => {
    expect(gradingRoute("pretest_cn_to_en")).toBe("deterministic");
    expect(gradingRoute("listen_recall")).toBe("deterministic");
    expect(gradingRoute("spelling")).toBe("deterministic");
    expect(gradingRoute("word_recall")).toBe("deterministic");
    expect(gradingRoute("exact_cloze")).toBe("deterministic_cloze");
    expect(gradingRoute("translation_cn_to_en")).toBe("semantic");
    expect(gradingRoute("sentence")).toBe("semantic");
    expect(gradingRoute("pretest_en_definition")).toBe("semantic");
    expect(gradingRoute("cloze")).toBe("semantic");
  });

  it("treats only non-semantic routes as deterministically graded", () => {
    expect(isDeterministicallyGraded("spelling")).toBe(true);
    expect(isDeterministicallyGraded("exact_cloze")).toBe(true);
    expect(isDeterministicallyGraded("cloze")).toBe(false);
    expect(isDeterministicallyGraded("sentence")).toBe(false);
  });

  it("routes a review card by its direction", () => {
    // review cn_to_en is a fixed-answer recall question; review en_definition is open.
    expect(gradingRouteForDirection("review", "cn_to_en")).toBe("deterministic");
    expect(gradingRouteForDirection("review", "en_definition")).toBe("semantic");
    expect(gradingRouteForDirection("review", undefined)).toBe("deterministic");
    expect(isDeterministicallyGraded("review", "cn_to_en")).toBe(true);
    expect(isDeterministicallyGraded("review", "en_definition")).toBe(false);
  });
});

describe("exact recall grader", () => {
  it("marks an exact match correct, Good, no error layer", () => {
    expect(gradeExactRecall(" Recur ", "recur")).toMatchObject({
      is_correct: true,
      rating: "good",
      error_layer: "none",
      graded_by: "deterministic",
    });
  });

  it("marks a near miss correct but Hard with a spelling layer", () => {
    expect(gradeExactRecall("recure", "recur")).toMatchObject({
      is_correct: true,
      rating: "hard",
      error_layer: "spelling",
      graded_by: "deterministic",
    });
  });

  it("marks a plausible wrong word incorrect, Again, meaning", () => {
    expect(gradeExactRecall("navigate", "recur")).toMatchObject({
      is_correct: false,
      rating: "again",
      error_layer: "meaning",
    });
  });

  it("refuses to invent an error layer for an unusable answer", () => {
    expect(gradeExactRecall("", "recur").error_layer).toBe("none");
    expect(gradeExactRecall("??", "recur").error_layer).toBe("none");
  });
});

describe("exact cloze grader", () => {
  it("accepts a persisted answer that matches", () => {
    expect(gradeExactCloze("Recur", ["recur", "reoccur"])).toMatchObject({
      is_correct: true,
      rating: "good",
      error_layer: "none",
      graded_by: "deterministic",
    });
  });

  it("does not accept a near miss as correct but reports it as a spelling error", () => {
    expect(gradeExactCloze("recure", ["recur"])).toMatchObject({
      is_correct: false,
      rating: "again",
      error_layer: "spelling",
    });
  });

  it("reports a genuinely wrong answer as a meaning error", () => {
    expect(gradeExactCloze("navigate", ["recur"])).toMatchObject({
      is_correct: false,
      rating: "again",
      error_layer: "meaning",
    });
  });

  it("reports an empty answer without inventing an error layer", () => {
    expect(gradeExactCloze("   ", ["recur"])).toMatchObject({
      is_correct: false,
      rating: "again",
      error_layer: "none",
    });
  });
});

describe("semantic grader", () => {
  it("normalizes a correct semantic verdict to no error layer and Good", () => {
    expect(gradeSemanticAnswer({
      isCorrect: true,
      errorLayer: "grammar",
      feedback: "意思对了。",
      advancesFsrs: true,
    })).toMatchObject({
      is_correct: true,
      error_layer: "none",
      rating: "good",
      graded_by: "semantic",
    });
  });

  it("keeps a concrete error layer on an incorrect verdict", () => {
    expect(gradeSemanticAnswer({
      isCorrect: false,
      errorLayer: "collocation",
      feedback: "搭配不自然。",
      advancesFsrs: true,
    })).toMatchObject({
      is_correct: false,
      error_layer: "collocation",
      rating: "again",
      graded_by: "semantic",
    });
  });

  it("omits the rating entirely when the practice must not advance FSRS", () => {
    const grade = gradeSemanticAnswer({
      isCorrect: true,
      feedback: "很好。",
      advancesFsrs: false,
    });
    expect("rating" in grade).toBe(false);
  });
});

describe("grade invariants", () => {
  const deterministicCorrect = gradeExactRecall("recur", "recur");
  const deterministicWrong = gradeExactRecall("navigate", "recur");

  it("rejects a failing retrieval rated anything but Again", () => {
    expect(() => assertGradeInvariants(
      { ...deterministicWrong, rating: "good" },
      { activity_type: "spelling", advancesFsrs: true },
    )).toThrow(GradeInvariantError);
  });

  it("rejects a correct grade rated Again", () => {
    expect(() => assertGradeInvariants(
      { ...deterministicCorrect, rating: "again" },
      { activity_type: "spelling", advancesFsrs: true },
    )).toThrow(GradeInvariantError);
  });

  it("rejects a correct grade carrying an error layer", () => {
    expect(() => assertGradeInvariants(
      { ...deterministicCorrect, error_layer: "spelling" },
      { activity_type: "spelling", advancesFsrs: true },
    )).toThrow(GradeInvariantError);
  });

  it("rejects a model verdict over a deterministic question", () => {
    expect(() => assertGradeInvariants(
      { ...gradeSemanticAnswer({ isCorrect: true, feedback: "x", advancesFsrs: true }) },
      { activity_type: "pretest_cn_to_en", advancesFsrs: true, direction: "cn_to_en" },
    )).toThrow(GradeInvariantError);
  });

  it("rejects a code verdict over a semantic question", () => {
    expect(() => assertGradeInvariants(
      deterministicCorrect,
      { activity_type: "sentence", advancesFsrs: true },
    )).toThrow(GradeInvariantError);
  });

  it("rejects a deterministic question reporting a language-level error layer", () => {
    expect(() => assertGradeInvariants(
      { is_correct: false, error_layer: "collocation", rating: "again", feedback: "x", graded_by: "deterministic" },
      { activity_type: "spelling", advancesFsrs: true },
    )).toThrow(GradeInvariantError);
  });

  it("rejects any rating on practice that must not advance FSRS", () => {
    expect(() => assertGradeInvariants(
      deterministicCorrect,
      { activity_type: "spelling", advancesFsrs: false },
    )).toThrow(GradeInvariantError);
  });

  it("requires a rating to advance a card", () => {
    expect(() => assertGradeInvariants(
      { is_correct: true, error_layer: "none", feedback: "x", graded_by: "deterministic" },
      { activity_type: "spelling", advancesFsrs: true, reviewSubmission: true },
    )).toThrow(GradeInvariantError);
  });

  it("accepts a well-formed due-review submission", () => {
    expect(() => assertGradeInvariants(
      deterministicCorrect,
      { activity_type: "review", advancesFsrs: true, reviewSubmission: true, direction: "cn_to_en" },
    )).not.toThrow();
  });

  it("rejects a model verdict on a cn_to_en review card", () => {
    expect(() => assertGradeInvariants(
      gradeSemanticAnswer({ isCorrect: true, feedback: "x", advancesFsrs: true }),
      { activity_type: "review", advancesFsrs: true, reviewSubmission: true, direction: "cn_to_en" },
    )).toThrow(GradeInvariantError);
  });

  it("accepts ordinary semantic practice without a rating, as the persistence gate constructs it", () => {
    // Mirrors how server/services/attempts.ts builds the verdict: graded_by is
    // derived from the route, never hardcoded. This is the regression test for
    // the bug that rejected every semantic record_attempt.
    for (const activityType of ["sentence", "cloze", "translation_cn_to_en", "derivation", "collocation", "recall"]) {
      const route = gradingRouteForDirection(activityType);
      const verdict = {
        is_correct: false,
        error_layer: "grammar" as const,
        feedback: "",
        graded_by: route === "semantic" ? ("semantic" as const) : ("deterministic" as const),
      };
      expect(() => assertGradeInvariants(verdict, { activity_type: activityType, advancesFsrs: false }), activityType).not.toThrow();
    }
  });

  it("accepts an en_definition review verdict carrying a language-level error layer", () => {
    // An en_definition card is graded semantically, so grammar/collocation are
    // legitimate layers. Hardcoding direction "cn_to_en" at the gate wrongly
    // rejected these.
    const route = gradingRouteForDirection("review", "en_definition");
    expect(route).toBe("semantic");
    expect(() => assertGradeInvariants(
      { is_correct: false, error_layer: "collocation", rating: "again", feedback: "", graded_by: route === "semantic" ? "semantic" : "deterministic" },
      { activity_type: "review", advancesFsrs: true, reviewSubmission: true, direction: "en_definition" },
    )).not.toThrow();
  });

  it("accepts a cn_to_en review attempt without a direction field the way error repair does", () => {
    // Error-repair review attempts omit direction; the gate then routes review
    // as deterministic recall, which matches how the widget grades cn_to_en.
    expect(() => assertGradeInvariants(
      { is_correct: false, error_layer: "meaning", feedback: "", graded_by: "deterministic" },
      { activity_type: "review", advancesFsrs: false },
    )).not.toThrow();
  });
});
