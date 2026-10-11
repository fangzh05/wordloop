// Real staged corpus, isolated PostgreSQL engine. Never connects to production.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {privateDataRoot} from './lib/privateDataPath.js';
import {privateBookTestDatabase} from './lib/privateBookTestDatabase.js';
import {privateBookImportSql} from './lib/privateBookImport.js';
import {prepareDeepImport,type DeepBook,type DeepSnapshot} from './lib/deepExamImport.js';
import {deepExamSql} from './lib/deepExamSql.js';
const root=privateDataRoot(process.argv[2]);
const load=(p:string)=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const snapshot=load('live-snapshot.json') as DeepSnapshot,books=load('private-staging.json').books as Record<string,DeepBook>;
const legacy=load('../five-exam-snapshot.json'),plan=prepareDeepImport(books,snapshot,legacy.sources),prepared=deepExamSql(snapshot,plan);
const db=await privateBookTestDatabase();
const sourceBatches:Record<string,unknown>={};
try{
 for(const f of load('../five-exam-live-functions.json'))await db.exec(f.definition);
 for(const file of ['20261012020000_exam_source_mapping.sql','20261012030000_deep_exam_internal_sources.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 const ids=load('../identity-snapshot.json').words;
 await db.query("insert into words(id,normalized_word,display_word) select (r->>'id')::uuid,r->>'normalized_word',r->>'normalized_word' from jsonb_array_elements($1::jsonb)r",[JSON.stringify(ids)]);
 const original=load('../normalized-draft.json').books;
 async function importBook(id:string,b:DeepBook,rows:unknown[]){
  const p=privateBookImportSql(id,b.source,rows,{private_use_attested:true,original_wording_verified:false},true);
  if(id in books)sourceBatches[id]={batch_id:p.batch,source:b.source,records:p.accepted,entries:p.transferRows.map(r=>({entry_key:r.entry_key,normalized_word:r.normalized_word,content_hash:r.content_hash}))};
  await db.exec('begin;set local standard_conforming_strings=on;');
  try{await db.exec(p.batch_statement);let added=0;
   for(let i=0;i<p.transferRows.length;i+=200)added+=(await db.query<{n:number}>('select commercial_import_admin.import_rows_v1($1,$2,$3::jsonb) n',[id,p.batch,JSON.stringify(p.transferRows.slice(i,i+200))])).rows[0]!.n;
   await db.exec('commit;');return added;
  }catch(error){await db.exec('rollback;');throw error;}
 }
 for(const[id,b]of Object.entries(original) as [string,DeepBook][])await importBook(id,b,b.records);
 await db.query("insert into exam_book_words select r->>'book_id',r->>'normalized_word','BASELINE FIXTURE','snapshot',array[]::integer[] from jsonb_array_elements($1::jsonb)r on conflict do nothing",[JSON.stringify(legacy.members)]);
 await db.query("insert into lexical_dictionary_entries(entry_id,lemma,chinese_translation) select w,w,'PUBLIC ECDICT FIXTURE' from jsonb_array_elements_text($1::jsonb)w",[JSON.stringify(snapshot.dictionary_words)]);
 const user='00000000-0000-4000-8000-000000000001';
 await db.query("insert into users(id) values($1);",[user]);
 await db.query("insert into user_words(user_id,word_id,source,correct_count,fsrs_stability) select $1,id,'fixture',8,4 from words where normalized_word='academic'",[user]);
 await db.query("insert into fsrs_review_logs(user_id,word_id,rating,state,due,stability,difficulty,elapsed_days,last_elapsed_days,scheduled_days,learning_steps,reviewed_at,review_source) select $1,id,3,2,now(),4,3,2,2,5,0,now(),'review' from words where normalized_word='academic'",[user]);
 const hash=async(table:string,where='true',params:unknown[]=[])=>{if(!/^[a-z_]+$/.test(table))throw Error('Invalid replay table');return (await db.query<{hash:string}>(`select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),'')) hash from ${table} t where ${where}`,params)).rows[0]!.hash;};
 const protectedTables=['user_words','fsrs_review_logs','word_sources','study_sessions','attempts','captured_notes','lexical_dictionary_entries'];
 // Only tables present in the current minimal replay harness are included.
 const present=(await db.query<{table_name:string}>("select table_name from information_schema.tables where table_schema='public'")).rows.map(x=>x.table_name);
 const protectedHash=async()=>Object.fromEntries(await Promise.all(protectedTables.filter(t=>present.includes(t)).map(async t=>[t,await hash(t)])));
 const before=await protectedHash(),oldWords=await hash('words'),oldDefs=await hash('word_source_definitions'),unaffected=await hash('exam_book_words',"book_id in ('cet4','cet6','kaoyan')");
 const passes=[];
 for(let pass=0;pass<2;pass++){
  let definitions=0;
  for(const[id,b]of Object.entries(books)){
   await db.query("update exam_books set source=$2,source_version=$3 where id=$1 and source='source_missing'",[id,b.source.repo,b.source.commit]);
   definitions+=await importBook(id,b,plan.accepted[id]!);
  }
  await db.exec(prepared.sql);
  const totals=(await db.query("select book_id,count(*)::integer total from exam_book_words where book_id in ('ielts','toefl') group by book_id order by book_id")).rows;
  passes.push({pass:pass+1,definitions_inserted:definitions,totals,shared_words:(await db.query<{n:number}>('select count(*)::integer n from words')).rows[0]!.n});
 }
 if(passes[1]!.definitions_inserted!==0||JSON.stringify(passes[0]!.totals)!==JSON.stringify(passes[1]!.totals)||passes[0]!.shared_words!==passes[1]!.shared_words)throw Error('Non-idempotent replay');
 const after=await protectedHash();if(JSON.stringify(before)!==JSON.stringify(after)||unaffected!==await hash('exam_book_words',"book_id in ('cet4','cet6','kaoyan')"))throw Error('Protected data changed');
 const definitionCoverage=(await db.query<{exam:string;with_definition:number}>("select p.exam,count(distinct p.word)::integer with_definition from jsonb_to_recordset($1::jsonb) as p(exam text,word text,sources jsonb) where exists(select 1 from word_source_definitions s where s.normalized_word=p.word and p.sources ? s.book_id and btrim(s.definition_raw)<>'') group by p.exam order by p.exam",[JSON.stringify(plan.additions)])).rows;
 for(const m of plan.metrics)if(definitionCoverage.find(r=>r.exam===m.exam)?.with_definition!==m.additions_with_private_definition)throw Error('Actual source definition coverage mismatch');
 // Verify old rows by actual PK set, not just record count; full content equality.
 await db.query("create temporary table old_word_keys as select value word from jsonb_array_elements_text($1::jsonb)",[JSON.stringify(snapshot.words)]);
 if(oldWords!==await hash('words','normalized_word in(select word from old_word_keys)'))throw Error('Old identities changed');
 if(oldDefs!==await hash('word_source_definitions','book_id=any($1::text[])',[Object.keys(original)]))throw Error('Old private definitions changed');
 const learning=[];
 await db.exec("update exam_books set is_public=true,is_available=true,published_at=now(),checksum=repeat('a',64) where id in ('cet4','cet6','kaoyan','ielts','toefl')");
 // Explicit isolated activation; exported merge SQL never enables private sources.
 await db.exec("update exam_definition_sources set enabled=true where exam_id in ('ielts','toefl')");
 for(const[index,exam]of ['ielts','toefl'].entries()){
  const uid=`00000000-0000-4000-8000-${String(index+2).padStart(12,'0')}`;
  await db.query('insert into users(id) values($1)',[uid]);
  for(const id of Object.keys(books))await db.query("insert into exam_book_entitlements(user_id,book_id,rights_evidence,verified_at) values($1,$2,'ISOLATED TEST GRANT, NOT PUBLISHER RIGHTS',now())",[uid,id]);
  await db.query('select set_exam_book_v1($1,$2)',[uid,exam]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[uid]);
  const baseline=snapshot.members.filter(m=>m.book_id===exam).map(m=>m.normalized_word);
  await db.query("insert into words(normalized_word,display_word) select w,w from jsonb_array_elements_text($1::jsonb)w on conflict do nothing",[JSON.stringify(baseline)]);
  await db.query("insert into user_words(user_id,word_id,source,status,mastered) select $1,id,'OLD FIXTURE','mastered',true from words where normalized_word in(select jsonb_array_elements_text($2::jsonb))",[uid,JSON.stringify(baseline)]);
  const initial=(await db.query<{n:number}>('select count(*)::integer n from user_words where user_id=$1',[uid])).rows[0]!.n;
  await db.query('select prepare_exam_pool_v1($1,current_date,10)',[uid]);
  const n=(await db.query<{n:number}>('select count(*)::integer n from user_words where user_id=$1',[uid])).rows[0]!.n-initial;if(n!==10)throw Error('Enrollment failure');
  const newCards=(await db.query<{normalized_word:string}>("select w.normalized_word from user_words u join words w on w.id=u.word_id where user_id=$1 and u.source='exam_book'",[uid])).rows;
  if(newCards.length!==10||newCards.some(r=>!plan.additions.some(a=>a.exam===exam&&a.word===r.normalized_word)))throw Error('Did not enroll actual new members');learning.push({exam,enrolled_new_members:n});
 }
 const report={mode:'isolated PGlite actual corpus replay',production_writes:0,batch:prepared.batch,passes,definitionCoverage,protected_before:before,protected_after:after,old_identities_unchanged:true,old_definitions_unchanged:true,other_three_books_unchanged:true,idempotent:true,learning};
 writeFileSync(resolve(root,'replay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 writeFileSync(resolve(root,'source-batches.json'),JSON.stringify(sourceBatches));
}finally{await db.close();}
