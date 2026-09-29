import { z } from "zod";

export const captureSelectionTypeSchema = z.enum(["word", "phrase", "collocation", "sentence", "grammar"]);
export const canonicalCaptureStatusSchema = z.enum(["inbox", "saved", "dismissed", "converted"]);
export const captureStatusSchema = z.enum(["inbox", "saved", "learning", "archived"]);
export const canonicalCaptureSourceTypeSchema = z.enum(["lesson_example", "lesson_prompt", "review_question", "manual"]);
export const legacyCaptureSourceTypeSchema = z.enum(["lesson", "review", "pretest", "dashboard", "manual"]);

export type CaptureSelectionType = z.infer<typeof captureSelectionTypeSchema>;
export type CanonicalCaptureStatus = z.infer<typeof canonicalCaptureStatusSchema>;
export type CaptureStatus = z.infer<typeof captureStatusSchema>;
export type CaptureSourceType = z.infer<typeof canonicalCaptureSourceTypeSchema>;

export const captureListRequestSchema = z.object({
  status: captureStatusSchema.optional(),
  q: z.string().trim().max(120).default(""),
  cursor: z.string().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

export const captureCreateRequestSchema = z.object({
  selected_text: z.string().trim().min(1).max(500),
  context_text: z.string().max(1200).optional(),
  selection_type: captureSelectionTypeSchema.optional(),
  source_type: z.union([canonicalCaptureSourceTypeSchema, legacyCaptureSourceTypeSchema]).optional(),
  source_ref: z.string().max(256).nullable().optional(),
  source_title: z.string().max(200).nullable().optional(),
  source_url: z.string().max(2000).nullable().optional(),
  note: z.string().max(500).optional(),
  idempotency_key: z.string().uuid(),
}).strict();

export const captureUpdateRequestSchema = z.object({
  note: z.string().max(500).optional(),
  selection_type: captureSelectionTypeSchema.optional(),
  status: z.enum(["inbox", "saved", "archived", "dismissed"]).optional(),
}).strict().refine((value) => value.note !== undefined || value.status !== undefined || value.selection_type !== undefined, {
  message: "At least one capture field is required.",
});

export function toCanonicalCaptureStatus(status: CaptureStatus): CanonicalCaptureStatus {
  if (status === "learning") return "converted";
  if (status === "archived") return "dismissed";
  return status;
}

export function toCaptureStatus(status: CanonicalCaptureStatus): CaptureStatus {
  if (status === "converted") return "learning";
  if (status === "dismissed") return "archived";
  return status;
}

export function toCanonicalCaptureSource(value: z.infer<typeof canonicalCaptureSourceTypeSchema> | z.infer<typeof legacyCaptureSourceTypeSchema> | undefined): {
  source_type: CaptureSourceType;
  source_title: string | null;
} {
  if (!value) return { source_type: "manual", source_title: null };
  if (canonicalCaptureSourceTypeSchema.safeParse(value).success) {
    return { source_type: value as CaptureSourceType, source_title: null };
  }
  switch (value) {
    case "lesson": return { source_type: "lesson_example", source_title: "WordLoop · Lesson" };
    case "review": return { source_type: "review_question", source_title: "WordLoop · 复习" };
    case "pretest": return { source_type: "manual", source_title: "WordLoop · 预测试" };
    case "dashboard": return { source_type: "manual", source_title: "WordLoop · 今日" };
    default: return { source_type: "manual", source_title: null };
  }
}
