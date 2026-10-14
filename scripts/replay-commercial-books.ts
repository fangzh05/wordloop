import {privateDataRoot} from './lib/privateDataPath.js';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {privateBookTestDatabase} from './lib/privateBookTestDatabase.js';
import {privateBookImportSql} from './lib/privateBookImport.js';
const root=privateDataRoot(process.argv[2]);
const draft=JSON.parse(readFileSync(resolve(root,'normalized-draft.json'),'utf8'));
const snapshot=JSON.parse(readFileSync(resolve(root,'identity-snapshot.json'),'utf8'));
const db=await privateBookTestDatabase();
const count=async(table:string)=>(await db.query<{n:number}>(`select count(*)::integer n from ${table}`)).rows[0]!.n;
try{
 await db.query(`insert into words(id,normalized_word,display_word) select (r->>'id')::uuid,r->>'normalized_word',r->>'normalized_word' from jsonb_array_elements($1::jsonb) r`,[JSON.stringify(snapshot.words)]);
 // Protected sentinel represents existing data, not a copy of production learner data.
 await db.exec(`update words set senses='[{"pos":"n.","definition_cn":"PROTECTED LEGACY SENTINEL"}]' where normalized_word='academic';`);
 const before=(await db.query<{hash:string}>('select md5(string_agg(to_jsonb(w)::text,\'\' order by id)) hash from words w')).rows[0]!.hash;
 const user='00000000-0000-4000-8000-000000000001';await db.query('insert into users(id) values($1)',[user]);
 const imports=Object.entries(draft.books).map(([id,b]:[string,any])=>({id,...privateBookImportSql(id,b.source,b.records,{private_use_attested:true,original_wording_verified:false},true)}));
 const passes=[];
 for(let pass=1;pass<=2;pass++){
  await db.exec('begin');for(const item of imports){await db.exec(item.sql.slice(0,item.sql.indexOf(';')+1));for(let offset=0;offset<item.transferRows.length;offset+=500)await db.query('select commercial_import_admin.import_rows_v1($1,$2,$3::jsonb)',[item.id,item.batch,JSON.stringify(item.transferRows.slice(offset,offset+500))]);}await db.exec('commit');
  passes.push({pass,words:await count('words'),members:await count('exam_book_words'),definitions:await count('word_source_definitions'),batches:await count('source_definition_batches'),user_words:await count('user_words'),fsrs_logs:await count('fsrs_review_logs')});
 }
 const existingHash=(await db.query<{hash:string}>(`select md5(string_agg(to_jsonb(w)::text,'' order by id)) hash from words w where id in(select (r->>'id')::uuid from jsonb_array_elements($1::jsonb) r)`,[JSON.stringify(snapshot.words)])).rows[0]!.hash;
 if(before!==existingHash||JSON.stringify({...passes[0],pass:0})!==JSON.stringify({...passes[1],pass:0}))throw Error('Protected data or replay invariant failed');
 // Fixture-only grant and publication inside this transient in-process test database.
 const learning=[];
 for(const [index,item] of imports.entries()){
  const user=`00000000-0000-4000-8000-${String(index+2).padStart(12,'0')}`;await db.query('insert into users(id,daily_new_word_limit) values($1,50)',[user]);
  await db.query("insert into exam_book_entitlements(user_id,book_id,rights_evidence,verified_at) values($1,$2,'LOCAL TEST PRIVATE-USE ATTESTATION',now())",[user,item.id]);
  await db.query('update exam_books set is_available=true where id=$1',[item.id]);
  await db.query('select set_exam_book_v1($1,$2)',[user,item.id]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[user]);
  await db.query('delete from daily_book_targets where user_id=$1',[user]);
  await db.query('select prepare_daily_new_words_budget_v1($1,current_date,3)',[user]);
  const sample=(await db.query<any>('select normalized_word from exam_book_words where book_id=$1 order by normalized_word limit 1',[item.id])).rows[0].normalized_word;
  const defs=(await db.query<any>('select current_book_definitions_v1($1,$2) v',[user,sample])).rows[0].v;
  const enrolled=(await db.query<{n:number}>('select count(*)::integer n from user_words where user_id=$1',[user])).rows[0]!.n;if(enrolled!==50||!defs.length)throw Error('Private book learning fixture failed');learning.push({book:item.id,definitions_read:defs.length,enrolled});
 }
 const report={mode:'local PGlite only',production_writes:0,private_use_attested:true,publisher_authorization_verified:false,original_wording_verified:false,
  baseline_words:snapshot.words.length,passes,existing_rows_unchanged:before===existingHash,learning,imports:imports.map(({id,batch,accepted,quarantined})=>({id,batch,accepted,quarantined}))};
 writeFileSync(resolve(root,'replay-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await db.close();}
