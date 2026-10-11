-- Commercial IDs are internal sources, never learning targets. No payload import.
update public.exam_books set is_available=false,is_public=false where id not in ('cet4','cet6','kaoyan','ielts','toefl');
alter table public.exam_books add constraint internal_sources_not_selectable check(id in ('cet4','cet6','kaoyan','ielts','toefl') or not is_available);
create table public.exam_definition_sources (
 exam_id text not null references public.exam_books(id) check(exam_id in ('cet4','cet6','kaoyan','ielts','toefl')),
 source_book_id text not null references public.exam_books(id) check(source_book_id in ('ielts-zhenjing','ielts-wanglu-807-listening','cet6-xinghuo','toefl-xindongfang')),
 priority integer not null check(priority>0), enabled boolean not null default false,
 primary key(exam_id,source_book_id)
);
insert into public.exam_definition_sources(exam_id,source_book_id,priority) values
 ('cet6','cet6-xinghuo',10),('ielts','ielts-zhenjing',10),('ielts','ielts-wanglu-807-listening',20);
alter table public.exam_definition_sources enable row level security;
revoke all on public.exam_definition_sources from public,anon,authenticated;
grant all on public.exam_definition_sources to service_role;

create or replace function public.can_access_exam_book_v1(p_user_id uuid,p_book_id text) returns boolean
language sql stable set search_path=public as $$
 select exists(select 1 from exam_books where id=p_book_id and id in ('cet4','cet6','kaoyan','ielts','toefl') and is_public and is_available);
$$;
-- Source permission is independent from target availability. Check expiry on every read.
create or replace function public.can_access_private_source_v1(p_user_id uuid,p_book_id text) returns boolean
language sql stable set search_path=public as $$
 select exists(select 1 from exam_book_entitlements e join exam_books b on b.id=e.book_id
 where e.user_id=p_user_id and e.book_id=p_book_id and not b.is_public and b.source<>'source_missing'
 and (e.expires_at is null or e.expires_at>now())
 and exists(select 1 from exam_definition_sources m where m.source_book_id=e.book_id and m.enabled)
 and exists(select 1 from word_source_definitions s where s.book_id=e.book_id));
$$;
create or replace function public.current_book_definitions_v1(p_user_id uuid,p_word text) returns jsonb
language plpgsql stable set search_path=public as $$
declare target text; d date;
begin
 select (now() at time zone timezone)::date into d from users where id=p_user_id;
 select book_id into target from daily_book_targets where user_id=p_user_id and local_date=d;
 if not found then select case when effective_date>d then previous_book_id else book_id end into target from user_book_preferences where user_id=p_user_id;end if;
 if target is null or not can_access_exam_book_v1(p_user_id,target) then return '[]'::jsonb;end if;
 if not exists(select 1 from exam_book_words where book_id=target and normalized_word=p_word) then return '[]'::jsonb;end if;
 return coalesce((select jsonb_agg(jsonb_build_object('book_id',s.book_id,'entry_key',s.entry_key,
 'definition_raw',s.definition_raw,'senses',s.senses,'ipa_us',s.ipa_us,'ipa_uk',s.ipa_uk,
 'chapter',s.chapter,'category',s.category,'is_ai_generated',s.is_ai_generated,
 'third_party_processing_allowed',e.third_party_processing_allowed) order by m.priority,s.source_row,s.entry_key)
 from exam_definition_sources m join word_source_definitions s on s.book_id=m.source_book_id
 join exam_book_entitlements e on e.book_id=s.book_id and e.user_id=p_user_id
 where m.exam_id=target and m.enabled and s.normalized_word=p_word and not s.is_ai_generated
 and can_access_private_source_v1(p_user_id,s.book_id)),'[]'::jsonb);
end $$;
-- Keep the existing allocator, budget and FSRS contract. Extend its lexical gate only.
do $$
declare body text; needle text := 'exists(select 1 from word_source_definitions sd where sd.book_id=target and sd.normalized_word=bw.normalized_word and sd.definition_raw<>'''')';
begin
 body:=pg_get_functiondef('public.prepare_exam_pool_v1(uuid,date,integer)'::regprocedure);
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'Exam source allocator drift';end if;
 body:=replace(body,needle,'exists(select 1 from exam_definition_sources m join word_source_definitions sd on sd.book_id=m.source_book_id where m.exam_id=target and m.enabled and sd.normalized_word=bw.normalized_word and sd.definition_raw<>'''' and can_access_private_source_v1(p_user_id,sd.book_id))');
 execute body;
end $$;
-- The existing owner's private Kaoyan pool must retain all personal entries and
-- also see independently evidenced additions to the shared Kaoyan membership.
do $$
declare body text; needle text;
begin
 body:=pg_get_functiondef('public.list_exam_books_pre_commercial_v1(uuid)'::regprocedure);
 foreach needle in array array['from exam_books b','and not own.private_book'] loop
  if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'Five-book catalog baseline drift';end if;
 end loop;
 body:=replace(body,'list_exam_books_pre_commercial_v1','list_exam_books_source_scope_v1');
 body:=replace(body,'from exam_books b','from (select * from exam_books where id in (''cet4'',''cet6'',''kaoyan'',''ielts'',''toefl'')) b');
 execute replace(body,'and not own.private_book','');
 body:=pg_get_functiondef('public.exam_word_in_scope_v1(uuid,date,uuid)'::regprocedure);
 needle:='not t.private_kaoyan and exists';
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'Kaoyan scope drift';end if;
 execute replace(body,needle,'exists');
 body:=pg_get_functiondef('public.prepare_exam_pool_v1(uuid,date,integer)'::regprocedure);
 needle:='if target is null or private_book then return;end if;';
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'Kaoyan allocator drift';end if;
 execute replace(body,needle,'if target is null then return;end if;');
end $$;
create or replace function public.list_exam_books_v1(p_user_id uuid) returns jsonb
language sql stable set search_path=public as $$
 with base as(select list_exam_books_source_scope_v1(p_user_id) v), visible as (
 select item v,n from base,jsonb_array_elements(base.v->'books') with ordinality items(item,n)
 where item->>'id' in ('cet4','cet6','kaoyan','ielts','toefl')
 ) select jsonb_set(jsonb_set(base.v,'{books}',coalesce((select jsonb_agg(v order by n) from visible),'[]'::jsonb)),
 '{selected_book_id}',case when base.v->>'selected_book_id' in ('cet4','cet6','kaoyan','ielts','toefl') then base.v->'selected_book_id' else 'null'::jsonb end) from base;
$$;
revoke all on function public.list_exam_books_source_scope_v1(uuid),public.can_access_private_source_v1(uuid,text),public.can_access_exam_book_v1(uuid,text),public.current_book_definitions_v1(uuid,text),public.list_exam_books_v1(uuid) from public,anon,authenticated;
grant execute on function public.list_exam_books_source_scope_v1(uuid),public.can_access_private_source_v1(uuid,text),public.can_access_exam_book_v1(uuid,text),public.current_book_definitions_v1(uuid,text),public.list_exam_books_v1(uuid) to service_role;
