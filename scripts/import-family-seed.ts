import "dotenv/config";
import { readFileSync } from "node:fs";
import seed from "../server/data/familySeed.json" with { type: "json" };
import { getDatabase } from "../server/db.js";
import { lexemeId, normalizeLemma, normalizeRelation } from "../server/services/familyPolicy.js";
import type { LexicalRelation } from "../shared/familyContracts.js";

// Explicit offline admin action. Browser / LLM output never calls this importer.
const db = getDatabase();
const dataset: typeof seed = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : seed;
// Reject ambiguous conflicting records instead of silently losing source data.
const canonical = new Map<string, Record<string, unknown>>();
for (const row of dataset.lexemes) {
  const normalized = { ...row, lemma: normalizeLemma(row.lemma), lexeme_id: lexemeId(row.lemma, row.part_of_speech) };
  if (normalized.lexeme_id !== row.lexeme_id) throw new Error("Seed references must use canonical lexeme ids");
  const existing = canonical.get(normalized.lexeme_id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error("Conflicting canonical lexeme seed");
  canonical.set(normalized.lexeme_id, normalized);
}
for (const row of dataset.relations) {
  normalizeRelation(row as LexicalRelation);
  if (!canonical.has(row.source_id) || !canonical.has(row.target_id)) throw new Error("Relation references an absent canonical lexeme");
}
for (const [table, rows] of [
  ["lexical_lexemes", [...canonical.values()]], ["lexical_senses", dataset.senses], ["lexical_forms", dataset.forms],
  ["lexical_morphemes", dataset.morphemes], ["lexical_relations", dataset.relations],
] as const) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const result = await db.from(table).upsert(rows.slice(offset, offset + 500) as Array<Record<string, unknown>>);
    if (result.error) throw new Error(`Family seed import failed: ${table} (${result.error.code})`);
  }
  console.log(`${table}: ${rows.length}`);
}
console.log("Lexical data imported. No user_words, study queues or FSRS cards created.");
