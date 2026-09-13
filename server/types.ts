export const WORD_STATUSES = ["new", "known", "uncertain", "unknown", "review", "mastered"] as const;
export type WordStatus = (typeof WORD_STATUSES)[number];

export const ACTIVITY_TYPES = [
  "pretest_cn_to_en", "pretest_en_definition", "translation_cn_to_en",
  "translation_en_to_cn", "cloze", "derivation", "listening",
  "collocation", "sentence", "review", "recall",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ERROR_LAYERS = ["meaning", "collocation", "grammar", "pronunciation", "spelling", "none"] as const;
export type ErrorLayer = (typeof ERROR_LAYERS)[number];
export type ActiveErrorLayer = Exclude<ErrorLayer, "none">;

export interface UserWordRow {
  id: string;
  user_id: string;
  word_id: string;
  status: WordStatus;
  source: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_reviewed_at: string | null;
  correct_count: number;
  wrong_count: number;
  consecutive_correct: number;
  meaning_error: boolean;
  collocation_error: boolean;
  grammar_error: boolean;
  pronunciation_error: boolean;
  spelling_error: boolean;
  mastered: boolean;
  next_review_at: string | null;
}

export interface VocabularyItem {
  word: string;
  display_word: string;
  status: WordStatus;
  source: string | null;
  consecutive_correct: number;
  wrong_count: number;
  mastered: boolean;
  next_review_at: string | null;
  error_layers: ActiveErrorLayer[];
}

export interface ProgressResult {
  today: { total: number; known: number; uncertain: number; unknown: number; completed: number };
  all_time: { total_words: number; mastered: number; learning: number; error_book: number };
}

