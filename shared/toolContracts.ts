import { z } from "zod";

/** Canonical values shared by the server-side tool schemas and Widgets. */
export const LESSON_WIDGET_VERSION = 3;

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

/** Maximum number of cards in one immutable initial-review snapshot. */
export const REVIEW_SESSION_MAX = 200;

export const STUDY_SESSION_EVENTS = [
  "pretest_question", "pretest_result", "listen_repeat", "listen_recall",
  "pretest_complete",
  "lesson_start_exercise", "lesson_retry", "lesson_complete", "review_answer",
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

export const reviewAnswerSchema = z.object({
  event: z.literal("review_answer"),
  word: z.string().trim().min(1).max(100),
  is_correct: z.boolean(),
  current_index: z.number().int().min(0).max(REVIEW_SESSION_MAX),
}).strict();

export const advanceStudySessionSchema = z.object({
  event: studySessionEventSchema,
  current_index: z.number().int().min(0).max(499).optional(),
  word: z.string().trim().min(1).max(100).optional(),
  is_correct: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.event === "review_answer") {
    if (value.current_index === undefined) context.addIssue({ code: "custom", message: "Review answers require current_index.", path: ["current_index"] });
    if (value.word === undefined) context.addIssue({ code: "custom", message: "Review answers require word.", path: ["word"] });
    if (value.is_correct === undefined) context.addIssue({ code: "custom", message: "Review answers require is_correct.", path: ["is_correct"] });
    return;
  }
  if (value.word !== undefined || value.is_correct !== undefined) {
    context.addIssue({ code: "custom", message: "Only review_answer accepts word and is_correct.", path: ["event"] });
  }
});
export type AdvanceStudySessionInput = z.output<typeof advanceStudySessionSchema>;
export type ReviewAnswerInput = z.output<typeof reviewAnswerSchema>;

export const reviewWidgetItemSchema = z.object({
  word: z.string().trim().min(1).max(100),
  meaning_zh: z.string().trim().min(1).max(240),
  part_of_speech: z.string().trim().max(40).optional(),
  direction: directionSchema.default("cn_to_en"),
  error_layers: z.array(activeErrorLayerSchema).max(5).default([]),
  is_due: z.boolean(),
  review_kind: reviewKindSchema,
  next_review_at: z.string().nullable(),
}).strict();
export type ReviewWidgetItem = z.output<typeof reviewWidgetItemSchema>;

export const reviewWidgetPayloadSchema = z.object({
  widget: z.literal("review"),
  items: z.array(reviewWidgetItemSchema).min(1).max(REVIEW_SESSION_MAX),
  phase: z.enum(["review", "review_complete"]).optional(),
  current_index: z.number().int().min(0).max(REVIEW_SESSION_MAX).optional(),
  title: z.string().trim().min(1).max(100).optional(),
}).strict();
export type ReviewWidgetPayload = z.output<typeof reviewWidgetPayloadSchema>;

export const getNextLearningWordSchema = z.object({
  current_word: z.string().trim().min(1).max(100),
});
export type GetNextLearningWordInput = z.output<typeof getNextLearningWordSchema>;

/** Server-owned navigation for the persisted Lesson Widget payload. */
const lessonNextWordNavigationSchema = z.object({
  action: z.literal("next_word"),
  next_word: z.string().trim().min(1).max(100),
  next_index: z.number().int().min(0).max(REVIEW_SESSION_MAX),
  total_count: z.number().int().min(1).max(REVIEW_SESSION_MAX),
}).strict();

const lessonRoundCompleteNavigationSchema = z.object({
  action: z.literal("round_complete"),
  next_word: z.null(),
  next_index: z.null(),
  total_count: z.number().int().min(1).max(REVIEW_SESSION_MAX),
}).strict();

export const lessonNavigationSchema = z.discriminatedUnion("action", [
  lessonNextWordNavigationSchema,
  lessonRoundCompleteNavigationSchema,
]);
export type LessonNavigation = z.output<typeof lessonNavigationSchema>;

/**
 * Backend-owned Lesson progression result. `action` is authoritative so a
 * completed frozen queue is self-describing to both Widgets and the model.
 */
const nextLearningWordItemSchema = z.object({
  word: z.string().trim().min(1).max(100),
}).passthrough();

const nextLearningWordOutputItemSchema = z.object({
  word: z.string().trim().min(1).max(100),
});

const nextLearningWordNextSchema = z.object({
  action: z.literal("next_word"),
  next_word: nextLearningWordItemSchema,
  round_complete: z.literal(false),
});

const nextLearningWordCompleteSchema = z.object({
  action: z.literal("round_complete"),
  next_word: z.null(),
  round_complete: z.literal(true),
});

export const nextLearningWordResultSchema = z.discriminatedUnion("action", [
  nextLearningWordNextSchema,
  nextLearningWordCompleteSchema,
]);

/**
 * MCP's registerTool outputSchema API exposes an object schema. The
 * discriminated union above remains the authoritative runtime validator;
 * this object schema publishes all stable fields to tools/list while the
 * server handler returns only values accepted by the union.
 */
export const nextLearningWordOutputSchema = z.object({
  action: z.enum(["next_word", "round_complete"]),
  next_word: nextLearningWordOutputItemSchema.nullable(),
  round_complete: z.boolean(),
}).strict();
export type NextLearningWordResult = z.output<typeof nextLearningWordResultSchema>;

const legacyNextLearningWordResultSchema = z.object({
  next_word: nextLearningWordItemSchema.nullable(),
  round_complete: z.boolean(),
}).passthrough();

function throwNextLearningWordInvariant(): never {
  throw new Error("NEXT_LEARNING_WORD_INVARIANT");
}

/**
 * Normalize the current action-bearing result and the legacy action-less
 * result without weakening the next_word/round_complete invariants.
 */
export function normalizeNextLearningWordResult(value: unknown): NextLearningWordResult {
  const modern = nextLearningWordResultSchema.safeParse(value);
  if (modern.success) return modern.data;

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return throwNextLearningWordInvariant();
  }

  // Compatibility is limited to a genuinely missing action. An explicitly
  // supplied but invalid/conflicting action must never be repaired locally.
  if (Object.prototype.hasOwnProperty.call(value, "action")) {
    return throwNextLearningWordInvariant();
  }

  const legacy = legacyNextLearningWordResultSchema.safeParse(value);
  if (!legacy.success) return throwNextLearningWordInvariant();

  const normalized = nextLearningWordResultSchema.safeParse({
    ...legacy.data,
    action: legacy.data.round_complete ? "round_complete" : "next_word",
  });
  if (!normalized.success) return throwNextLearningWordInvariant();
  return normalized.data;
}

export function parseNextLearningWordResult(value: unknown): NextLearningWordResult {
  const parsed = nextLearningWordResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("NEXT_LEARNING_WORD_INVARIANT");
  return parsed.data;
}

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
