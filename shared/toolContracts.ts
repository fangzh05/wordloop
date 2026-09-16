import { z } from "zod";

/** Canonical values shared by the server-side tool schemas and Widgets. */
export const DIRECTIONS = ["cn_to_en", "en_definition"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const directionSchema = z.enum(DIRECTIONS);

export const ERROR_LAYERS = ["meaning", "collocation", "grammar", "pronunciation", "spelling", "none"] as const;
export type ErrorLayer = (typeof ERROR_LAYERS)[number];
export const errorLayerSchema = z.enum(ERROR_LAYERS);

export const ACTIVE_ERROR_LAYERS = ["meaning", "collocation", "grammar", "pronunciation", "spelling"] as const;
export type ActiveErrorLayer = (typeof ACTIVE_ERROR_LAYERS)[number];
export const activeErrorLayerSchema = z.enum(ACTIVE_ERROR_LAYERS);

export const FSRS_RATINGS = ["again", "hard", "good", "easy"] as const;
export type FsrsRating = (typeof FSRS_RATINGS)[number];
export const fsrsRatingSchema = z.enum(FSRS_RATINGS);

export const ACTIVITY_TYPES = [
  "pretest_cn_to_en", "pretest_en_definition", "translation_cn_to_en",
  "translation_en_to_cn", "cloze", "derivation", "listening",
  "collocation", "sentence", "review", "recall",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const activityTypeSchema = z.enum(ACTIVITY_TYPES);

export const PRETEST_ACTIVITY_TYPES = ["pretest_cn_to_en", "pretest_en_definition"] as const;
export type PretestActivityType = (typeof PRETEST_ACTIVITY_TYPES)[number];
export const pretestActivityTypeSchema = z.enum(PRETEST_ACTIVITY_TYPES);

export const PRETEST_RESULTS = ["known", "uncertain", "unknown"] as const;
export type PretestResult = (typeof PRETEST_RESULTS)[number];
export const pretestResultSchema = z.enum(PRETEST_RESULTS);

export const STUDY_SESSION_EVENTS = [
  "pretest_question", "pretest_result", "listen_repeat", "listen_recall",
  "lesson_start_exercise", "lesson_retry",
] as const;
export type StudySessionEvent = (typeof STUDY_SESSION_EVENTS)[number];
export const studySessionEventSchema = z.enum(STUDY_SESSION_EVENTS);

export const REVIEW_KINDS = ["error_repair", "fsrs_due", "both"] as const;
export const reviewKindSchema = z.enum(REVIEW_KINDS);
export type ReviewKind = z.infer<typeof reviewKindSchema>;

function requireConcreteErrorLayer(
  value: { is_correct: boolean; error_layer: ErrorLayer },
  context: z.RefinementCtx,
): void {
  if (!value.is_correct && value.error_layer === "none") {
    context.addIssue({
      code: "custom",
      message: "Incorrect attempts require a concrete error_layer.",
      path: ["error_layer"],
    });
  }
}

/**
 * The one payload used for an atomic review submission before routing to the
 * due-card or error-repair tool. A deterministic spelling near miss is
 * intentionally `correct + hard + spelling`; it is not rewritten as an
 * incorrect `again` result.
 */
export const recordReviewSubmissionSchema = z.object({
  word: z.string().trim().min(1).max(100),
  user_answer: z.string().max(4000).default(""),
  is_correct: z.boolean(),
  error_layer: errorLayerSchema.default("none"),
  rating: fsrsRatingSchema,
  direction: directionSchema,
  session_id: z.string().uuid().optional(),
}).superRefine((value, context) => {
  requireConcreteErrorLayer(value, context);
  const isAllowedDeterministicNearMiss = value.is_correct
    && value.error_layer === "spelling"
    && value.rating === "hard"
    && value.direction === "cn_to_en";
  if (value.is_correct && value.error_layer !== "none" && !isAllowedDeterministicNearMiss) {
    context.addIssue({
      code: "custom",
      message: "A correct review may carry only none, except for a deterministic cn_to_en spelling near miss rated hard.",
      path: ["error_layer"],
    });
  }
});
export type RecordReviewSubmissionInput = z.output<typeof recordReviewSubmissionSchema>;

/** Ordinary persistence input; it never advances FSRS and therefore has no rating. */
export const recordAttemptSchema = z.object({
  word: z.string().trim().min(1).max(100),
  session_id: z.string().uuid().optional(),
  activity_type: activityTypeSchema,
  direction: directionSchema.optional(),
  user_answer: z.string().max(4000).default(""),
  is_correct: z.boolean(),
  error_layer: errorLayerSchema.default("none"),
}).superRefine(requireConcreteErrorLayer);
export type RecordAttemptInput = z.output<typeof recordAttemptSchema>;

export const recordPretestResultSchema = z.object({
  word: z.string().trim().min(1).max(100),
  result: pretestResultSchema,
  user_answer: z.string().max(2000).default(""),
  activity_type: pretestActivityTypeSchema.default("pretest_cn_to_en"),
});
export type RecordPretestResultInput = z.output<typeof recordPretestResultSchema>;

export const advanceStudySessionSchema = z.object({
  event: studySessionEventSchema,
  current_index: z.number().int().min(0).max(499).optional(),
}).strict();
export type AdvanceStudySessionInput = z.output<typeof advanceStudySessionSchema>;

export const getNextLearningWordSchema = z.object({
  current_word: z.string().trim().min(1).max(100),
});
export type GetNextLearningWordInput = z.output<typeof getNextLearningWordSchema>;

export const setDailyNewWordLimitSchema = z.object({
  limit: z.number().int().min(1).max(200),
});
export type SetDailyNewWordLimitInput = z.output<typeof setDailyNewWordLimitSchema>;

export const emptyToolArgsSchema = z.object({}).strict();
export type EmptyToolArgs = z.output<typeof emptyToolArgsSchema>;

/** Structured data sent in the Lesson Widget's follow-up message. */
export const lessonSubmissionSchema = z.object({
  word: z.string().min(1).max(100),
  activity_type: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4000),
  answer: z.string().max(4000),
});
export type LessonSubmissionInput = z.output<typeof lessonSubmissionSchema>;
