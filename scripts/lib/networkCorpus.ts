import { createHash } from "node:crypto";
import { readOewn } from "./familyCorpus.js";
import { normalizeLemma } from "../../server/services/familyPolicy.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const attr = (s: string, key: string) => s.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "";
/** Explicit OEWN senses and synsets only. Never infer synonyms from similarity. */
export function buildNetworkCorpus(xml: string, vocabulary: readonly string[], reviewed: any) {
  const o = readOewn(xml), wanted = new Set(vocabulary.map(normalizeLemma));
  const owners = new Map<string, { lexeme: string; synset: string }>();
  const members = new Map<string, string[]>();
  for (const e of o.entries.values()) for (const s of e.senses) {
    owners.set(s.id, { lexeme: e.id, synset: s.synset });
    members.set(s.synset, [...(members.get(s.synset) ?? []), s.id]);
  }
  const source = { source: "OEWN", source_version: "2025", license: "CC-BY-4.0 + Princeton-WordNet",
    provenance: { url: "https://en-word.net/static/english-wordnet-2025.xml.gz", sha256_xml: o.sha256,
      adaptation: "WordLoop canonical IDs; sense-level edges; confidence is an editorial threshold." } };
  const all = new Map<string, any>();
  const add = (a: string, b: string, type: string, raw: unknown) => {
    if (!owners.has(a) || !owners.has(b) || owners.get(a)!.lexeme === owners.get(b)!.lexeme) return;
    const directed = type === "HYPERNYM" || type === "HYPONYM";
    const [s, t] = directed ? [a, b] : [a, b].sort();
    const key = `${type}:${s}:${t}`;
    const prior = all.get(key);
    if (prior) { prior.provenance.evidence.push(raw); return; }
    all.set(key, { relation_id: `oewn-network:${hash(key).slice(0,24)}`, source_sense_id: s, target_sense_id: t,
      relation_type: type, direction: directed ? "forward" : "undirected", explanation: "仅对应来源所列词义。",
      ...source, confidence: .95, provenance: { ...source.provenance, evidence: [raw] } });
  };
  for (const [synset, ids] of members) for (let i=0;i<ids.length;i++) for (let j=i+1;j<ids.length;j++)
    add(ids[i]!, ids[j]!, "SYNONYM", { synset, source_sense_id: ids[i], target_sense_id: ids[j] });
  for (const m of xml.matchAll(/<Sense\b[^>]*?(?:\/>|>([\s\S]*?)<\/Sense>)/g)) {
    for (const r of (m[1] ?? "").matchAll(/<SenseRelation\b[^>]*\/>/g))
      if (attr(r[0], "relType") === "antonym") add(attr(m[0],"id"),attr(r[0],"target"),"ANTONYM",r[0]);
  }
  for (const m of xml.matchAll(/<Synset\b[^>]*>[\s\S]*?<\/Synset>/g)) for (const r of m[0].matchAll(/<SynsetRelation\b[^>]*\/>/g)) {
    const type = attr(r[0],"relType");
    if (!["hypernym","hyponym"].includes(type)) continue;
    const a = members.get(attr(m[0],"id")) ?? [], b = members.get(attr(r[0],"target")) ?? [];
    for (const s of a) for (const t of b) add(s,t,type.toUpperCase(),r[0]);
  }
  const roots = new Set([...o.entries.values()].filter(e=>wanted.has(e.lemma)).map(e=>e.id));
  const visible = new Set(roots);
  for (const r of all.values()) if (roots.has(owners.get(r.source_sense_id)!.lexeme) || roots.has(owners.get(r.target_sense_id)!.lexeme)) {
    visible.add(owners.get(r.source_sense_id)!.lexeme); visible.add(owners.get(r.target_sense_id)!.lexeme);
  }
  const relations = [...all.values()].filter(r=>visible.has(owners.get(r.source_sense_id)!.lexeme) || visible.has(owners.get(r.target_sense_id)!.lexeme));
  const ids = new Set([...visible,...relations.flatMap(r=>[owners.get(r.source_sense_id)!.lexeme,owners.get(r.target_sense_id)!.lexeme])]);
  const senseIds = new Set(relations.flatMap(r=>[r.source_sense_id,r.target_sense_id]));
  // Every reviewed endpoint must be real dictionary material, including all Root words.
  for (const l of reviewed.etymological_links) for (const id of [l.source_lexeme_id,l.target_lexeme_id]) if(id)ids.add(id);
  for (const s of reviewed.senses) ids.add(s.lexeme_id);
  const lexemes: any[]=[],senses: any[]=[],forms: any[]=[];
  for (const id of [...ids].sort()) {
    const e=o.entries.get(id); if(!e)throw new Error(`Missing OEWN lexeme ${id}`);
    lexemes.push({lexeme_id:id,lemma:e.lemma,language:"en",part_of_speech:e.pos,frequency_band:null,utility_score:.65,exam_relevance:.5,family_key:`lexical:${id}`});
    for(const s of e.senses) if(senseIds.has(s.id)||roots.has(id)) {
      const synset=o.synsets.get(s.synset); if(!synset?.definition)throw new Error(`Missing synset ${s.synset}`);
      senses.push({sense_id:s.id,lexeme_id:id,definition:synset.definition,synset_id:s.synset,register:null,...source,provenance:{...source.provenance,example_sentences:synset.examples}});
    }
    forms.push({form_id:`${id}:lemma`,lexeme_id:id,surface_form:e.lemma,form_type:"lemma",pronunciation:e.pronunciation,...source});
  }
  return {lexemes,senses:[...senses,...reviewed.senses],forms,morphemes:reviewed.morphemes??[],sense_relations:[...relations,...reviewed.sense_relations],
    etymons:reviewed.etymons,etymological_links:reviewed.etymological_links,usage_patterns:reviewed.usage_patterns,
    lexeme_morphemes:reviewed.lexeme_morphemes,report:{roots:vocabulary.length,lexemes:lexemes.length,sense_relations:relations.length,sha256_xml:o.sha256}};
}
