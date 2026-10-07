import { createHash } from "node:crypto";
import { lexemeId, normalizeLemma } from "../../server/services/familyPolicy.js";

export const MORPHYNET_VERSION = "378144f64df58c78db5245af19d16a511ccecf3a";
export const MORPHYNET_URL = `https://raw.githubusercontent.com/kbatsuren/MorphyNet/${MORPHYNET_VERSION}/eng/eng.derivational.v1.tsv`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const decode = (s: string) => s.replace(/&(?:amp|quot|apos|lt|gt);/g, m => ({"&amp;":"&","&quot;":"\"","&apos;":"'","&lt;":"<","&gt;":">"})[m]!)
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => String.fromCodePoint(n.startsWith("x") ? parseInt(n.slice(1),16) : Number(n)));
const attr = (s: string, name: string) => decode(s.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "");
const valid = (s: string) => /^[a-z]+(?:[-'][a-z]+)*$/.test(s);
const pairKey = (a: string,b: string) => [a,b].sort().join("|");
type Evidence = Record<string, unknown>;
interface Entry { id: string; lemma: string; pos: string; senses: Array<{id: string; synset: string}>; pronunciation: string | null }
interface Pair { a: string; b: string; evidence: Evidence[] }
interface Synset { definition: string; examples: string[] }
export function readOewn(xml: string) {
  if (!xml.includes('version="2025"') || !xml.includes('id="oewn"')) throw new Error("Expected official OEWN 2025 XML");
  const entries = new Map<string,Entry>(), owners = new Map<string,string>(), raw: Array<{source: string; target: string; evidence: Evidence}> = [];
  for (const m of xml.matchAll(/<LexicalEntry\b[^>]*>[\s\S]*?<\/LexicalEntry>/g)) {
    const body=m[0], lemmaTag=body.match(/<Lemma\b[^>]*>/)?.[0]??"", lemma=normalizeLemma(attr(lemmaTag,"writtenForm")), pos=attr(lemmaTag,"partOfSpeech");
    if (!valid(lemma) || !["n","v","a","r"].includes(pos)) continue;
    const id=lexemeId(lemma,pos), entry=entries.get(id)??{id,lemma,pos,senses:[],pronunciation:decode(body.match(/<Pronunciation[^>]*variety="US"[^>]*>([^<]*)/)?.[1]??"")||null};
    for(const sense of body.matchAll(/<Sense\b[^>]*?(?:\/>|>([\s\S]*?)<\/Sense>)/g)) {
      const senseId=attr(sense[0],"id"); owners.set(senseId,id);
      entry.senses.push({id:senseId,synset:attr(sense[0],"synset")});
      for(const relation of (sense[1]??"").matchAll(/<SenseRelation\b[^>]*\/>/g)) if(attr(relation[0],"relType")==="derivation")
        raw.push({source:id,target:attr(relation[0],"target"),evidence:{source_sense_id:senseId,target_sense_id:attr(relation[0],"target"),raw_type:"derivation"}});
    }
    entries.set(id,entry);
  }
  const pairs=new Map<string,Pair>();
  for(const r of raw){const target=owners.get(r.target);if(!target||target===r.source)continue;const key=pairKey(r.source,target);const [a,b]=[r.source,target].sort();const p=pairs.get(key)??{a:a!,b:b!,evidence:[]};p.evidence.push(r.evidence);pairs.set(key,p);}
  const synsets=new Map<string,Synset>();
  for(const m of xml.matchAll(/<Synset\b[^>]*>[\s\S]*?<\/Synset>/g))synsets.set(attr(m[0],"id"),{definition:decode(m[0].match(/<Definition[^>]*>([\s\S]*?)<\/Definition>/)?.[1]??"").trim().slice(0,1000),examples:[...m[0].matchAll(/<Example[^>]*>([\s\S]*?)<\/Example>/g)].map(x=>decode(x[1]!).trim()).filter(x=>x.length<=500).slice(0,3)});
  return {entries,pairs,synsets,sha256:hash(xml)};
}
export function readMorphynet(tsv: string, oewn: ReturnType<typeof readOewn>) {
  const pairs=new Map<string,{source: string; target: string; affix: string; kind: "prefix"|"suffix"; evidence: Evidence[]}>();
  const rejected: Record<string,number> = {};
  const reject=(why: string)=>{rejected[why]=(rejected[why]??0)+1;};
  const posMap: Record<string,string>={N:"n",V:"v",J:"a",R:"r"};
  let line=0;
  for(const raw of tsv.split(/\r?\n/)) {line++;if(!raw.trim())continue;const fields=raw.split("\t");
    if(fields.length!==6){reject("malformed");continue;}
    const [base,derivative,bp,tp,affix,kind]=fields as [string,string,string,string,string,string];
    const a=normalizeLemma(base),b=normalizeLemma(derivative),apos=posMap[bp],bpos=posMap[tp];
    if(!valid(a)||!valid(b)||!apos||!bpos||!["prefix","suffix"].includes(kind)||!valid(normalizeLemma(affix))){reject("unsupported_form_or_pos");continue;}
    const source=lexemeId(a,apos),target=lexemeId(b,bpos);
    if(source===target){reject("self_relation");continue;}
    // Dictionary entry/POS validation excludes extraction mistakes and unlexicalized generated forms.
    if(!oewn.entries.has(source)||!oewn.entries.has(target)){reject("no_oewn_lexeme_or_pos");continue;}
    if(kind==="suffix"&&["s","es","ed","ing"].includes(affix)&&(!oewn.pairs.has(pairKey(source,target))||apos===bpos)){reject("ordinary_inflection");continue;}
    const key=`${source}>${target}`,p=pairs.get(key)??{source,target,affix,kind:kind as "prefix"|"suffix",evidence:[]};
    p.evidence.push({line,raw_fields:fields,wiktionary_entry:`https://en.wiktionary.org/wiki/${encodeURIComponent(derivative)}`});pairs.set(key,p);
  }
  return {pairs,rejected,sha256:hash(tsv)};
}
export function buildFamilyCorpus(xml: string, tsv: string, vocabulary: readonly string[], seed: any) {
  const o=readOewn(xml),m=readMorphynet(tsv,o),wanted=new Set(vocabulary.map(normalizeLemma));
  const all=new Map<string,any>();
  const oSource={source:"OEWN",source_version:"2025",license:"CC-BY-4.0 + Princeton-WordNet",provenance:{url:"https://en-word.net/static/english-wordnet-2025.xml.gz",sha256_xml:o.sha256}};
  const mSource={source:"MorphyNet/Wiktionary",source_version:MORPHYNET_VERSION,license:"CC-BY-SA-3.0",provenance:{url:MORPHYNET_URL,sha256_tsv:m.sha256,dataset:"MorphyNet English derivational v1",authors:"Khuyagbaatar Batsuren, Gábor Bella, Fausto Giunchiglia",normalization:"explicit derivational file; both lemmas/POS validated in OEWN; inflection guard v1",adaptation_license:"CC-BY-SA-3.0"}};
  for(const p of o.pairs.values()) all.set(`OEWN:${p.a}|${p.b}`,{relation_id:`oewn2025:${hash(pairKey(p.a,p.b)).slice(0,24)}`,source_id:p.a,target_id:p.b,relation_type:"DERIVATION",direction:"undirected",...oSource,provenance:{...oSource.provenance,evidence:p.evidence},confidence:.9,transparency:.5,interference_risk:.6,morphology:"OEWN 记录了派生关系；未指定现代英语构词方向。"});
  for(const p of m.pairs.values())all.set(`MorphyNet:${p.source}>${p.target}`,{relation_id:`morphynet:${hash(`${p.source}>${p.target}`).slice(0,24)}`,source_id:p.source,target_id:p.target,relation_type:"DERIVATION",direction:"forward",...mSource,provenance:{...mSource.provenance,evidence:p.evidence,oewn_corroborated:o.pairs.has(pairKey(p.source,p.target))},confidence:o.pairs.has(pairKey(p.source,p.target))?.95:.86,transparency:.75,interference_risk:.6,morphology:`${o.entries.get(p.source)!.lemma} → ${o.entries.get(p.target)!.lemma}：${p.kind==="prefix"?"前缀":"后缀"} ${p.kind==="prefix"?`${p.affix}-`:`-${p.affix}`}；${o.entries.get(p.source)!.pos} → ${o.entries.get(p.target)!.pos}。`});
  // Retain all lexical neighbours of the current vocabulary, then their neighbours for explicit expansion.
  // No graph is sent to the browser here and no learner state is constructed.
  const wantedIds=new Set([...o.entries.values()].filter(e=>wanted.has(e.lemma)).map(e=>e.id));
  const visible=new Set(wantedIds);
  for(const r of all.values())if(wantedIds.has(r.source_id)||wantedIds.has(r.target_id)){visible.add(r.source_id);visible.add(r.target_id);}
  const sourceKey=(r: any)=>[r.source_id,r.target_id,r.relation_type,r.source,r.source_version].join("|");
  const reviewedKeys=new Set(seed.relations.map(sourceKey));
  const relations=[...all.values()].filter(r=>(visible.has(r.source_id)||visible.has(r.target_id))&&!reviewedKeys.has(sourceKey(r)));
  const ids=new Set<string>(relations.flatMap(r=>[r.source_id,r.target_id]));
  // Public seed always preserved; old direction/teaching evidence wins visual duplicates.
  for(const r of seed.relations) relations.push(r);
  for(const l of seed.lexemes)ids.add(l.lexeme_id);
  const parent=new Map([...ids].map(id=>[id,id]));
  const root=(id: string): string=>{let r=id;while(parent.get(r)!==r)r=parent.get(r)!;while(parent.get(id)!==id){const next=parent.get(id)!;parent.set(id,r);id=next;}return r;};
  for(const r of relations)if(r.relation_type==="DERIVATION"){const a=root(r.source_id),b=root(r.target_id);if(a!==b)parent.set(a<b?b:a,a<b?a:b);}
  const seedKeys=new Map<string,string>();for(const l of seed.lexemes){const r=root(l.lexeme_id);seedKeys.set(r,[seedKeys.get(r),l.family_key].filter(Boolean).sort()[0]);}
  const lexemes=[...ids].sort().map(id=>{const e=o.entries.get(id);const old=seed.lexemes.find((l:any)=>l.lexeme_id===id);return {...(old??{lexeme_id:id,lemma:e!.lemma,language:"en",part_of_speech:e!.pos,frequency_band:null,utility_score:.65,exam_relevance:.5}),family_key:seedKeys.get(root(id))??`family:${root(id)}`};});
  const senses:any[]=[],forms:any[]=[];
  for(const id of [...ids].sort()) {const e=o.entries.get(id);if(!e)continue;for(const s of e.senses.slice(0,8)){const synset=o.synsets.get(s.synset);if(!synset?.definition)continue;senses.push({sense_id:s.id,lexeme_id:id,definition:synset.definition,synset_id:s.synset,register:null,...oSource,provenance:{...oSource.provenance,example_sentences:synset.examples}});}forms.push({form_id:`${id}:lemma`,lexeme_id:id,surface_form:e.lemma,form_type:"lemma",pronunciation:e.pronunciation,...oSource});}
  const connectedIds=new Set(relations.filter(r=>r.relation_type==="DERIVATION").flatMap(r=>[r.source_id,r.target_id]));
  const covered=new Set(lexemes.filter(l=>connectedIds.has(l.lexeme_id)).map(l=>l.lemma));
  const coverage=vocabulary.filter(w=>covered.has(normalizeLemma(w)));
  const missing=vocabulary.filter(w=>!covered.has(normalizeLemma(w)));
  return {lexemes,senses,forms,morphemes:seed.morphemes,relations,report:{vocabulary:vocabulary.length,covered:coverage.length,missing,lexemes:lexemes.length,relations:relations.length,oewn_pairs:o.pairs.size,morphynet_pairs:m.pairs.size,rejected:m.rejected,sources:{oewn:oSource,morphynet:mSource}}};
}
