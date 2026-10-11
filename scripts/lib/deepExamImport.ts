import {z} from 'zod';
import {normalizeWord,wordInputSchema} from '../../server/services/wordNormalization.js';
import {sha256} from './examBooks.js';
export const deepSources={
 'ielts-xindongfang':'ielts','ielts-youdao':'ielts','ielts-youdao-luan':'ielts','ielts-niannian':'ielts','ielts-leiji':'ielts','ielts-jianqiao':'ielts',
 'toefl-xindongfang':'toefl','toefl-youdao':'toefl','toefl-gaopin':'toefl','toefl-kyle-expanded':'toefl',
} as const;
const sourceFamilies:Record<keyof typeof deepSources,{repo:string;family:string}>=Object.fromEntries(Object.keys(deepSources).map(id=>{
 const repo=id==='toefl-kyle-expanded'?'KyleBing/english-vocabulary':['ielts-niannian','toefl-gaopin'].includes(id)?'zhenghaoyang24/english-vocabulary':['ielts-leiji','ielts-jianqiao'].includes(id)?'lilinji/English':'KyleBing/dict';
 return [id,{repo,family:repo.startsWith('KyleBing/')?'youdao-lineage':repo.toLowerCase()}];
})) as Record<keyof typeof deepSources,{repo:string;family:string}>;
export const reviewResult=z.object({verdict:z.enum(['pass','needs_changes']),findings:z.array(z.object({risk:z.string(),recommendation:z.string()}))}).strict();
export const candidateReview=z.object({records:z.array(z.object({word:z.string(),decision:z.enum(['retain','hold','reject']),reason:z.string()})).max(100)}).strict();
type Row={word:string;normalized_word?:string;entry_key?:string;source_row:number;sheet?:string;source_locator?:string;definition_raw:string;senses:{pos:string;definition_cn:string;[k:string]:unknown}[];requires_human_review?:boolean;normalization_proposal?:string|null;[k:string]:unknown};
export type DeepBook={source:{repo:string;commit:string;path:string;sha256:string};exam:'ielts'|'toefl';derived?:boolean;records:Row[];name:string;version?:string};
export type DeepSnapshot={mode:'read-only';words:string[];dictionary_words:string[];members:{book_id:string;normalized_word:string}[]};
const posTokens=new Set(['n','noun','v','verb','vt','vi','a','adj','adjective','ad','adv','adverb','prep','preposition','pron','pronoun','conj','conjunction','num','int','interjection','art','article','aux','auxiliary','abbr','na','un','det']);
function formatIssue(r:Row){
 if(r.requires_human_review)return 'prior_review_hold';
 if(!wordInputSchema.safeParse(r.word).success||!/^[A-Za-z][A-Za-z'’ -]*$/.test(r.word.trim()))return 'invalid_identity';
 if(r.normalization_proposal)return 'normalization_requires_review';
 if(!r.definition_raw.trim()||!r.senses.some(s=>s.definition_cn.trim()))return 'missing_definition';
 if(r.senses.some(s=>s.pos.trim()&&!s.pos.toLowerCase().split(/[.&/\s]+/).filter(Boolean).every(t=>posTokens.has(t))))return 'invalid_part_of_speech';
 return null;
}
export function prepareDeepImport(books:Record<string,DeepBook>,snapshot:DeepSnapshot,legacy:{book_id:string;normalized_word:string;definitions:number;missing:number}[]=[]){
 if(snapshot.mode!=='read-only')throw Error('Read-only production snapshot required');
 const dict=new Set(snapshot.dictionary_words),global=new Set(snapshot.words),accepted:Record<string,Row[]>={},held:{source:string;word:string;row:number;reason:string}[]=[];
 const evidence=new Map<string,Set<string>>();
 for(const[id,b]of Object.entries(books)){
  if(!(id in deepSources)||deepSources[id as keyof typeof deepSources]!==b.exam)throw Error('Invalid internal source mapping');
  z.string().regex(/^[a-f0-9]{40}$/).parse(b.source.commit);z.string().regex(/^[a-f0-9]{64}$/).parse(b.source.sha256);
  if(b.source.repo.trim().toLowerCase()!==sourceFamilies[id as keyof typeof deepSources].repo.toLowerCase())throw Error('Unexpected source repository');
  if(b.derived||id==='toefl-kyle-expanded')continue;
  // Same upstream lexicon, including alphabetical/random editions, counts once.
  const family=sourceFamilies[id as keyof typeof deepSources].family;
  for(const r of b.records){if(formatIssue(r))continue;const w=normalizeWord(r.word),key=b.exam+'\0'+w;const set=evidence.get(key)??new Set<string>();set.add(family);evidence.set(key,set);}
 }
 for(const[id,b]of Object.entries(books)){
  const rows:Row[]=[];
  for(const raw of b.records){
   const w=normalizeWord(raw.word),locator=raw.source_locator??`${raw.sheet}:${raw.source_row}`;
   const optionalText=z.string().nullable().default(null);
   const r={...raw,ipa_uk:optionalText.parse(raw.ipa_uk),ipa_us:optionalText.parse(raw.ipa_us),chapter:optionalText.parse(raw.chapter),category:optionalText.parse(raw.category),normalized_word:w,source_locator:locator,entry_key:sha256(JSON.stringify([b.source.sha256,locator,raw.word]))};
   const reason=formatIssue(raw)??(
    b.derived||id==='toefl-kyle-expanded'?'derived_source_requires_relevance_review':!dict.has(w)&&(evidence.get(b.exam+'\0'+w)?.size??0)<2?'unverified_spelling_or_relevance':null);
   if(reason)held.push({source:id,word:w,row:r.source_row,reason});else rows.push({...r,requires_human_review:false});
  }accepted[id]=rows;
 }
 const all=Object.values(books).flatMap(b=>b.records.map(r=>normalizeWord(r.word))),pairs=[];
 const sets=Object.entries(books).map(([id,b])=>({id,words:new Set(b.records.map(r=>normalizeWord(r.word)))}));
 for(let i=0;i<sets.length;i++)for(let j=i+1;j<sets.length;j++)pairs.push({a:sets[i]!.id,b:sets[j]!.id,overlap:[...sets[i]!.words].filter(w=>sets[j]!.words.has(w)).length});
 const additions:{exam:string;word:string;sources:string[]}[]=[];
 const metrics=['ielts','toefl'].map(exam=>{
  const old=new Set(snapshot.members.filter(m=>m.book_id===exam).map(m=>m.normalized_word));
  const sourceBooks=Object.entries(books).filter(([,b])=>b.exam===exam);
  const raw=sourceBooks.flatMap(([,b])=>b.records.map(r=>normalizeWord(r.word))),unique=new Set(raw);
  const eligible=new Map<string,Set<string>>();
  for(const[id]of sourceBooks)for(const r of accepted[id]!){const ss=eligible.get(r.normalized_word!)??new Set<string>();ss.add(id);eligible.set(r.normalized_word!,ss);}
  // Explicit grandfathered evidence: these production source rows already passed
  // the earlier review, excluding all 85 held rows. Reuse; do not reclassify or import.
  if(exam==='ielts')for(const r of legacy)if(['ielts-zhenjing','ielts-wanglu-807-listening'].includes(r.book_id)&&r.missing<r.definitions){const ss=eligible.get(r.normalized_word)??new Set<string>();ss.add(r.book_id);eligible.set(r.normalized_word,ss);}
  for(const[word,sources]of eligible)if(!old.has(word))additions.push({exam,word,sources:[...sources].sort()});
  const added=[...eligible.keys()].filter(w=>!old.has(w));
  return {exam,current:old.size,raw_new_records:raw.length,normalized_new_unique:unique.size,overlap_with_current:[...unique].filter(w=>old.has(w)).length,cross_source_excess:raw.length-unique.size,
   new_source_candidates:[...unique].filter(w=>!old.has(w)).length,legacy_only_candidates:[...eligible.keys()].filter(w=>!unique.has(w)&&!old.has(w)).length,legacy_without_new_ecdict_evidence:added.filter(w=>!dict.has(w)&&[...eligible.get(w)!].every(s=>!(s in deepSources))).length,accepted_additions:added.length,final:old.size+added.length,
   pending_unique_new:[...new Set(held.filter(h=>deepSources[h.source as keyof typeof deepSources]===exam).map(h=>h.word))].filter(w=>!old.has(w)&&!eligible.has(w)).length,
   additions_with_private_definition:added.length,ecdict_covered_additions:added.filter(w=>dict.has(w)).length,new_shared_identities:added.filter(w=>!global.has(w)).length};
 });
 const contribution=Object.entries(books).map(([id,b])=>({source:id,exam:b.exam,raw:b.records.length,unique:new Set(b.records.map(r=>normalizeWord(r.word))).size,accepted_records:accepted[id]!.length,held_records:held.filter(h=>h.source===id).length,
  contributed_to_additions:additions.filter(a=>a.sources.includes(id)).length,new_definitions_on_existing_identity:accepted[id]!.filter(r=>global.has(r.normalized_word!)).length}));
 return {rules:'ielts-toefl-deep-v1',metrics,contribution,pairwise:pairs,additions,held,accepted,unique_new_global_words:new Set(additions.filter(a=>!global.has(a.word)).map(a=>a.word)).size,raw_unique_across_exams:new Set(all).size};
}
