import { z } from "zod";
import type { ActiveErrorLayer } from "./toolContracts.js";

export const RELATION_TYPES = ["DERIVATION", "INFLECTION", "SYNONYM", "ANTONYM", "CONTRAST", "COLLOCATION", "CONFUSABLE", "HYPERNYM", "HYPONYM"] as const;
export type RelationType = typeof RELATION_TYPES[number];
export const FAMILY_NODE_LIMIT = 24;
export const FAMILY_VISIBLE_LIMIT = 40;
export const FAMILY_MIN_CONFIDENCE = 0.85;
export interface Lexeme {
  lexeme_id: string; lemma: string; language: string; part_of_speech: string;
  frequency_band: number | null; utility_score: number; exam_relevance: number; family_key: string;
}
export interface Sense { sense_id: string; lexeme_id: string; definition: string; synset_id: string | null; register: string | null; provenance?: Record<string, unknown> }
export interface Form { form_id: string; lexeme_id: string; surface_form: string; form_type: string; pronunciation: string | null }
export interface Morpheme { morpheme_id: string; surface: string; type: "prefix" | "root" | "suffix"; meaning: string }
export interface SourceMetadata { source: string; source_version: string; license: string; provenance: Record<string, unknown>; confidence: number }
export interface DictionaryGloss {
  label: string; part_of_speech: string | null; definition_zh: string | null; definition_en: string | null;
}
// A bilingual dictionary entry is lemma-level source material. Its translations
// are not asserted to align with individual OEWN synsets or derivation edges.
export interface LexicalDictionaryEntry extends SourceMetadata {
  entry_id: string; lemma: string; language: string; phonetic: string | null;
  english_definition: string; chinese_translation: string; parts_of_speech: DictionaryGloss[];
}
export interface LexicalRelation extends SourceMetadata {
  relation_id: string; source_id: string; target_id: string; relation_type: RelationType; direction: "forward" | "undirected";
  transparency: number; interference_risk: number; morphology: string | null;
}
export interface LearnerState {
  status: string; stability: number; reps: number; consecutive_correct: number;
  next_review_at: string | null; error_layers: ActiveErrorLayer[];
  // These are existing evidence observations, never invented mastery probabilities.
  layers: Record<ActiveErrorLayer, { needs_practice: boolean; correct_streak: number | null }>;
}
export interface FamilyNode extends Lexeme {
  senses: Sense[]; forms: Form[]; user_state: LearnerState | null; priority: number; reason: string;
  dictionary?: LexicalDictionaryEntry | null;
}
export interface FamilyGraph {
  center: FamilyNode; nodes: FamilyNode[]; edges: LexicalRelation[]; depth: 1; truncated: boolean;
  has_developing_member?: boolean;
}
export type FamilyStage = "A" | "B" | "C" | "D";
export interface FamilyCandidate {
  candidate: FamilyNode | null; relation: LexicalRelation | null; reason: string;
  eligible_now: boolean; stage: FamilyStage; utility: number | null;
}
export interface FamilyStep {
  target_id: string; activity_type: "derivation" | "collocation" | "word_recall";
  error_layer: ActiveErrorLayer; prompt: string; answer: string; explanation: string;
}
export interface FamilyLesson {
  base_id: string; target_id: string | null; stage: FamilyStage; explanation: string; steps: FamilyStep[];
}
export interface FamilySessionView {
  id: string; base: string; derivative: string | null; stage: FamilyStage; explanation: string;
  index: number; total: number; completed: boolean; activated: boolean;
  step: Omit<FamilyStep, "answer" | "explanation"> | null;
  feedback?: { is_correct: boolean; answer: string; explanation: string };
}
export const familyGraphQuerySchema = z.object({
  lexeme: z.string().trim().min(1).max(120), depth: z.coerce.number().int().min(1).max(1).default(1),
}).strict();
export const familyStartSchema = z.object({ lexeme: z.string().trim().min(1).max(120), request_id: z.string().uuid() }).strict();
export const familyDictionaryQuerySchema = z.object({ lemma: z.string().trim().min(1).max(120) }).strict();
export const familyAnswerSchema = z.object({ session_id: z.string().uuid(), index: z.number().int().min(0).max(8), answer: z.string().trim().min(1).max(500) }).strict();
