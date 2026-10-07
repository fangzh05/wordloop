import "dotenv/config";
import seed from "../server/data/familySeed.json" with { type: "json" };
import { getDatabase } from "../server/db.js";
import { lexemeId, normalizeLemma, normalizeRelation } from "../server/services/familyPolicy.js";
import type { LexicalRelation } from "../shared/familyContracts.js";

// Explicit offline admin action. Browser / LLM output never calls this importer.
const db = getDatabase();
// Reject ambiguous conflicting records instead of silently losing source data.
const canonical = new Map<string, Record<string, unknown>>();
for (const row of seed.lexemes) {
  const normalized = { ...row, lemma: normalizeLemma(row.lemma), lexeme_id: lexemeId(row.lemma, row.part_of_speech) };
  if (normalized.lexeme_id !== row.lexeme_id) throw new Error("Seed references must use canonical lexeme ids");
  const existing = canonical.get(normalized.lexeme_id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error("Conflicting canonical lexeme seed");
  canonical.set(normalized.lexeme_id, normalized);
}
for (const row of seed.relations) normalizeRelation(row as LexicalRelation);
for (const [table, rows] of [
  ["lexical_lexemes", [...canonical.values()]], ["lexical_senses", seed.senses], ["lexical_forms", seed.forms],
  ["lexical_morphemes", seed.morphemes], ["lexical_relations", seed.relations],
] as const) {
  const result = await db.from(table).upsert(rows as Array<Record<string, unknown>>);
  if (result.error) throw new Error(`Family seed import failed: ${table} (${result.error.code})`);
  console.log(`${table}: ${rows.length}`);
}
console.log("Lexical data imported. No user_words, study queues or FSRS cards created.");
