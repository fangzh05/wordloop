import {sha256} from '../scripts/lib/examBooks.js';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {privateBookImportSql} from '../scripts/lib/privateBookImport.js';
const db=new PGlite(),a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const read=(name:string)=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const value=async(sql:string,args:unknown[]=[]) => (await db.query<any>(sql,args)).rows[0];
beforeAll(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 for(const f of ['202609130001_initial_wordloop.sql','202609130002_fsrs_shanbay.sql','202609150004_study_session_state.sql'])await db.exec(read(f).replace('create extension if not exists pgcrypto;',''));
 await db.exec(`alter table users add column if not exists daily_new_word_limit integer default 50;
 create function learning_budget_snapshot_v1(uuid) returns jsonb language sql as $$select '{"enabled":false}'::jsonb$$;
 create table lexical_dictionary_entries(entry_id text primary key,lemma text,language text default 'en',chinese_translation text,parts_of_speech jsonb,imported_at timestamptz default now());`);
 const baseline=read('20261004164746_cross_day_review_handoff.sql');await db.exec(baseline.slice(baseline.indexOf('create or replace function public.prepare_daily_new_words_budget_v1')));
 await db.exec(read('20261011092451_builtin_exam_books.sql'));await db.exec(read('20261011113842_private_commercial_books.sql'));
},30000);
afterAll(()=>db.close());beforeEach(async()=>{await db.exec('begin');await db.query('insert into users(id) values($1),($2)',[a,b]);});afterEach(()=>db.exec('rollback'));
const fixture={word:'academic',normalized_word:'academic',entry_key:sha256(JSON.stringify(['b'.repeat(64),'row:2','academic'])),source_locator:'row:2',source_row:2,senses:[{pos:'adj.',definition_cn:'SYNTHETIC PRIVATE SENSE'}],definition_raw:'SYNTHETIC PRIVATE SENSE',ipa_uk:null,ipa_us:null,chapter:'fixture',category:null};
function payload(){return privateBookImportSql('ielts-zhenjing',{commit:'a'.repeat(40),sha256:'b'.repeat(64),path:'synthetic.json',repo:'fixture'},[fixture],{private_use_attested:true,original_wording_verified:false},true);}
async function seed(){await db.exec(payload().sql);await db.exec(`insert into lexical_dictionary_entries values('academic','academic','en','PUBLIC ECDICT','[]',now());update exam_books set is_available=true where id='ielts-zhenjing';`);await db.query("insert into exam_book_entitlements(user_id,book_id,rights_evidence,verified_at) values($1,'ielts-zhenjing','SYNTHETIC TEST ENTITLEMENT ONLY',now())",[a]);}
it('hides private existence and counts and denies selection without entitlement',async()=>{
 await seed();const unauthorized=(await value('select list_exam_books_v1($1) v',[b])).v;
 expect(unauthorized.books).toHaveLength(5);expect(JSON.stringify(unauthorized)).not.toContain('zhenjing');
 expect((await value('select list_exam_books_v1($1) v',[a])).v.books).toHaveLength(6);
 await expect(db.query("select set_exam_book_v1($1,'ielts-zhenjing')",[b])).rejects.toThrow('unavailable');
});
it('imports idempotently, keeps ECDICT and legacy gloss, lazily enrolls a single identity without FSRS logs',async()=>{
 await db.exec(`insert into words(normalized_word,display_word,senses) values('academic','academic','[{"pos":"n.","definition_cn":"LEGACY PRIVATE"}]')`);
 const before=await value('select to_jsonb(words) v from words');await seed();await db.exec(payload().sql);
 expect(await value('select to_jsonb(words) v from words')).toEqual(before);
 expect((await value('select count(*) n from word_source_definitions')).n).toBe(1);
 expect((await value('select count(*) n from source_definition_batches')).n).toBe(1);
 await db.query("select set_exam_book_v1($1,'ielts-zhenjing')",[a]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[a]);
 await db.query('select prepare_daily_new_words_budget_v1($1,current_date,2)',[a]);await db.query('select prepare_daily_new_words_budget_v1($1,current_date,2)',[a]);
 expect((await value('select count(*) n from user_words')).n).toBe(1);expect((await value('select count(*) n from fsrs_review_logs')).n).toBe(0);
 expect((await value("select current_book_definitions_v1($1,'academic') v",[a])).v[0].definition_raw).toBe(fixture.definition_raw);
 expect((await value("select current_book_definitions_v1($1,'academic') v",[b])).v).toEqual([]);
 expect((await value('select chinese_translation v from lexical_dictionary_entries')).v).toBe('PUBLIC ECDICT');
 const second=privateBookImportSql('cet6-xinghuo',{commit:'a'.repeat(40),sha256:'b'.repeat(64),path:'synthetic.json',repo:'fixture'},[fixture],{private_use_attested:true,original_wording_verified:false},true);await db.exec(second.sql);
 await db.exec("update exam_books set is_available=true where id='cet6-xinghuo';update user_words set correct_count=4,fsrs_stability=2");
 await db.query("insert into exam_book_entitlements(user_id,book_id,rights_evidence,verified_at) values($1,'cet6-xinghuo','SYNTHETIC SECOND BOOK ENTITLEMENT',now())",[a]);
 const history=await value('select word_id,correct_count,fsrs_stability,fsrs_reps,mastered from user_words');
 await db.query("select set_exam_book_v1($1,'cet6-xinghuo')",[a]);await db.query('select prepare_daily_new_words_budget_v1($1,current_date+1,2)',[a]);
 expect((await value('select count(*) n from user_words')).n).toBe(1);expect(await value('select word_id,correct_count,fsrs_stability,fsrs_reps,mastered from user_words')).toEqual(history);
 expect((await value('select count(*) n from fsrs_review_logs')).n).toBe(0);

});
it('revocation denies saved selection; ordinary roles cannot export commercial data or invoke service RPCs',async()=>{
 await seed();await db.query("select set_exam_book_v1($1,'ielts-zhenjing')",[a]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[a]);
 await db.query('update exam_book_entitlements set expires_at=now()-interval \'1 second\' where user_id=$1',[a]);
 expect((await value("select current_book_definitions_v1($1,'academic') v",[a])).v).toEqual([]);
 expect((await value('select list_exam_books_v1($1) v',[a])).v.selected_book_id).toBeNull();
 for(const role of ['anon','authenticated']){
  for(const sql of ['select * from word_source_definitions',`select current_book_definitions_v1('${a}','academic')`,`select list_exam_books_v1('${a}')`]){
   await db.exec('savepoint probe;set local role '+role);await expect(db.query(sql)).rejects.toThrow('permission denied');await db.exec('rollback to savepoint probe');
  }
 }
});

it('bulk intake is idempotent and rejects original-text drift atomically',async()=>{
 expect(()=>privateBookImportSql('ielts-zhenjing',{commit:'a'.repeat(40),sha256:'b'.repeat(64),path:'synthetic.json',repo:'fixture'},[fixture,fixture],{private_use_attested:true,original_wording_verified:false},true)).toThrow('Duplicate source');
 const prepared=payload();await db.exec(prepared.sql);
 const intake=()=>db.query<{n:number}>('select commercial_import_admin.import_rows_v1($1,$2,$3::jsonb) n',['ielts-zhenjing',prepared.batch,JSON.stringify(prepared.transferRows)]);
 expect((await intake()).rows[0]!.n).toBe(0);
 const changed={...fixture,definition_raw:'DIFFERENT ORIGINAL'};
 const drift=privateBookImportSql('ielts-zhenjing',{commit:'a'.repeat(40),sha256:'b'.repeat(64),path:'synthetic.json',repo:'fixture'},[changed],{private_use_attested:true,original_wording_verified:false},true);
 await db.exec('savepoint drift');await expect(db.exec(drift.sql)).rejects.toThrow('IMMUTABLE_SOURCE_DRIFT');await db.exec('rollback to savepoint drift');
 expect((await value('select definition_raw v from word_source_definitions')).v).toBe(fixture.definition_raw);
 for(const role of ['anon','authenticated']){await db.exec('savepoint permission;set local role '+role);await expect(intake()).rejects.toThrow('permission denied');await db.exec('rollback to savepoint permission');}
});
