import {privateDataRoot} from './lib/privateDataPath.js';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {config} from 'dotenv';
import {createClient} from '@supabase/supabase-js';
import {normalizeWord,wordInputSchema} from '../server/services/wordNormalization.js';
import {candidateReasons,validateJudgments,reviewPrompt} from './lib/examExpansion.js';
import {sha256} from './lib/examBooks.js';

const root=privateDataRoot(process.argv[2]);
const save=(name:string,value:unknown)=>writeFileSync(resolve(root,name),JSON.stringify(value,null,2));
const draft=JSON.parse(readFileSync(resolve(root,'private-draft.json'),'utf8'));
const all=new Set<string>();
for(const book of Object.values(draft.books) as any[])for(const row of book.records){
 row.normalized_word=normalizeWord(row.word);all.add(row.normalized_word);
 row.format_valid=wordInputSchema.safeParse(row.word).success;
 row.entry_key=sha256(JSON.stringify([book.source.sha256,row.source_locator??`${row.sheet}:${row.source_row}`,row.word]));
 row.reasons=candidateReasons(row.normalized_word,all);
}
// Recompute with the complete union, independent of source traversal order.
for(const book of Object.values(draft.books) as any[])for(const row of book.records)row.reasons=candidateReasons(row.normalized_word,all);
save('normalized-draft.json',draft);
const candidates=[...new Set((Object.values(draft.books) as any[]).flatMap(b=>b.records.filter((r:any)=>r.reasons.length).map((r:any)=>r.normalized_word)))].sort() as string[];
save('review-headwords.json',candidates);
const reviewDir=resolve(root,'workbuddy');mkdirSync(reviewDir,{recursive:true});
let reviewed=0;
if(process.argv.includes('--review')){
 const python=process.env.WORKBUDDY_PYTHON;if(!python)throw Error('WORKBUDDY_PYTHON required');
 for(let i=0;i<candidates.length;i+=30){
  const words=candidates.slice(i,i+30),key=sha256(JSON.stringify(words)),file=resolve(reviewDir,key+'.json');
  if(existsSync(file)){validateJudgments(JSON.parse(readFileSync(file,'utf8')),words);reviewed+=words.length;continue;}
  // Headwords only. No commercial definitions, examples, audio, chapters or user records.
  const prompt=reviewPrompt(words).replace('public exam-source headwords','headword-only quarantine candidates with unverified source attribution');
  writeFileSync(resolve(reviewDir,key+'.prompt.txt'),prompt);
  let accepted=false;
  for(let attempt=0;attempt<2&&!accepted;attempt++){
   const result=spawnSync(python,['scripts/workbuddy-exam-adapter.py'],{input:prompt+(attempt?'\nThe prior response failed strict schema validation. decision must be exactly one of: keep, exact_duplicate, spelling_variant, inflection_of, distinct_lemma, multiword_expression, invalid, uncertain. Do not invent a new enum value.':''),encoding:'utf8',timeout:660000,maxBuffer:4000000});
   writeFileSync(resolve(reviewDir,key+`.attempt${attempt}.raw.json`),result.stdout||JSON.stringify({status:result.status}));
   try{
    if(result.status!==0)throw Error('WorkBuddy transport failure');
    const raw=JSON.parse(result.stdout),text=raw.result.text.trim().replace(/^```json\s*|\s*```$/g,'');
    const rows=validateJudgments(JSON.parse(text),words);writeFileSync(file,JSON.stringify(rows,null,2));reviewed+=words.length;accepted=true;
   }catch{save(`workbuddy/${key}.rejected.json`,{words,reason:'invalid structured model result',requires_human_review:true});}
  }
  save('review-progress.json',{reviewed,total:candidates.length,identity_changes:0,definition_changes:0});
 }
}
// Model opinions only quarantine candidates; they never rewrite identity or source text.
const opinions=new Map<string,any>();
for(const name of (await import('node:fs')).readdirSync(reviewDir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
 const judgments=JSON.parse(readFileSync(resolve(reviewDir,name),'utf8'));
 for(const judgment of judgments)opinions.set(judgment.original,judgment);
}
const manual=[];
for(const [id,book] of Object.entries(draft.books) as [string,any][]){
 for(const row of book.records){const opinion=opinions.get(row.normalized_word);
  row.requires_human_review=!!opinion&&['uncertain','invalid'].includes(opinion.decision);
  if(row.requires_human_review)manual.push({book_id:id,entry_key:row.entry_key,normalized_word:row.normalized_word,source_row:row.source_row,opinion});
 }
}
save('manual-review-queue.json',manual);save('normalized-draft.json',draft);
if(process.argv.includes('--snapshot')){
 if(!process.env.WORDLOOP_AUDIT_ENV)throw Error('Set WORDLOOP_AUDIT_ENV to existing server env file');
 config({path:process.env.WORDLOOP_AUDIT_ENV,quiet:true});
 const db=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
 async function scan(table:string,columns:string,order:string){const rows:any[]=[];for(let start=0;;start+=1000){const r=await db.from(table).select(columns).order(order).range(start,start+999);if(r.error)throw Error('Read-only snapshot failed: '+table);rows.push(...r.data);if(r.data.length<1000)break;}return rows;}
 const [members,words]=await Promise.all([scan('exam_book_words','book_id,normalized_word','normalized_word'),scan('words','id,normalized_word','id')]);
 save('identity-snapshot.json',{captured_at:new Date().toISOString(),mode:'read-only',members,words});
}
const snapshotPath=resolve(root,'identity-snapshot.json');
const snapshot=existsSync(snapshotPath)?JSON.parse(readFileSync(snapshotPath,'utf8')):null;
const known=snapshot?new Set(snapshot.words.map((w:any)=>w.normalized_word)):null;
const reports=Object.fromEntries(Object.entries(draft.books).map(([id,b]:[string,any])=>{
 const words=new Set<string>(b.records.map((r:any)=>r.normalized_word));
 return [id,{raw_records:b.records.length,unique_words:words.size,definition_coverage:[...words].filter(w=>b.records.some((r:any)=>r.normalized_word===w&&r.definition_raw)).length,
  missing_definition_records:b.records.filter((r:any)=>!r.definition_raw).length,invalid_format_records:b.records.filter((r:any)=>!r.format_valid).length,
  existing_wordloop_words:known?[...words].filter(w=>known.has(w)).length:null,candidate_new_words:known?[...words].filter(w=>!known.has(w)).length:null,
  actual_inserted_words:0,rights_review_pending:words.size,original_wording_verified:false,format_review_candidates:[...words].filter(w=>candidates.includes(w)).length}];
}));
const aggregate=Object.fromEntries(['cet6','ielts','toefl'].map(book=>{
 const old=snapshot?new Set<string>(snapshot.members.filter((r:any)=>r.book_id===book).map((r:any)=>r.normalized_word)):null;
 const proposed=new Set<string>((Object.entries(draft.books) as [string,any][]).filter(([id])=>id.startsWith(book==='cet6'?'cet6':book)).flatMap(([,b])=>b.records.filter((r:any)=>r.format_valid).map((r:any)=>r.normalized_word)));
 const delta=old?[...proposed].filter(w=>!old.has(w)):null;
 return [book,{old_unique:old?.size??null,candidate_delta:delta?.length??null,approved_delta:0,final_unique:old?.size??null,publication_blocked:'rights and membership evidence require review'}];
}));
save('report.json',{reports,aggregate,snapshot_at:snapshot?.captured_at??null,reviewed,candidates:candidates.length,production_writes:0,model_received_commercial_text:false,missing_book:'toefl-xindongfang'});
console.log(JSON.stringify({reports,aggregate,candidates:candidates.length,reviewed}));
