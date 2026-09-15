/**
 * Unified grading layer for WordLoop.
 *
 * Problem this solves: grading used to happen in three unrelated places — the
 * review widget graded locally, the pretest widget graded locally, and lesson
 * practice (plus any path that posted straight to record_attempt) let the model
 * supply `is_correct` / `error_layer` / `rating` which the persistence layer
 * accepted verbatim. There was no single definition of what a grade is, no rule
 * about which question types may be graded by whom, and no invariant checking
 * before a grade reached durable state.
 *
 * The architecture is now:
 *
 *   question
 *     -> route by activity_type to a grader
 *          deterministic question -> deterministic grader (code)
 *          semantic question      -> semantic grader (model sampling)
 *     -> a single validated GradeResult
 *     -> assertGradeInvariants()
 *     -> record_attempt / record_review_submission
 *
 * Boundary: deterministic questions are decided by code; semantic questions are
 * decided by the model; learning state and FSRS decisions are always decided by
 * code. Grading authority never travels with the model's own claim.
 *
 * This module is intentionally free of React and of any host/MCP dependency so
 * that widgets, server code and tests can all share exactly one implementation.
 */

export const ERROR_LAYERS = ["meaning", "collocation", "grammar", "pronunciation", "spelling", "none"] as const;
export type ErrorLayer = (typeof ERROR_LAYERS)[number];

export const FSRS_RATINGS = ["again", "hard", "good", "easy"] as const;
export type FsrsRating = (typeof FSRS_RATINGS)[number];

/**
 * The single shape every grader produces. `rating` is optional on purpose:
 * ordinary lesson practice never carries an FSRS rating, and omission is how the
 * type system expresses "this must not advance FSRS".
 */
export interface GradeResult {
  is_correct: boolean;
  error_layer: ErrorLayer;
  rating?: FsrsRating;
  feedback: string;
  /** Which authority produced this verdict. Recorded, never trusted blindly. */
  graded_by: "deterministic" | "semantic";
}

/* ------------------------------------------------------------------ routing */

/** Questions whose answer is fixed and therefore decided by code. */
export const DETERMINISTIC_ACTIVITY_TYPES = [
  "pretest_cn_to_en",
  "listen_recall",
  "spelling",
  "word_recall",
  // A review card's cn_to_en direction is a recall question with a single fixed
  // answer — the target word — so it is graded in code, exactly like the review
  // widget already does. Without this the invariant gate would reject every
  // review submission. The en_definition direction stays semantic and is routed
  // by `gradingRouteForDirection` below.
  "review",
] as const;

export type DeterministicActivityType = (typeof DETERMINISTIC_ACTIVITY_TYPES)[number];

/** Questions with a single fixed string answer drawn from persisted state. */
export const DETERMINISTIC_CLOZE_ACTIVITY_TYPES = [
  "exact_cloze",
] as const;

/** Questions whose quality is a judgement call, left to the semantic grader. */
export const SEMANTIC_ACTIVITY_TYPES = [
  "translation_cn_to_en",
  "translation_en_to_cn",
  "cloze",
  "derivation",
  "listening",
  "collocation",
  "sentence",
  "recall",
  "pretest_en_definition",
] as const;

export type GradingRoute = "deterministic" | "deterministic_cloze" | "semantic";

export function gradingRoute(activityType: string): GradingRoute {
  if ((DETERMINISTIC_ACTIVITY_TYPES as readonly string[]).includes(activityType)) return "deterministic";
  if ((DETERMINISTIC_CLOZE_ACTIVITY_TYPES as readonly string[]).includes(activityType)) return "deterministic_cloze";
  return "semantic";
}

/**
 * `review` covers two directions with different authorities: cn_to_en is a
 * recall question decided by code, while en_definition is an open judgement
 * decided by the model. The invariant check therefore needs the direction to
 * resolve the route correctly for review submissions. Direction is inert for
 * every other activity type — a caller cannot launder a deterministic type
 * into a semantic one by attaching a direction to it.
 */
export function gradingRouteForDirection(
  activityType: string,
  direction?: "cn_to_en" | "en_definition",
): GradingRoute {
  if (activityType === "pretest_en_definition") return "semantic";
  if (activityType === "review" && direction === "en_definition") return "semantic";
  return gradingRoute(activityType);
}

export function isDeterministicallyGraded(activityType: string, direction?: "cn_to_en" | "en_definition"): boolean {
  return gradingRouteForDirection(activityType, direction) !== "semantic";
}

export function isDeterministicActivityType(value: string): value is DeterministicActivityType {
  return (DETERMINISTIC_ACTIVITY_TYPES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------- primitives */

export function normalizeAnswer(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function editDistance(left: string, right: string): number {
  const source = normalizeAnswer(left);
  const target = normalizeAnswer(right);
  let previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let row = 1; row <= source.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= target.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[column] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[column - 1] ?? Number.POSITIVE_INFINITY) + (source[row - 1] === target[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[target.length] ?? source.length;
}

/* ----------------------------------------------------------------- graders */

/**
 * Grader for "produce the target word" questions: cn_to_en recall, dictation
 * recall, spelling and word-form recall all reduce to this comparison.
 *
 * Exact match -> correct, Good.
 * One edit away and the target is long enough for that to be a real typo rather
 * than a different short word -> still correct, but Hard with a spelling layer,
 * because a near miss must be taught as a spelling problem and must not be
 * recorded as clean recall.
 * A plausible word that is simply not the target -> incorrect, Again, meaning.
 * Anything unusable (empty, punctuation, a stray fragment) -> incorrect, Again,
 * with no error layer, because there is no signal to name one.
 */
export function gradeExactRecall(answer: string, target: string): GradeResult {
  const cleanAnswer = normalizeAnswer(answer);
  const cleanTarget = normalizeAnswer(target);
  if (cleanAnswer && cleanAnswer === cleanTarget) {
    return { is_correct: true, error_layer: "none", rating: "good", feedback: "答案正确。", graded_by: "deterministic" };
  }
  if (cleanAnswer && cleanTarget.length > 3 && editDistance(cleanAnswer, cleanTarget) === 1) {
    return { is_correct: true, error_layer: "spelling", rating: "hard", feedback: "拼写接近目标词。", graded_by: "deterministic" };
  }
  const clearlyAnotherWord = /^[a-z]+$/.test(cleanAnswer)
    && cleanAnswer.length >= 3
    && cleanAnswer[0] !== cleanTarget[0];
  return {
    is_correct: false,
    error_layer: clearlyAnotherWord ? "meaning" : "none",
    rating: "again",
    feedback: clearlyAnotherWord ? "这不是目标词的正确含义。" : "答案不匹配，请再试一次。",
    graded_by: "deterministic",
  };
}

/**
 * Grader for fill-in-the-blank questions whose accepted answers are persisted,
 * not invented at grading time. Unlike exact recall there is no near-miss
 * tolerance: a fixed blank has a fixed answer, so an alternate spelling is not
 * accepted and is reported as a spelling error for teaching.
 */
export function gradeExactCloze(answer: string, accepted: readonly string[]): GradeResult {
  const cleanAnswer = normalizeAnswer(answer);
  if (!cleanAnswer) {
    return { is_correct: false, error_layer: "none", rating: "again", feedback: "未作答。", graded_by: "deterministic" };
  }
  const cleanAccepted = accepted.map(normalizeAnswer).filter(Boolean);
  if (cleanAccepted.includes(cleanAnswer)) {
    return { is_correct: true, error_layer: "none", rating: "good", feedback: "答案正确。", graded_by: "deterministic" };
  }
  const nearMiss = cleanAccepted.some((candidate) => candidate.length > 3 && editDistance(cleanAnswer, candidate) === 1);
  return {
    is_correct: false,
    error_layer: nearMiss ? "spelling" : "meaning",
    rating: "again",
    feedback: nearMiss ? "拼写接近正确答案。" : "答案不正确。",
    graded_by: "deterministic",
  };
}

/**
 * Grader for open-ended questions. The model supplies the semantic judgement;
 * this function's job is to normalise it into a GradeResult and to reject a
 * malformed verdict rather than letting it reach durable state.
 *
 * Ordinary lesson practice must pass `advancesFsrs: false` so that no rating is
 * attached and no FSRS advance can be inferred downstream.
 */
export function gradeSemanticAnswer(input: {
  isCorrect: boolean;
  errorLayer?: ErrorLayer;
  rating?: FsrsRating;
  feedback: string;
  advancesFsrs: boolean;
}): GradeResult {
  const errorLayer = input.isCorrect ? "none" : (input.errorLayer ?? "none");
  return {
    is_correct: input.isCorrect,
    error_layer: errorLayer,
    ...(input.advancesFsrs ? { rating: input.rating ?? (input.isCorrect ? "good" : "again") } : {}),
    feedback: input.feedback,
    graded_by: "semantic",
  };
}

/**
 * Narrows a full GradeResult to the shape the review widget consumes: every
 * recall verdict carries exactly one of the three FSRS ratings a card review can
 * produce, and never an "easy" or a missing rating.
 */
export type RecallGrade = GradeResult & {
  rating: "again" | "hard" | "good";
  error_layer: "none" | "spelling" | "meaning";
};

/**
 * Compatibility alias used by the review widget, which only ever needs the
 * recall grader and only ever reads a subset of the verdict. Keeping the name
 * means the review path keeps its existing behaviour and tests unchanged.
 */
export function gradeTargetWord(answer: string, target: string): RecallGrade {
  return gradeExactRecall(answer, target) as RecallGrade;
}

/* -------------------------------------------------------------- invariants */

export class GradeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradeInvariantError";
  }
}

export interface GradeContext {
  /** The activity type being graded, used to route the invariant rules. */
  activity_type: string;
  /** Whether this attempt is allowed to advance an FSRS card at all. */
  advancesFsrs: boolean;
  /** True only for the atomic due-review submission path. */
  reviewSubmission?: boolean;
  /** The persisted direction, when the question type has one. */
  direction?: "cn_to_en" | "en_definition";
}

/**
 * The single place that decides whether a GradeResult is allowed to be written.
 *
 * These rules exist because a wrong verdict here does not merely look bad, it
 * silently rewrites a learner's durable state: error-layer streaks, mastery, and
 * FSRS review intervals. Every rule below is enforced in code, never left to
 * prompt wording.
 */
export function assertGradeInvariants(grade: GradeResult, context: GradeContext): void {
  const route = gradingRouteForDirection(context.activity_type, context.direction);

  // A failed retrieval is always Again. There is no such thing as failing and
  // being scheduled as Good or Easy.
  if (!grade.is_correct && grade.rating && grade.rating !== "again") {
    throw new GradeInvariantError(`Incorrect grade must carry rating "again", received "${grade.rating}".`);
  }

  // Recall cannot succeed and still be rated Again; that would advance the card
  // as though the learner had failed.
  if (grade.is_correct && grade.rating === "again") {
    throw new GradeInvariantError('Correct grade must not carry rating "again".');
  }

  // A correct answer carries no error layer.
  if (grade.is_correct && grade.error_layer !== "none") {
    throw new GradeInvariantError(`Correct grade must use error_layer "none", received "${grade.error_layer}".`);
  }

  // Deterministic recall questions have exactly one authority. A semantic claim
  // over one of these is a routing bug, not a judgement call.
  if (route === "deterministic" && grade.graded_by !== "deterministic") {
    throw new GradeInvariantError(`Activity "${context.activity_type}" must be graded deterministically.`);
  }
  if (route === "semantic" && grade.graded_by !== "semantic") {
    throw new GradeInvariantError(`Activity "${context.activity_type}" must be graded semantically.`);
  }

  // A deterministic recall verdict cannot be replaced by the model.
  if (route === "deterministic" && context.direction === "cn_to_en" && grade.graded_by !== "deterministic") {
    throw new GradeInvariantError("cn_to_en exact recall must not be regraded by the model.");
  }

  // Deterministic spelling questions may only report spelling or meaning.
  // Collocation or grammar would describe a question that was never asked.
  if (route === "deterministic" && !["none", "spelling", "meaning"].includes(grade.error_layer)) {
    throw new GradeInvariantError(
      `Deterministic activity "${context.activity_type}" cannot report error_layer "${grade.error_layer}".`,
    );
  }

  // Ordinary lesson practice never advances FSRS, so it must not carry a rating.
  if (!context.advancesFsrs && grade.rating !== undefined) {
    throw new GradeInvariantError("Non-FSRS practice must not carry an FSRS rating.");
  }

  // Only the atomic due-review submission may advance a card.
  if (grade.rating !== undefined && !context.advancesFsrs) {
    throw new GradeInvariantError("Rating supplied without FSRS advance permission.");
  }
  if (context.reviewSubmission && grade.rating === undefined) {
    throw new GradeInvariantError("Review submission requires an FSRS rating.");
  }
}
