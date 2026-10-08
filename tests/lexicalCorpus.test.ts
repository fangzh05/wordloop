import { describe,it,expect } from "vitest";
import { buildNetworkCorpus } from "../scripts/lib/networkCorpus.js";
import { mergeGraphEvidence } from "../server/services/lexicalGraph.js";
import { mergeLexicalGraph } from "../web/src/family/LexicalExplorer.js";
import type { GraphEdge,LexicalGraph,LexicalWordNode } from "../shared/lexicalContracts.js";
import core from "../server/data/lexicalCore.json" with {type:"json"};
const xml=`<Lexicon id="oewn" version="2025">
<LexicalEntry><Lemma writtenForm="act" partOfSpeech="v"/><Sense id="act-do" synset="do"><SenseRelation relType="antonym" target="wait-stay"/></Sense><Sense id="act-perform" synset="perform"/></LexicalEntry>
<LexicalEntry><Lemma writtenForm="perform" partOfSpeech="v"/><Sense id="perform-do" synset="do"/></LexicalEntry>
<LexicalEntry><Lemma writtenForm="wait" partOfSpeech="v"/><Sense id="wait-stay" synset="stay"/></LexicalEntry>
<LexicalEntry><Lemma writtenForm="action" partOfSpeech="n"/><Sense id="action-n" synset="action"/></LexicalEntry>
<Synset id="do"><Definition>do something</Definition><SynsetRelation relType="hypernym" target="action"/></Synset>
<Synset id="perform"><Definition>perform on stage</Definition></Synset><Synset id="stay"><Definition>remain</Definition></Synset><Synset id="action"><Definition>an action</Definition></Synset></Lexicon>`;
const reviewed={etymons:[],etymological_links:[],senses:[],sense_relations:[],usage_patterns:[],lexeme_morphemes:[]};
const edge={relation_id:"one",source_id:"en:act:v",target_id:"en:perform:v",relation_type:"SYNONYM",direction:"undirected",explanation:"specific sense",source:"OEWN",source_version:"2025",license:"CC-BY-4.0",confidence:.95,provenance:{evidence:"synset"},source_sense_id:"act-do",target_sense_id:"perform-do"} as GraphEdge;
describe("verified corpus and bounded UI policy",()=>{
 it("maps explicit sense synonyms, antonyms and taxonomy, not whole polysemous lemmas",()=>{
  const c=buildNetworkCorpus(xml,["act"],reviewed);expect(c.sense_relations.find(r=>r.relation_type==="SYNONYM")).toMatchObject({source_sense_id:"act-do",target_sense_id:"perform-do"});
  expect(c.sense_relations.some(r=>r.source_sense_id==="act-perform")).toBe(false);expect(c.sense_relations.some(r=>r.relation_type==="ANTONYM")).toBe(true);
  expect(c.sense_relations.some(r=>r.relation_type==="HYPERNYM"&&r.direction==="forward")).toBe(true);
  expect(c.lexemes.filter(l=>l.lemma==="act")).toHaveLength(1);expect(c.sense_relations.every(r=>r.provenance.evidence&&r.provenance.sha256_xml)).toBe(true);
 });
 it("rebuilds stable IDs deterministically and rejects wrong editions",()=>{
  expect(buildNetworkCorpus(xml,["act"],reviewed)).toEqual(buildNetworkCorpus(xml,["act"],reviewed));expect(()=>buildNetworkCorpus(xml.replace('2025','2024'),["act"],reviewed)).toThrow();
 });
 it("merges reciprocal multi-source evidence while preserving different senses and edge types",()=>{
  const second={...edge,relation_id:"two",source:"Wiktionary",source_id:edge.target_id,target_id:edge.source_id,source_sense_id:edge.target_sense_id,target_sense_id:edge.source_sense_id};
  const merged=mergeGraphEvidence([edge,second,{...edge,relation_id:"other-sense",source_sense_id:"act-perform"},{...edge,relation_id:"ant",relation_type:"ANTONYM"},{...edge,source_id:edge.target_id}]);
  expect(merged).toHaveLength(3);expect(merged[0]!.provenance.additional_sources).toHaveLength(1);expect(edge.provenance).not.toHaveProperty("additional_sources");
 });
 it("limits browser accumulation to 40 nodes with valid deduplicated edges and preserved center",()=>{
  const n=(i:number)=>({node_id:`en:test${i}:n`,node_type:"lexeme",lemma:`test${i}`} as LexicalWordNode);
  const current={view:"root",center:n(0),nodes:Array.from({length:24},(_,i)=>n(i)),edges:[],depth:1,truncated:false} as LexicalGraph;
  const next={...current,center:n(23),nodes:Array.from({length:24},(_,i)=>n(i+23)),edges:[{...edge,source_id:n(23).node_id,target_id:n(46).node_id}]};
  const merged=mergeLexicalGraph(current,next);expect(merged.nodes).toHaveLength(40);expect(merged.truncated).toBe(true);expect(merged.center).toEqual(current.center);expect(merged.edges).toHaveLength(0);
  expect(mergeLexicalGraph(merged,next).nodes).toHaveLength(40);
 });
 it("core evidence is public, sourced, and patterns never enter canonical lexemes",()=>{
  expect(core.lexemes.some(l=>l.lemma.includes(" "))).toBe(false);
  for(const r of [...core.etymological_links,...core.sense_relations,...core.usage_patterns]){expect(r.source_version).toBeTruthy();expect(r.license).toBeTruthy();expect(r.provenance).toBeTruthy();expect(r).not.toHaveProperty("user_id");}
 });
});
