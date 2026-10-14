import { z } from "zod";

export const analyticsRangeSchema = z.enum(["7d", "30d", "90d"]);
export const analyticsSectionSchema = z.enum(["overview", "memory", "weakness", "activity"]);
export const vocabularyFilterSchema = z.enum(["not_started", "in_memory", "active_error", "due"]);

export const analyticsQuerySchema = z.object({
  section: analyticsSectionSchema,
  range: analyticsRangeSchema.default("30d"),
  cursor: z.string().max(160).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const vocabularyQuerySchema = z.object({
  q: z.string().trim().max(120).default(""),
  filters: z.array(vocabularyFilterSchema).max(4).default([]),
  cursor: z.string().max(160).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const dateRangeCoverageSchema = z.object({
  from: z.string(),
  through: z.string(),
  event_tables: z.array(z.string()),
  first_lesson_completion: z.literal("unavailable"),
});

const nonnegativeIntegerSchema = z.number().int().min(0);
export const todayOverviewSchema = z.object({
  as_of: z.string().datetime({ offset: true }),
  timezone: z.string().min(1),
  target_retention: z.number().finite().min(0).max(1),
  active_session: z.object({
    active: z.boolean(),
    phase: z.enum(["review", "pretest", "formal_learning", "idle"]),
    phase_detail: z.string().nullable(),
    started_at: z.string().datetime({ offset: true }).nullable(),
    updated_at: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  progress: z.object({
    review: z.object({
      completed: nonnegativeIntegerSchema,
      total: nonnegativeIntegerSchema,
      remaining: nonnegativeIntegerSchema,
      scope: z.enum(["active_session", "today_recorded_sessions"]),
    }).strict(),
    pretest: z.object({
      total: nonnegativeIntegerSchema,
      completed: nonnegativeIntegerSchema,
      known: nonnegativeIntegerSchema,
      uncertain: nonnegativeIntegerSchema,
      unknown: nonnegativeIntegerSchema,
    }).strict(),
    formal_learning: z.object({
      completed_words: nonnegativeIntegerSchema,
      completed_distinct_words: nonnegativeIntegerSchema,
      new_words: nonnegativeIntegerSchema,
      relearn_words: nonnegativeIntegerSchema,
    }).strict(),
  }).strict(),
  captures: z.object({ inbox_count: nonnegativeIntegerSchema }).strict(),
}).strict();

export const analyticsEnvelopeSchema = z.object({
  data: z.unknown(),
  as_of: z.string().datetime({ offset: true }),
  timezone: z.string().min(1),
  definition_version: z.literal("wordloop-analytics-v1"),
  coverage: z.record(z.string(), z.unknown()),
  next_cursor: z.string().nullable().optional(),
});

export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;
export type AnalyticsSection = z.infer<typeof analyticsSectionSchema>;
export type VocabularyFilter = z.infer<typeof vocabularyFilterSchema>;
export type AnalyticsEnvelope<T> = {
  data: T;
  as_of: string;
  timezone: string;
  definition_version: "wordloop-analytics-v1";
  coverage: Record<string, unknown>;
  next_cursor?: string | null;
};
