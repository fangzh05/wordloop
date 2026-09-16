import type { ActiveErrorLayer, ReviewKind } from "../shared/toolContracts.js";

export {
  ACTIVITY_TYPES,
  ACTIVE_ERROR_LAYERS,
  DIRECTIONS,
  ERROR_LAYERS,
  FSRS_RATINGS,
  REVIEW_KINDS,
  STUDY_SESSION_EVENTS,
} from "../shared/toolContracts.js";
export type {
  ActivityType,
  ActiveErrorLayer,
  Direction,
  ErrorLayer,
  FsrsRating,
  ReviewKind,
  ReviewWidgetItem,
  ReviewWidgetPayload,
  ReviewAnswerInput,
  StudySessionEvent,
} from "../shared/toolContracts.js";

export const WORD_STATUSES = ["new", "known", "uncertain", "unknown", "review", "mastered"] as const;
export type WordStatus = (typeof WORD_STATUSES)[number];

export const REVIEW_SOURCES = ["pretest", "review", "session_checkpoint"] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];
export const STUDY_WIDGETS = ["pretest", "lesson", "dictation", "review"] as const;
export type StudyWidget = (typeof STUDY_WIDGETS)[number];
export const STUDY_PHASES = [
  "pretest", "pretest_result", "listen_repeat", "listen_recall",
  "pretest_complete",
  "lesson_explain", "lesson_exercise", "lesson_feedback", "dictation",
  "review", "review_complete",
] as const;
export type StudyPhase = (typeof STUDY_PHASES)[number];
export interface LexicalSense {
  pos: string;
  definition_cn: string;
}

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
  fsrs_stability: number;
  fsrs_difficulty: number;
  fsrs_elapsed_days: number;
  fsrs_scheduled_days: number;
  fsrs_learning_steps: number;
  fsrs_reps: number;
  fsrs_lapses: number;
  fsrs_state: number;
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
  fsrs_stability: number;
  fsrs_difficulty: number;
  fsrs_scheduled_days: number;
  fsrs_state: number;
  ipa_us?: string | null;
  ipa_uk?: string | null;
  senses?: LexicalSense[];
}

export interface ReviewVocabularyItem extends VocabularyItem {
  is_due: boolean;
  review_kind: ReviewKind;
}

export interface StudyState {
  version: 1;
  date: string;
  widget: StudyWidget;
  phase: StudyPhase;
  current_word: string | null;
  current_index: number;
  retry_count: number;
  flow: StudyFlow;
  payload: Record<string, unknown>;
}

export interface StudyFlow {
  relearn_words: string[];
  /** Immutable server-owned Lesson queue for this study session. */
  lesson_words?: string[];
}

export interface StudySessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  new_words_count: number;
  review_words_count: number;
  state: StudyState | null;
  updated_at: string;
}

export interface ProgressResult {
  today: { total: number; known: number; uncertain: number; unknown: number; completed: number };
  all_time: { total_words: number; mastered: number; learning: number; error_book: number };
  fsrs: { due_now: number; due_today: number; tomorrow: number; due_next_7_days: number; average_stability: number };
  settings: { daily_new_word_limit: number };
}
