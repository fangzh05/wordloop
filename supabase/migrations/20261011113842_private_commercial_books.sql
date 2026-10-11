-- No commercial payload or entitlements are seeded. Rights must be verified separately.
alter table public.exam_books drop constraint exam_books_id_check;
alter table public.exam_books add constraint exam_books_id_check check(id in
 ('kaoyan','cet4','cet6','ielts','toefl','ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo'));
alter table public.exam_books add constraint commercial_books_never_public check
 (id in ('kaoyan','cet4','cet6','ielts','toefl') or not is_public);
alter table public.exam_books add constraint missing_commercial_source_unavailable check(not is_available or source<>'source_missing');
insert into public.exam_books(id,name_zh,name_en,sort_order,source,source_version,license) values
 ('ielts-wanglu-807-listening','王陆807听力（第2版）','Wang Lu IELTS Listening',5,'lilinji/English','6996d60339f21501efb7796a959165e083b5a7f5','private_review_required'),
 ('ielts-zhenjing','雅思词汇真经','IELTS Zhenjing',6,'hefengxian/my-ielts','5cef573933663c4673c6e0093f1df04e68018b1a','private_review_required'),
 ('toefl-xindongfang','新东方托福','New Oriental TOEFL',7,'source_missing','pending','private_review_required'),
 ('cet6-xinghuo','星火6级词汇必背','Xinghuo CET-6',8,'lilinji/English','6996d60339f21501efb7796a959165e083b5a7f5','private_review_required');

create table public.exam_book_entitlements (
 user_id uuid not null references public.users(id), book_id text not null references public.exam_books(id),
 rights_evidence text not null check(length(btrim(rights_evidence))>20),
 verified_at timestamptz not null, expires_at timestamptz,
 third_party_processing_allowed boolean not null default false,
 primary key(user_id,book_id)
);
create table public.source_definition_batches (
 id text primary key, book_id text not null references public.exam_books(id),
 source_commit text not null check(length(source_commit)=40), source_sha256 text not null check(length(source_sha256)=64),
 created_at timestamptz not null default now(), record_count integer not null check(record_count>=0),
 unique(id,book_id)
);
-- Extension of the existing shared word identity, never a second dictionary or scheduler.
create table public.word_source_definitions (
 book_id text not null references public.exam_books(id) check(book_id in ('ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo')), entry_key text not null,
 normalized_word text not null references public.words(normalized_word),
 batch_id text not null, source_row integer not null, source_locator text not null,
 content_hash text not null check(length(content_hash)=64),
 senses jsonb not null check(jsonb_typeof(senses)='array'), definition_raw text not null,
 ipa_uk text, ipa_us text, chapter text, category text, logical_group text,
 provenance jsonb not null, visibility text not null default 'private' check(visibility='private'),
 license_scope text not null default 'private_review_required',
 is_ai_generated boolean not null default false,
 primary key(book_id,entry_key), foreign key(batch_id,book_id) references public.source_definition_batches(id,book_id)
);
create index source_definitions_word on public.word_source_definitions(book_id,normalized_word,source_row,entry_key);
alter table public.exam_book_entitlements enable row level security;
alter table public.source_definition_batches enable row level security;
alter table public.word_source_definitions enable row level security;
revoke all on public.exam_book_entitlements,public.source_definition_batches,public.word_source_definitions from public,anon,authenticated;
grant all on public.exam_book_entitlements,public.source_definition_batches,public.word_source_definitions to service_role;
-- Defense in depth. No direct authenticated SELECT grant: prevents Data API bulk export.
create policy licensed_source_definitions on public.word_source_definitions for select to authenticated
 using(exists(select 1 from public.exam_book_entitlements e where e.book_id=word_source_definitions.book_id
 and e.user_id=(select auth.uid()) and (e.expires_at is null or e.expires_at>now())));
create policy own_book_entitlement on public.exam_book_entitlements for select to authenticated using(user_id=(select auth.uid()));

create function public.can_access_exam_book_v1(p_user_id uuid,p_book_id text) returns boolean
 language sql stable set search_path=public as $$
 select exists(select 1 from exam_books b where b.id=p_book_id and b.is_available and
 (b.is_public or (b.source<>'source_missing' and exists(select 1 from word_source_definitions s where s.book_id=b.id) and exists(select 1 from exam_book_entitlements e where e.user_id=p_user_id and e.book_id=b.id and (e.expires_at is null or e.expires_at>now())))));
$$;
-- Patch only the publication predicate in the existing allocator/selection/scope.
-- Abort on baseline drift. Retain originals for a non-destructive rollback.
do $$
declare signature text; original text; patched text; name text; needle text;
begin
 foreach signature in array array['set_exam_book_v1(uuid,text)','exam_word_in_scope_v1(uuid,date,uuid)','prepare_exam_pool_v1(uuid,date,integer)'] loop
  original:=pg_get_functiondef(('public.'||signature)::regprocedure);
  name:=split_part(signature,'(',1);
  needle:=case when name='set_exam_book_v1' then 'id=p_book_id and is_public and is_available' else 'b.is_public and b.is_available' end;
  if (length(original)-length(replace(original,needle,'')))/length(needle)<>1 then raise exception 'Commercial predicate drift: %',signature;end if;
  if name='set_exam_book_v1' then
   patched:=replace(original,'id=p_book_id and is_public and is_available','id=p_book_id and public.can_access_exam_book_v1(p_user_id,id)');
  else
   patched:=replace(original,'b.is_public and b.is_available','public.can_access_exam_book_v1(p_user_id,b.id)');
  end if;
  if patched=original then raise exception 'Commercial baseline drift: %',signature; end if;
  if name='prepare_exam_pool_v1' then
   foreach needle in array array['join lateral(select chinese_translation','where bw.book_id=target and not exists'] loop
    if (length(patched)-length(replace(patched,needle,'')))/length(needle)<>1 then raise exception 'Commercial allocator drift';end if;
   end loop;
   patched:=replace(patched,'join lateral(select chinese_translation','left join lateral(select chinese_translation');
   patched:=replace(patched,'where bw.book_id=target and not exists',
    'where bw.book_id=target and (d.chinese_translation is not null or exists(select 1 from word_source_definitions sd where sd.book_id=target and sd.normalized_word=bw.normalized_word and sd.definition_raw<>'''')) and not exists');
  end if;
  execute 'alter function public.'||signature||' rename to '||name||'_pre_commercial_v1';
  execute 'revoke all on function public.'||replace(signature,name,name||'_pre_commercial_v1')||' from public,anon,authenticated';
  execute patched;
 end loop;
end $$;
-- Repoint compiled function dependencies to the patched scope function.
-- PostgreSQL resolves SQL bodies at execution with check_function_bodies enabled.
alter function public.list_exam_books_v1(uuid) rename to list_exam_books_pre_commercial_v1;
revoke all on function public.list_exam_books_pre_commercial_v1(uuid) from public,anon,authenticated;
grant execute on function public.list_exam_books_pre_commercial_v1(uuid) to service_role;
create function public.list_exam_books_v1(p_user_id uuid) returns jsonb language sql stable set search_path=public as $$
 with base as(select list_exam_books_pre_commercial_v1(p_user_id) v), private_books as (
 select jsonb_build_object('id',b.id,'name',b.name_zh,'source',b.source,'source_version',b.source_version,'license',b.license,
 'is_public',false,'available',true,'scope','private','unavailable_reason',null,'total',count(bw.normalized_word),
 'in_learning',count(uw.id),'mastered',count(uw.id) filter(where uw.mastered),'not_enrolled',count(bw.normalized_word)-count(uw.id)) v,b.sort_order
 from exam_books b left join exam_book_words bw on bw.book_id=b.id left join words w on w.normalized_word=bw.normalized_word
 left join user_words uw on uw.word_id=w.id and uw.user_id=p_user_id
 where b.id not in ('kaoyan','cet4','cet6','ielts','toefl') and can_access_exam_book_v1(p_user_id,b.id) group by b.id
 ), visible as (
 select item v,(item->>'id') id,(ordinality-1)::integer sort_order from base,jsonb_array_elements(base.v->'books') with ordinality items(item,ordinality) where item->>'id' in ('kaoyan','cet4','cet6','ielts','toefl')
 union all select v,v->>'id',sort_order from private_books
 ) select jsonb_set(jsonb_set(base.v,'{books}',coalesce((select jsonb_agg(v order by sort_order,id) from visible),'[]'::jsonb)),
 '{selected_book_id}',case when exists(select 1 from visible where id=base.v->>'selected_book_id') then base.v->'selected_book_id' else 'null'::jsonb end) from base;
$$;
-- Only one word per call, service role only, with entitlement and membership checks.
create function public.current_book_definitions_v1(p_user_id uuid,p_word text) returns jsonb language plpgsql stable set search_path=public as $$
declare target text; d date;
begin
 select (now() at time zone timezone)::date into d from users where id=p_user_id;
 select book_id into target from daily_book_targets where user_id=p_user_id and local_date=d;
 if not found then select case when effective_date>d then previous_book_id else book_id end into target from user_book_preferences where user_id=p_user_id;end if;
 if target is null or not can_access_exam_book_v1(p_user_id,target) then return '[]'::jsonb;end if;
 if not exists(select 1 from exam_book_words where book_id=target and normalized_word=p_word) then return '[]'::jsonb;end if;
 return coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('third_party_processing_allowed',e.third_party_processing_allowed) order by s.source_row,s.entry_key)
 from word_source_definitions s join exam_book_entitlements e on e.book_id=s.book_id and e.user_id=p_user_id
 where s.book_id=target and s.normalized_word=p_word),'[]'::jsonb);
end $$;
revoke all on function public.can_access_exam_book_v1(uuid,text),public.current_book_definitions_v1(uuid,text),public.list_exam_books_v1(uuid),public.set_exam_book_v1(uuid,text),public.exam_word_in_scope_v1(uuid,date,uuid),public.prepare_exam_pool_v1(uuid,date,integer) from public,anon,authenticated;
grant execute on function public.can_access_exam_book_v1(uuid,text),public.current_book_definitions_v1(uuid,text),public.list_exam_books_v1(uuid),public.set_exam_book_v1(uuid,text),public.exam_word_in_scope_v1(uuid,date,uuid),public.prepare_exam_pool_v1(uuid,date,integer) to service_role;

-- Non-exposed admin intake. The catalog stays unavailable until count/hash audit.
create schema commercial_import_admin;
revoke all on schema commercial_import_admin from public,anon,authenticated;
grant usage on schema commercial_import_admin to service_role;
create function commercial_import_admin.import_rows_v1(p_book text,p_batch text,p_rows jsonb) returns integer
language plpgsql security invoker set search_path=public as $$
declare total integer;
begin
 if p_book not in ('ielts-wanglu-807-listening','ielts-zhenjing','cet6-xinghuo','toefl-xindongfang') then raise exception 'Invalid private book';end if;
 if not exists(select 1 from source_definition_batches where id=p_batch and book_id=p_book) then raise exception 'Unknown source batch';end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>500 then raise exception 'Invalid intake size';end if;
 if exists(select 1 from jsonb_array_elements(p_rows)r where coalesce(r->>'normalized_word','')='' or r->>'normalized_word'<>lower(btrim(r->>'normalized_word'))
 or length(coalesce(r->>'entry_key',''))<>64 or length(coalesce(r->>'content_hash',''))<>64 or coalesce(r->>'definition_raw','')='' or coalesce(jsonb_typeof(r->'senses'),'null')<>'array'
 or coalesce(r->>'word','')='' or coalesce(r->>'source_row','')!~'^[1-9][0-9]*$' or coalesce(btrim(r->>'source_locator'),'')=''
 or coalesce(jsonb_typeof(r->'provenance'),'null')<>'object') then raise exception 'Invalid source record';end if;
 if exists(select 1 from jsonb_array_elements(p_rows)r group by r->>'entry_key' having count(*)>1) then raise exception 'DUPLICATE_ENTRY_KEY';end if;
 if exists(select 1 from jsonb_array_elements(p_rows)r join source_definition_batches b on b.id=p_batch and b.book_id=p_book
 where (r->'provenance'->>'commit') is distinct from b.source_commit or (r->'provenance'->>'sha256') is distinct from b.source_sha256) then raise exception 'BATCH_PROVENANCE_MISMATCH';end if;
 if exists(select 1 from jsonb_array_elements(p_rows)r join word_source_definitions s on s.book_id=p_book and s.entry_key=r->>'entry_key' where s.content_hash<>r->>'content_hash') then raise exception 'IMMUTABLE_SOURCE_DRIFT';end if;
 insert into words(normalized_word,display_word) select distinct on(r->>'normalized_word') r->>'normalized_word',r->>'word' from jsonb_array_elements(p_rows)r order by r->>'normalized_word',r->>'word' on conflict(normalized_word) do nothing;
 insert into exam_book_words(book_id,normalized_word,source,source_version,source_records)
 select p_book,r->>'normalized_word',r->'provenance'->>'repo',r->'provenance'->>'commit',array_agg((r->>'source_row')::integer order by (r->>'source_row')::integer)
 from jsonb_array_elements(p_rows)r group by r->>'normalized_word',r->'provenance'->>'repo',r->'provenance'->>'commit' on conflict(book_id,normalized_word) do update set source_records=(select array_agg(distinct n order by n) from unnest(exam_book_words.source_records||excluded.source_records)n);
 insert into word_source_definitions(book_id,entry_key,normalized_word,batch_id,source_row,source_locator,content_hash,senses,definition_raw,ipa_uk,ipa_us,chapter,category,logical_group,provenance)
 select p_book,r->>'entry_key',r->>'normalized_word',p_batch,(r->>'source_row')::integer,r->>'source_locator',r->>'content_hash',r->'senses',r->>'definition_raw',r->>'ipa_uk',r->>'ipa_us',r->>'chapter',r->>'category',r->>'logical_group',r->'provenance'
 from jsonb_array_elements(p_rows)r on conflict do nothing;
 get diagnostics total=row_count;return total;
end $$;
revoke all on function commercial_import_admin.import_rows_v1(text,text,jsonb) from public,anon,authenticated;
grant execute on function commercial_import_admin.import_rows_v1(text,text,jsonb) to service_role;
