import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
export async function privateBookTestDatabase(){
 const db=new PGlite();
 const read=(f:string)=>readFileSync(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8');
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 for(const f of ['202609130001_initial_wordloop.sql','202609130002_fsrs_shanbay.sql','202609150004_study_session_state.sql'])await db.exec(read(f).replace('create extension if not exists pgcrypto;',''));
 await db.exec(`alter table users add column if not exists daily_new_word_limit integer default 50;
 create function learning_budget_snapshot_v1(uuid) returns jsonb language sql as $$select '{"enabled":false}'::jsonb$$;
 create table lexical_dictionary_entries(entry_id text primary key,lemma text,language text default 'en',chinese_translation text,parts_of_speech jsonb,imported_at timestamptz default now());`);
 const baseline=read('20261004164746_cross_day_review_handoff.sql');await db.exec(baseline.slice(baseline.indexOf('create or replace function public.prepare_daily_new_words_budget_v1')));
 await db.exec(read('20261011092451_builtin_exam_books.sql'));await db.exec(read('20261011113842_private_commercial_books.sql'));
 return db;
}
