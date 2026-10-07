import { describe,it,expect } from "vitest";
import { readOewn,readMorphynet,buildFamilyCorpus } from "../scripts/lib/familyCorpus.js";
import { buildFamilyLesson } from "../server/services/familyLesson.js";
import { selectFamilyCandidate,localFamilyGraph } from "../server/services/familyPolicy.js";
import type { FamilyNode,LexicalRelation } from "../shared/familyContracts.js";
const xml=`<Lexicon id="oewn" version="2025">
<LexicalEntry><Lemma writtenForm="circulate" partOfSpeech="v"/><Sense id="c1" synset="cs"><SenseRelation target="n1" relType="derivation"/><SenseRelation target="s1" relType="similar"/></Sense></LexicalEntry>
<LexicalEntry><Lemma writtenForm="circulation" partOfSpeech="n"/><Sense id="n1" synset="ns"><SenseRelation target="c1" relType="derivation"/></Sense></LexicalEntry>
<LexicalEntry><Lemma writtenForm="spread" partOfSpeech="v"/><Sense id="s1" synset="ss"></Sense></LexicalEntry>
<LexicalEntry><Lemma writtenForm="circulates" partOfSpeech="v"/><Sense id="f1" synset="ss"></Sense></LexicalEntry>
<Synset id="cs"><Definition>move around</Definition><Example>They circulate the report.</Example></Synset>
<Synset id="ns"><Definition>movement of circulation</Definition><Example>Good circulation is vital.</Example></Synset>
<Synset id="ss"><Definition>move outwards</Definition></Synset></Lexicon>`;
const tsv="circulate\tcirculation\tV\tN\tion\tsuffix\ncirculate\tcirculates\tV\tV\ts\tsuffix\ncirculate\tspread\tV\tV\t\tsemantic\n";
const empty={lexemes:[],senses:[],forms:[],morphemes:[],relations:[]};
const stable={status:"review",stability:8,reps:3,consecutive_correct:3,error_layers:[],next_review_at:null,layers:{} as any};
function graph() {
 const data=buildFamilyCorpus(xml,tsv,["circulate"],empty);
 const nodes=data.lexemes.map(l=>({...l,senses:data.senses.filter(s=>s.lexeme_id===l.lexeme_id),forms:[],user_state:l.lemma==="circulate"?stable:null,priority:.65,reason:""})) as FamilyNode[];
 return localFamilyGraph(nodes.find(n=>n.lemma==="circulate")!,nodes,data.relations as LexicalRelation[]);
}
describe("Sourced family corpus import",()=>{
 it("reads self-closing WordNet senses and preserves asymmetric derivation targets",()=>{
  const data=readOewn('<Lexicon id="oewn" version="2025"><LexicalEntry><Lemma writtenForm="quart" partOfSpeech="n"/><Sense id="q1" synset="qs"/></LexicalEntry><LexicalEntry><Lemma writtenForm="quartic" partOfSpeech="a"/><Sense id="qa1" synset="qas"><SenseRelation relType="derivation" target="q1"/></Sense></LexicalEntry><Synset id="qs"><Definition>a unit of volume</Definition></Synset></Lexicon>');
  expect(data.entries.get("en:quart:n")!.senses).toEqual([{id:"q1",synset:"qs"}]);expect(data.pairs.size).toBe(1);
 });
 it("reads explicit derivation only, retains sense evidence, deduplicates reciprocal pairs",()=>{
  const data=readOewn(xml);expect(data.pairs.size).toBe(1);expect([...data.pairs.values()][0]!.evidence).toHaveLength(2);expect(data.synsets.get("ns")!.examples).toEqual(["Good circulation is vital."]);
 });
 it("validates MorphyNet POS against OEWN and excludes ordinary inflections and unsupported relation files",()=>{
  const data=readMorphynet(tsv,readOewn(xml));expect(data.pairs.size).toBe(1);expect(data.rejected.ordinary_inflection).toBe(1);expect(data.rejected.unsupported_form_or_pos).toBe(1);
  expect(readMorphynet("circulate\tcirculation\tN\tN\tion\tsuffix",readOewn(xml)).pairs.size).toBe(0);
 });
 it("does not infer a relation from spelling; case and whitespace reuse canonical nodes",()=>{
  const data=buildFamilyCorpus(xml,tsv,[" CIRCULATE ","spread"],empty);expect(data.report.covered).toBe(1);expect(data.lexemes.map(l=>l.lexeme_id)).toEqual(["en:circulate:v","en:circulation:n"]);
  for(const r of data.relations){expect(r.provenance.evidence.length).toBeGreaterThan(0);expect(r.source_version).toBeTruthy();expect(r.license).toBeTruthy();}
 });
 it("preserves public reviewed seed metadata and creates no learner state",()=>{
  const data=buildFamilyCorpus(xml,tsv,["circulate"],{...empty,lexemes:[{lexeme_id:"en:circulate:v",lemma:"circulate",language:"en",part_of_speech:"v",frequency_band:1,utility_score:.9,exam_relevance:.9,family_key:"reviewed"}]});
  expect(data.lexemes.find(l=>l.lemma==="circulate")!.utility_score).toBe(.9);expect(data.lexemes.every(l=>l.family_key==="reviewed")).toBe(true);expect(data).not.toHaveProperty("user_words");
 });
 it("uses explicit direction for selection; undirected source evidence is browsing knowledge",()=>{
  const g=graph();expect(selectFamilyCandidate(g,[],new Date("2026-10-07")).candidate?.lemma).toBe("circulation");
  const unknown={...g,edges:g.edges.map(e=>({...e,direction:"undirected" as const}))};expect(selectFamilyCandidate(unknown,[],new Date("2026-10-07")).eligible_now).toBe(false);
 });
 it("builds a non-fixture micro-session from the matching dictionary sense and sourced example without revealing recall answers",()=>{
  const g=graph(),lesson=buildFamilyLesson(g,selectFamilyCandidate(g,[],new Date("2026-10-07")));
  expect(lesson.target_id).toBe("en:circulation:n");expect(lesson.steps[1]!.prompt).toContain("Good ___ is vital.");expect(lesson.steps.at(-1)!.prompt).not.toContain("circulation");expect(lesson).not.toHaveProperty("target_meaning_zh");
 });
 it("falls back to dictionary retrieval when no source example exists, instead of fabricating a context",()=>{
  const g=graph();for(const n of g.nodes)for(const s of n.senses)s.provenance={};
  const lesson=buildFamilyLesson(g,selectFamilyCandidate(g,[],new Date("2026-10-07")));expect(lesson.steps[1]!.error_layer).toBe("meaning");expect(lesson.steps[1]!.prompt).not.toContain("circulation");
 });
});
