/** Versioned ontology. Labels are capabilities, not question formats. */
export const EVIDENCE_VERSION = "evidence-v1";
export const SKILLS = ["target_sense_retrieval", "target_word_spelling", "lexical_collocation", "verb_object_collocation", "noun_preposition_collocation", "adjective_complement_pattern", "morphological_family", "syntactic_word_use", "target_word_application", "target_sense_comprehension", "sentence_structure", "relative_clause_attachment", "concession_scope"] as const;
export type SkillId = typeof SKILLS[number];
export type EvidenceQuality = "OBSERVE" | "LEARN_ONLY" | "IGNORE";
export function isSkillId(value: string): value is SkillId { return (SKILLS as readonly string[]).includes(value); }

export const COST_VERSION = "static-v1";
export function activityCost(activity: string, scope?: string): number {
  if (scope === "consolidation") return 90;
  if (["collocation", "derivation"].includes(activity)) return 15;
  if (activity.startsWith("translation")) return 30;
  if (["sentence", "semantic_expression"].includes(activity)) return 45;
  return 8;
}
