// Real local corpus + read-only membership snapshot. Never connects to Supabase.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {privateDataRoot} from './lib/privateDataPath.js';
import {privateBookTestDatabase} from './lib/privateBookTestDatabase.js';
import {privateBookImportSql} from './lib/privateBookImport.js';
import {independentExamTags,planExamSourceMapping,type MappingSnapshot} from './lib/examSourceMapping.js';
import {examSourceMergeSql} from './lib/examSourceMergeSql.js';
import {sha256} from './lib/examBooks.js';
const root=privateDataRoot(process.argv[2]);
const snapshotText=readFileSync(resolve(root,'five-exam-snapshot.json'),'utf8');
const snapshot=JSON.parse(snapshotText) as MappingSnapshot;
const plan=planExamSourceMapping(snapshot,independentExamTags(readFileSync(process.argv[3]!,'utf8')));
const prepared=examSourceMergeSql(snapshot,plan),db=await privateBookTestDatabase();
try{
 const functions=JSON.parse(readFileSync(resolve(root,'five-exam-live-functions.json'),'utf8')) as {definition:string}[];
 for(const f of functions)await db.exec(f.definition);
 await db.exec(readFileSync(new URL('../supabase/migrations/20261012020000_exam_source_mapping.sql',import.meta.url),'utf8'));
 const old=JSON.parse(readFileSync(resolve(root,'identity-snapshot.json'),'utf8'));
 const draft=JSON.parse(readFileSync(resolve(root,'normalized-draft.json'),'utf8'));
 await db.query("insert into words(id,normalized_word,display_word) select (r->>'id')::uuid,r->>'normalized_word',r->>'normalized_word' from jsonb_array_elements($1::jsonb)r",[JSON.stringify(old.words)]);
 for(const[id,b]of Object.entries(draft.books) as [string,any][]){const p=privateBookImportSql(id,b.source,b.records,{private_use_attested:true,original_wording_verified:false},true);await db.exec(p.sql.slice(0,p.sql.indexOf(';')+1));for(let i=0;i<p.transferRows.length;i+=500)await db.query('select commercial_import_admin.import_rows_v1($1,$2,$3::jsonb)',[id,p.batch,JSON.stringify(p.transferRows.slice(i,i+500))]);}
 await db.query("insert into exam_book_words select r->>'book_id',r->>'normalized_word','BASELINE FIXTURE','snapshot',array[]::integer[] from jsonb_array_elements($1::jsonb)r on conflict do nothing",[JSON.stringify(snapshot.members)]);
 await db.query("insert into lexical_dictionary_entries(entry_id,lemma,chinese_translation) select w,w,'PUBLIC DICTIONARY FIXTURE' from jsonb_array_elements_text($1::jsonb)w",[JSON.stringify(snapshot.dictionary_words)]);
 await db.exec("update exam_books set is_available=true,is_public=true,published_at=now(),checksum=repeat('a',64) where id in ('cet4','cet6','kaoyan','ielts','toefl')");
 const user='00000000-0000-4000-8000-000000000001';
 await db.query("insert into users(id) values($1);",[user]);
 await db.query("insert into user_words(user_id,word_id,source,correct_count,fsrs_stability) select $1,id,'fixture',8,4 from words where normalized_word='academic'",[user]);
 const digest=async(table:string)=>(await db.query<{hash:string}>(`select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),'')) hash from ${table} t`)).rows[0]!.hash;
 const protectedTables=['words','user_words','fsrs_review_logs','word_sources','study_sessions','lexical_dictionary_entries','word_source_definitions','source_definition_batches'];
 const before=Object.fromEntries(await Promise.all(protectedTables.map(async t=>[t,await digest(t)])));
 const passes=[];
 for(let i=0;i<2;i++){await db.exec(prepared.sql);passes.push((await db.query('select book_id,count(*)::integer total from exam_book_words group by book_id order by book_id')).rows);}
 if(JSON.stringify(passes[0])!==JSON.stringify(passes[1]))throw Error('Non-idempotent membership merge');
 for(const book of plan.books)if((passes[1] as {book_id:string;total:number}[]).find(b=>b.book_id===book.id)?.total!==book.final)throw Error('Final membership count mismatch');
 const after=Object.fromEntries(await Promise.all(protectedTables.map(async t=>[t,await digest(t)])));if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Protected table changed');
 // Separate fixture users verify both permission paths without touching the sentinel.
 const learning=[];
 for(const[index,exam]of ['cet6','ielts','kaoyan'].entries()){
  const uid=`00000000-0000-4000-8000-${String(index+2).padStart(12,'0')}`;
  await db.query('insert into users(id) values($1)',[uid]);
  for(const source of ['cet6-xinghuo','ielts-zhenjing','ielts-wanglu-807-listening'])await db.query("insert into exam_book_entitlements(user_id,book_id,rights_evidence,verified_at) values($1,$2,'LOCAL TEST SOURCE ENTITLEMENT ONLY',now())",[uid,source]);
  await db.query('select set_exam_book_v1($1,$2)',[uid,exam]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[uid]);
  await db.query('select prepare_exam_pool_v1($1,current_date,10)',[uid]);
  const enrolled=(await db.query<{n:number}>('select count(*)::integer n from user_words where user_id=$1',[uid])).rows[0]!.n;if(enrolled!==10)throw Error('Exam enrollment failed');learning.push({exam,enrolled});
 }
 const report={mode:'local PGlite only',production_writes:0,batch:prepared.batch,snapshot_sha256:sha256(snapshotText),sql_sha256:sha256(prepared.sql),passes,protected_before:before,protected_after:after,protected_unchanged:true,idempotent:true,learning};
 writeFileSync(resolve(root,'five-exam-replay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,protected_before:undefined,protected_after:undefined}));
}finally{await db.close();}
