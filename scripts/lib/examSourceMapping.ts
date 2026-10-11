import {normalizeWord,wordInputSchema} from '../../server/services/wordNormalization.js';
import {csvRecords,ECDICT_SHA256,ECDICT_VERSION} from './ecdictCorpus.js';
import {sha256} from './examBooks.js';
export const exams=['cet4','cet6','kaoyan','ielts','toefl'] as const;
export type Exam=typeof exams[number];
export type MappingSnapshot={mode:'read-only';members:{book_id:string;normalized_word:string}[];sources:{book_id:string;normalized_word:string;definitions:number;missing:number}[];dictionary_words:string[];protected:Record<string,{count:number;md5:string}>;definition_hashes:unknown[]};
export function independentExamTags(csv:string){
 if(sha256(csv)!==ECDICT_SHA256)throw Error('Pinned ECDICT checksum mismatch');
 const rows=csvRecords(csv),headers=rows.next().value as string[];
 const wi=headers.indexOf('word'),ti=headers.indexOf('tag');if(wi<0||ti<0)throw Error('ECDICT headers missing');
 const tags=new Map<string,Set<string>>();
 for(const row of rows){if(row.length!==headers.length)throw Error('Malformed ECDICT record');const word=normalizeWord(row[wi]!);
  if(!wordInputSchema.safeParse(word).success)continue;
  const prior=tags.get(word)??new Set<string>();for(const t of row[ti]!.split(/\s+/))if(['cet4','ky'].includes(t))prior.add(t);if(prior.size)tags.set(word,prior);
 }return tags;
}
const targets:Record<string,Exam[]>={'cet6-xinghuo':['cet6'],'ielts-zhenjing':['ielts'],'ielts-wanglu-807-listening':['ielts'],'toefl-xindongfang':['toefl']};
export function planExamSourceMapping(snapshot:MappingSnapshot,tags:Map<string,Set<string>>){
 if(snapshot.mode!=='read-only')throw Error('Read-only snapshot required');
 const old=Object.fromEntries(exams.map(id=>[id,new Set(snapshot.members.filter(m=>m.book_id===id).map(m=>m.normalized_word))])) as Record<Exam,Set<string>>;
 const sets=new Map<string,Set<string>>(),evidence=new Map<string,Set<string>>();
 for(const s of snapshot.sources){
  if(!targets[s.book_id]||!wordInputSchema.safeParse(s.normalized_word).success||normalizeWord(s.normalized_word)!==s.normalized_word)throw Error('Unreviewed source identity');
  if(!Number.isInteger(s.definitions)||s.definitions<=0||!Number.isInteger(s.missing)||s.missing<0||s.missing>s.definitions)throw Error('Invalid source coverage');
  const words=sets.get(s.book_id)??new Set<string>();words.add(s.normalized_word);sets.set(s.book_id,words);
  if(s.missing===s.definitions)continue;
  const related=[...targets[s.book_id]!];if(tags.get(s.normalized_word)?.has('cet4'))related.push('cet4');if(tags.get(s.normalized_word)?.has('ky'))related.push('kaoyan');
  for(const exam of related){const key=exam+'\0'+s.normalized_word,ss=evidence.get(key)??new Set<string>();ss.add(s.book_id);evidence.set(key,ss);}
 }
 const additions=[...evidence].flatMap(([key,sources])=>{const[exam,word]=key.split('\0') as [Exam,string];return old[exam].has(word)?[]:[{exam,word,sources:[...sources].sort(),independent_tag:exam==='cet4'?'cet4':exam==='kaoyan'?'ky':null}];}).sort((a,b)=>a.exam.localeCompare(b.exam)||a.word.localeCompare(b.word));
 const union=new Set(snapshot.sources.map(s=>s.normalized_word)),dictionary=new Set(snapshot.dictionary_words);
 const finals=Object.fromEntries(exams.map(id=>[id,new Set([...old[id],...additions.filter(a=>a.exam===id).map(a=>a.word)])])) as Record<Exam,Set<string>>;
 const pairwise=[];for(const[a,words]of sets)for(const[b,other]of sets)if(a<b)pairwise.push({a,b,overlap:[...words].filter(w=>other.has(w)).length});
 return {rules:'five-exam-source-map-v1',independent_evidence:{source:'ECDICT',version:ECDICT_VERSION,sha256:ECDICT_SHA256},
  books:exams.map(id=>({id,old:old[id].size,net_new:additions.filter(a=>a.exam===id).length,final:finals[id].size,
   additions_without_public_definition:additions.filter(a=>a.exam===id&&!dictionary.has(a.word)).length})),
  contribution:[...sets].map(([source,words])=>({source,unique_words:words.size,exams:exams.map(exam=>({exam,eligible:[...evidence].filter(([k,v])=>k.startsWith(exam+'\0')&&v.has(source)).length,
   contribution_to_net_new:additions.filter(a=>a.exam===exam&&a.sources.includes(source)).length,intersection_before:[...words].filter(w=>old[exam].has(w)).length}))})),
  pairwise,unique_source_words:union.size,cross_source_excess:snapshot.sources.length-union.size,
  unmapped_words:[...union].filter(w=>!exams.some(id=>finals[id].has(w))).length,
  missing_source_definitions:snapshot.sources.filter(s=>s.missing===s.definitions).length,
  source_definition_records:snapshot.sources.reduce((n,s)=>n+s.definitions,0),
  source_coverage_by_exam:exams.map(id=>({id,members:finals[id].size,source_available_members:[...union].filter(w=>finals[id].has(w)&&snapshot.sources.some(s=>s.normalized_word===w&&targets[s.book_id]!.includes(id)&&s.missing<s.definitions)).length})),
  additions};
}
