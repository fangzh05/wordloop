import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
const db=new PGlite(),a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const migration=readFileSync(new URL('../supabase/migrations/20261011092451_builtin_exam_books.sql',import.meta.url),'utf8');
const value=async(sql:string,args:any[]=[]) => (await db.query<any>(sql,args)).rows[0];
beforeAll(async()=>{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth; create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 for(const file of ['202609130001_initial_wordloop.sql','202609130002_fsrs_shanbay.sql','202609150004_study_session_state.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8').replace('create extension if not exists pgcrypto;',''));
 await db.exec(`alter table users add column if not exists daily_new_word_limit integer default 50;
 create function learning_budget_snapshot_v1(uuid) returns jsonb language sql as $$select '{"enabled":false}'::jsonb$$;
 create table lexical_dictionary_entries(entry_id text primary key,lemma text,language text default 'en',chinese_translation text,parts_of_speech jsonb,imported_at timestamptz default now());`);
 const baseline=readFileSync(new URL('../supabase/migrations/20261004164746_cross_day_review_handoff.sql',import.meta.url),'utf8');
 await db.exec(baseline.slice(baseline.indexOf('create or replace function public.prepare_daily_new_words_budget_v1')));
 await db.exec(migration);
},30000);
afterAll(()=>db.close());beforeEach(async()=>{await db.exec('begin');await db.query('insert into users(id,daily_new_word_limit) values($1,10),($2,10)',[a,b]);});afterEach(()=>db.exec('rollback'));
async function seed(){await db.exec(`update exam_books set is_available=true,is_public=true,published_at=now(),checksum=repeat('a',64) where id in ('cet4','cet6');
 insert into exam_book_words values('cet4','apple','ECDICT','test',array[2]),('cet4','bear','ECDICT','test',array[3]),('cet6','apple','ECDICT','test',array[2]),('cet6','circle','ECDICT','test',array[4]);
 insert into lexical_dictionary_entries(entry_id,lemma,chinese_translation,parts_of_speech) values ('apple','apple','苹果','[{"label":"n.","definition_zh":"苹果"}]'),('bear','bear','熊','[]'),('circle','circle','圆','[]');`);}
it('does not publish unreviewed books and provides an explicit initial choice',async()=>{
 const r=await value('select list_exam_books_v1($1) v',[b]);expect(r.v.selected_book_id).toBeNull();expect(r.v.books).toHaveLength(5);expect(r.v.books.every((x:any)=>!x.available)).toBe(true);
 await expect(db.query("select set_exam_book_v1($1,'kaoyan')",[b])).rejects.toThrow('unavailable');
});
it('lazily enrolls within budget, is idempotent, shares identities and preserves today on switch',async()=>{
 await seed();await db.query("select set_exam_book_v1($1,'cet4')",[b]);
 expect((await value('select count(*) n from user_words')).n).toBe(0);
 await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[b]);
 const first=await value('select prepare_daily_new_words_budget_v1($1,current_date,2) v',[b]);expect(first.v.added).toBe(2);
 const before=await value('select jsonb_agg(to_jsonb(uw) order by id) v from user_words uw');
 await db.query("select set_exam_book_v1($1,'cet6')",[b]);
 await db.query('select prepare_daily_new_words_budget_v1($1,current_date,2)',[b]);
 expect(await value('select jsonb_agg(to_jsonb(uw) order by id) v from user_words uw')).toEqual(before);
 await db.query('select prepare_daily_new_words_budget_v1($1,current_date+1,2)',[b]);
 expect((await value('select count(*) n from user_words where user_id=$1',[b])).n).toBe(3);
 expect((await value("select count(*) n from words where normalized_word='apple'")).n).toBe(1);
 expect((await value('select count(*) n from fsrs_review_logs')).n).toBe(0);
});
it('defaults only the private owner to kaoyan and preserves private card IDs and senses',async()=>{
 await db.exec("insert into words(normalized_word,display_word,senses,ipa_us) values('apple','Apple','[{\"pos\":\"n.\",\"definition_cn\":\"PRIVATE GLOSS\"}]','PRIVATE IPA')");
 await db.query("insert into word_sources(user_id,word_id,source_type,source_book_id) select $1,id,'shanbay',s from words cross join unnest(array['ougkp','athgc'])s",[a]);
 await db.query('insert into user_words(user_id,word_id) select $1,id from words',[a]);
 const snapshot=await value('select jsonb_agg(to_jsonb(w)) v from words w');
 expect((await value('select list_exam_books_v1($1) v',[a])).v.selected_book_id).toBe('kaoyan');
 expect((await value('select list_exam_books_v1($1) v',[b])).v.books[0].total).toBe(0);
 await seed();await db.query("select set_exam_book_v1($1,'cet4')",[b]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[b]);await db.query('select prepare_daily_new_words_budget_v1($1,current_date,2)',[b]);
 expect((await value("select senses,ipa_us from words where normalized_word='apple'"))).toEqual({senses:snapshot.v[0].senses,ipa_us:'PRIVATE IPA'});
 expect((await value("select count(*) n from user_words uw join words w on w.id=uw.word_id where w.normalized_word='apple'")).n).toBe(2);
});
it('enforces published-only RLS, own preferences, and denies user-parameter RPC bypass',async()=>{
 await seed();await db.query("select set_exam_book_v1($1,'cet4')",[a]);await db.query("select set_exam_book_v1($1,'cet6')",[b]);
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[b]);await db.exec('set local role authenticated');
 expect((await value('select count(*) n from exam_books')).n).toBe(2);
 expect((await value('select count(*) n from user_book_preferences')).n).toBe(1);
 expect((await value('select user_id from user_book_preferences')).user_id).toBe(b);
 expect((await value("select has_function_privilege(current_user,'list_exam_books_v1(uuid)','execute') ok")).ok).toBe(false);
 expect((await value("select has_table_privilege(current_user,'daily_book_targets','select') ok")).ok).toBe(false);
 await db.exec('reset role');
});
it('keeps due cards and active sessions byte-for-byte and supports non-destructive rollback',async()=>{
 await seed();
 await db.exec("insert into words(normalized_word,display_word) values('due-outside-book','due-outside-book')");
 await db.query("insert into user_words(user_id,word_id,status,fsrs_reps,fsrs_stability,next_review_at) select $1,id,'review',5,12,now()-interval '1 day' from words",[b]);
 await db.query("insert into study_sessions(user_id,state) values($1,'{\"phase\":\"lesson_explain\",\"current_word\":\"due-outside-book\"}')",[b]);
 const cards=await value('select jsonb_agg(to_jsonb(uw)) v from user_words uw');
 const sessions=await value('select jsonb_agg(to_jsonb(s)) v from study_sessions s');
 await db.query("select set_exam_book_v1($1,'cet6')",[b]);
 await db.query('select prepare_daily_new_words_budget_v1($1,current_date+1,2)',[b]);
 expect(await value("select jsonb_agg(to_jsonb(uw)) v from user_words uw where status='review'")).toEqual(cards);
 expect(await value('select jsonb_agg(to_jsonb(s)) v from study_sessions s')).toEqual(sessions);
 const old=await value("select prosrc from pg_proc where oid='prepare_daily_new_words_pre_exam_v1(uuid,date,integer)'::regprocedure");
 // Execute the rollback body inside this test's transaction.
 const rollback=readFileSync(new URL('../supabase/rollback/builtin_exam_books.sql',import.meta.url),'utf8');
 await db.exec(rollback.slice(rollback.indexOf('drop function'),rollback.indexOf('commit;')));
 expect(await value("select prosrc from pg_proc where oid='prepare_daily_new_words_budget_v1(uuid,date,integer)'::regprocedure")).toEqual(old);
 expect(await value('select jsonb_agg(to_jsonb(s)) v from study_sessions s')).toEqual(sessions);
});
