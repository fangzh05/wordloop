import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {csvRecords,buildEcdictCorpus,ECDICT_SHA256} from './lib/ecdictCorpus.js';
import {sha256} from './lib/examBooks.js';
import {normalizeCandidate,buildFormEvidence,candidateReasons,validateJudgments,reviewPrompt,reviewKey,advisoryAllowsKeep,PROMPT_VERSION,type Judgment} from './lib/examExpansion.js';
const dir=process.argv[2]??'.exam-books/expansion';
const ai=process.argv.includes('--review');
const load=(file:string)=>readFileSync(`${dir}/${file}`,'utf8');
const save=(file:string,data:unknown)=>writeFileSync(`${dir}/${file}`,JSON.stringify(data,null,2));
const sources=JSON.parse(load('sources.json')) as Array<{repo:string;commit:string;license:unknown;files:Array<{path:string;local:string;sha256:string}>}>;
if(sha256(load('nawl.txt'))!==JSON.parse(load('nawl-source.json')).sha256)throw Error('NAWL checksum changed');
for(const s of sources)for(const f of s.files??[])if(sha256(load(f.local))!==f.sha256)throw Error('Source hash changed: '+f.local);
const snapshot=JSON.parse(load('live-snapshot.json'));
const baseline=snapshot.members as Array<{book_id:string;normalized_word:string}>;
const books=['cet6','ielts','toefl'];
const old=new Map(books.map(b=>[b,new Set(baseline.filter(x=>x.book_id===b).map(x=>x.normalized_word))]));
const dictionary=new Set<string>(snapshot.dictionary.filter((x:any)=>x.chinese).map((x:any)=>x.lemma));
type Source={id:string;book:string;words:string[];raw:number;redistribution:string};
const parsed:Source[]=[];
function add(id:string,book:string,values:string[],redistribution='headwords only; upstream license/provenance review required'){
 parsed.push({id,book,raw:values.length,words:[...new Set(values.map(normalizeCandidate).filter(Boolean))].sort(),redistribution});
}
for(const [book,index]of [['cet6',0],['toefl',1]] as const){
 add('KyleBing-random',book,load(`KyleBing-${index}.txt`).split(/\r?\n/).filter(Boolean).map(x=>x.split('\t')[0]!));
 add('KyleBing-ordered',book,JSON.parse(load(`KyleBing-${index+2}.json`)).map((x:any)=>x.word));
}
const hf=sources.find(x=>x.repo.startsWith('wangjiuyi'))?.files.find(x=>x.path==='cet6_high_frequency_words.csv');
if(hf){const rows=csvRecords(load(hf.local));const header=rows.next().value as string[];const records=[...rows].map(x=>Object.fromEntries(header.map((k,i)=>[k,x[i]])));save('frequency-evidence.json',records.map(x=>({word:x.lemma??x.word,total_frequency:x.total_frequency,year_count:x.year_count,document_count:x.document_count})));add('cet6-frequency','cet6',records.map(x=>x.lemma??x.word??''));}
const nawl=load('nawl.txt').split(/\r?\n/).filter(x=>/^[a-z]+$/.test(x));
for(const book of ['ielts','toefl'])add('NAWL-1.2',book,nawl,'CC-BY-SA-4.0; academic support, not official exam syllabus');
// Review-only commercial/unknown-license sources do not contribute public members.
add('gungorkaya-essential','toefl',load('gungorkaya-eng-3.txt').split(/\r?\n/).filter(Boolean),'MIT; AI-enriched, requires independent corroboration');
const excluded=sources.filter(s=>!s.repo.startsWith('KyleBing')&&!s.repo.startsWith('wangjiuyi')&&!s.repo.startsWith('gungorkaya'));
const union=new Set([...old.values()].flatMap(x=>[...x]));for(const s of parsed)for(const w of s.words)union.add(w);
const evidence=new Map<string,Set<string>>();
for(const s of parsed)for(const word of s.words){const key=s.book+'\0'+word;const e=evidence.get(key)??new Set<string>();e.add(s.id);evidence.set(key,e);}
const ecdictPath=process.env.ECDICT_PATH;if(!ecdictPath)throw Error('Set ECDICT_PATH to pinned CSV');
const csv=readFileSync(ecdictPath,'utf8');if(sha256(csv)!==ECDICT_SHA256)throw Error('ECDICT checksum mismatch');
const formHints=buildFormEvidence(csv,union);
const reasonsFor=(word:string)=>[...candidateReasons(word,union),...(formHints.has(word)?['ecdict_form_of:'+ [...formHints.get(word)!].sort().join('|')]:[])];
save('source-form-evidence.json',Object.fromEntries([...formHints].map(([w,b])=>[w,[...b].sort()])));
const candidates=[...new Set(parsed.flatMap(s=>s.words.filter(w=>!old.get(s.book)!.has(w)&&reasonsFor(w).length)))].sort();save('review-candidates.json',candidates);
mkdirSync(`${dir}/cache`,{recursive:true});let calls=0,hits=0;const judgments=new Map<string,Judgment>();
for(const file of readdirSync(`${dir}/cache`).filter(x=>x.endsWith('.json')&&!x.endsWith('.raw.json'))){const c=JSON.parse(readFileSync(`${dir}/cache/${file}`,'utf8'));const words=(c.rows as Judgment[]).map(x=>x.original).sort();if(c.prompt_version!==PROMPT_VERSION||c.key!==reviewKey(words)||c.input_sha256!==sha256(JSON.stringify(words)))throw Error('Invalid prior cache');for(const j of validateJudgments(c.rows,words))if(candidates.includes(j.original))judgments.set(j.original,j);hits++;}
const remaining=candidates.filter(w=>!judgments.has(w));
for(let i=0;i<remaining.length;i+=30){const words=remaining.slice(i,i+30),key=reviewKey(words),path=`${dir}/cache/${key}.json`;let cache:any;
 if(existsSync(path)){cache=JSON.parse(readFileSync(path,'utf8'));hits++;}
 else if(ai){
  const prompt=reviewPrompt(words);writeFileSync(`${dir}/cache/${key}.prompt.txt`,prompt);
  const python=process.env.WORKBUDDY_PYTHON;if(!python)throw Error('Set WORKBUDDY_PYTHON to installed ACP bridge runtime');
  const r=spawnSync(python,['scripts/workbuddy-exam-adapter.py'],{input:prompt,encoding:'utf8',timeout:660000,maxBuffer:4000000});calls++;
  writeFileSync(`${dir}/cache/${key}.raw.json`,r.stdout||JSON.stringify({error:'WorkBuddy transport failed',status:r.status}));
  if(r.status!==0){save('review-progress.json',{calls,hits,failed_batch:key});throw Error('WorkBuddy failed; completed caches preserved');}
  const response=JSON.parse(r.stdout),text=response.result.text.trim();
  const rows=validateJudgments(JSON.parse(text),words);
  cache={key,prompt_version:PROMPT_VERSION,input_sha256:sha256(JSON.stringify(words)),service:response.service,model:response.result.model_id,model_version_verified:false,cost:response.cost,rows};
  writeFileSync(path,JSON.stringify(cache,null,2));
 }
 if(cache){if(cache.key!==key||cache.prompt_version!==PROMPT_VERSION||cache.input_sha256!==sha256(JSON.stringify(words)))throw Error('Invalid review cache');for(const j of validateJudgments(cache.rows,words))judgments.set(j.original,j);}
}
save('model-review.json',[...judgments.values()]);
const wanted=[...union].filter(x=>!dictionary.has(x));const corpus=buildEcdictCorpus(csv,wanted);const supplemental=new Map(corpus.dictionary_entries.filter(x=>x.chinese_translation).map(x=>[x.lemma,x]));
const pending:Array<unknown>=[],members:Array<any>=[],report:Record<string,unknown>={};
for(const book of books){const existing=old.get(book)!,final=new Set(existing);const newWords=[...new Set(parsed.filter(x=>x.book===book).flatMap(x=>x.words))].filter(x=>!existing.has(x)).sort();
 for(const word of newWords){const ev=[...(evidence.get(book+'\0'+word)??[])],reasons=reasonsFor(word),j=judgments.get(word);
  // Large generic/exam lists require corroboration. NAWL supports academic scope only.
  const supported=book==='cet6'?ev.some(x=>x.startsWith('KyleBing')):ev.includes('NAWL-1.2')||(ev.includes('gungorkaya-essential')&&ev.some(x=>x.startsWith('KyleBing')));
  const issues=[...(reasons.includes('invalid_format')?['invalid_format']:[]),...(!supported?['insufficient_exam_evidence']:[]),...(!dictionary.has(word)&&!supplemental.has(word)?['missing_chinese_gloss']:[]),...(reasons.length&&!advisoryAllowsKeep(word,j)?['needs_human_review']:[])];
  if(issues.length){pending.push({book,word,evidence:ev,reasons,issues,judgment:j??null});continue;}
  final.add(word);members.push({book_id:book,normalized_word:word,source:'WordLoop exam expansion',source_version:'expansion-v1',source_records:[],sources:ev});
 }
 report[book]={old:existing.size,source_union:new Set(parsed.filter(x=>x.book===book).flatMap(x=>x.words)).size,new_candidates:newWords.length,accepted_additions:final.size-existing.size,proposed_total:final.size,pending:newWords.length-(final.size-existing.size),dictionary_coverage:members.filter(x=>x.book_id===book).every(x=>dictionary.has(x.normalized_word)||supplemental.has(x.normalized_word))?1:0};
 save(`${book}-proposed.json`,[...final].sort());
}
const used=new Set(members.map(x=>x.normalized_word));
save('draft-corpus.json',{dictionary_entries:[...supplemental.values()].filter(x=>used.has(x.lemma)),relationships:members.map(({sources,...x})=>x)});
const existingEvidence=baseline.filter(m=>books.includes(m.book_id)).map(m=>({...m,sources:[...(evidence.get(m.book_id+'\0'+m.normalized_word)??[])]})).filter(m=>m.sources.length);
save('membership-provenance.json',[...existingEvidence,...members]);save('human-review.json',pending);
const stats=parsed.map(s=>({...s,words:undefined,unique:s.words.length,exact_duplicates:s.raw-s.words.length,old_overlap:s.words.filter(w=>old.get(s.book)!.has(w)).length,new_candidates:s.words.filter(w=>!old.get(s.book)!.has(w)).length}));
const intersections:Record<string,number>={};for(const a of books)for(const b of books.filter(x=>x>a)){const aa=JSON.parse(load(`${a}-proposed.json`)) as string[],bb=new Set(JSON.parse(load(`${b}-proposed.json`)));intersections[a+'&'+b]=aa.filter(w=>bb.has(w)).length;}
const allFinal=books.map(b=>new Set<string>(JSON.parse(load(`${b}-proposed.json`))));intersections['cet6&ielts&toefl']=[...allFinal[0]!].filter(w=>allFinal.every(s=>s.has(w))).length;
const sourceOverlap:Record<string,unknown>={};for(const book of books){const ss=parsed.filter(s=>s.book===book);sourceOverlap[book]=ss.flatMap((a,i)=>ss.slice(i+1).map(b=>({a:a.id,b:b.id,intersection:a.words.filter(w=>b.words.includes(w)).length,a_only:a.words.filter(w=>!b.words.includes(w)).length,b_only:b.words.filter(w=>!a.words.includes(w)).length})));}
save('source-overlap.json',sourceOverlap);
save('accepted-contributions.json',parsed.map(s=>({book:s.book,source:s.id,accepted_members:members.filter(m=>m.book_id===s.book&&m.sources.includes(s.id)).length,note:'Overlapping contribution; do not sum across sources'})));
save('missing-dictionary.json',pending.filter((x:any)=>x.issues.includes('missing_chinese_gloss')));
save('report.json',{mode:'dry-run',snapshot_sha256:sha256(load('live-snapshot.json')),books:report,sources:stats,excluded_public_sources:excluded.map(x=>({repo:x.repo,reason:'commercial or unverified provenance/license; review-only'})),workbuddy:{calls,cache_hits:hits,total_successful_batches:calls+hits,reviewed:judgments.size,candidates:candidates.length,decisions:Object.fromEntries([...new Set([...judgments.values()].map(x=>x.decision))].map(d=>[d,[...judgments.values()].filter(x=>x.decision===d).length])),cost:null,cost_note:'ACP billing unavailable'},pending:pending.length,intersections,actual_database_additions:0,publication_ready:false,payload_bytes:Buffer.byteLength(load('draft-corpus.json'))});
console.log(load('report.json'));
