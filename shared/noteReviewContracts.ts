import { z } from "zod";

export const noteReviewRatingSchema = z.enum(["again", "good"]);

export const noteReviewEnabledRequestSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const noteReviewRatingRequestSchema = z.object({
  rating: noteReviewRatingSchema,
  expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expected_note_updated_at: z.string().datetime({ offset: true }),
  idempotency_key: z.string().uuid(),
}).strict();

export type NoteReviewRating = z.infer<typeof noteReviewRatingSchema>;

export interface NoteReviewCardJson {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: string | null;
}

export interface NoteReviewStateSummary {
  enabled: boolean;
  due: string | null;
  revision: number;
}

export interface NoteReviewStateResponse {
  note_id: string;
  enabled: boolean;
  due: string | null;
  revision: number | null;
  card: NoteReviewCardJson | null;
  rating?: NoteReviewRating;
  server_time?: string;
  replayed?: boolean;
}

export interface NoteReviewOccurrence {
  context_text: string;
  source_type: string;
  source_title: string | null;
  source_url: string | null;
  captured_at: string;
}

export interface NoteReviewItem {
  note_id: string;
  selected_text: string;
  note: string;
  note_updated_at: string;
  due: string;
  revision: number;
  latest_occurrence: NoteReviewOccurrence | null;
}

export interface NoteReviewListResponse {
  items: NoteReviewItem[];
  total: number;
  as_of: string;
}
