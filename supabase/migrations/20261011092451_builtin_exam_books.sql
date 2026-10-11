-- All books start unpublished. Publication is a separate reviewed admin task.
create table public.exam_books (
 id text primary key check(id in ('kaoyan','cet4','cet6','ielts','toefl')),
 name_zh text not null, name_en text not null, sort_order integer not null,
 source text not null, source_version text not null, license text not null,
 checksum text, is_available boolean not null default false,
 is_public boolean not null default false, published_at timestamptz,
 check(not is_public or (is_available and published_at is not null and length(checksum)=64 and length(license)>0))
);
insert into public.exam_books(id,name_zh,name_en,sort_order,source,source_version,license) values
 ('kaoyan','考研英语','Postgraduate English',0,'pending authorized public dataset','pending','pending'),
 ('cet4','大学英语四级','CET-4',1,'ECDICT','bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b','MIT'),
 ('cet6','大学英语六级','CET-6',2,'ECDICT','bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b','MIT'),
 ('ielts','雅思 IELTS','IELTS',3,'ECDICT','bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b','MIT'),
 ('toefl','托福 TOEFL','TOEFL',4,'ECDICT','bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b','MIT');
create table public.exam_book_words (
 book_id text not null references public.exam_books(id),
 normalized_word text not null check(normalized_word=lower(btrim(normalized_word))),
 source text not null, source_version text not null,
 source_records integer[] not null,
 primary key(book_id,normalized_word)
);
create index exam_word_lookup on public.exam_book_words(normalized_word,book_id);
create table public.user_book_preferences (
 user_id uuid primary key references public.users(id) on delete cascade,
 book_id text not null references public.exam_books(id),
 previous_book_id text references public.exam_books(id),
 effective_date date not null, updated_at timestamptz not null default now()
);
create table public.daily_book_targets (
 user_id uuid not null references public.users(id) on delete cascade,
 local_date date not null, book_id text references public.exam_books(id),
 private_kaoyan boolean not null default false,
 primary key(user_id,local_date)
);
alter table public.exam_books enable row level security;
alter table public.exam_book_words enable row level security;
alter table public.user_book_preferences enable row level security;
alter table public.daily_book_targets enable row level security;
revoke all on public.exam_books,public.exam_book_words,public.user_book_preferences,public.daily_book_targets from public,anon,authenticated;
grant select on public.exam_books,public.exam_book_words to authenticated;
grant select on public.user_book_preferences to authenticated;
grant all on public.exam_books,public.exam_book_words,public.user_book_preferences,public.daily_book_targets to service_role;
create policy published_books on public.exam_books for select to authenticated using(is_public and is_available);
create policy published_words on public.exam_book_words for select to authenticated using(exists(select 1 from public.exam_books b where b.id=book_id and b.is_public and b.is_available));
create policy own_book_preference on public.user_book_preferences for select to authenticated using(user_id=(select auth.uid()));
-- Preference writes go through the authenticated backend, which verifies availability,
-- preserves today's goal and chooses tomorrow using the user's database timezone.
create function public.set_exam_book_v1(p_user_id uuid,p_book_id text) returns jsonb language plpgsql set search_path=public as $$
declare d date; old text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,482));
 select (now() at time zone timezone)::date into d from users where id=p_user_id;
 if d is null then raise exception 'Unknown user'; end if;
 if not exists(select 1 from exam_books where id=p_book_id and is_public and is_available) and not
 (p_book_id='kaoyan' and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp')
 and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc')) then raise exception 'Book unavailable'; end if;
 select case when effective_date>d then previous_book_id else book_id end into old from user_book_preferences where user_id=p_user_id;
 if not found and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp')
 and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc') then old:='kaoyan';end if;
 insert into user_book_preferences(user_id,book_id,previous_book_id,effective_date) values(p_user_id,p_book_id,old,d+1)
 on conflict(user_id) do update set book_id=excluded.book_id,previous_book_id=excluded.previous_book_id,effective_date=excluded.effective_date,updated_at=now();
 return jsonb_build_object('book_id',p_book_id,'effective_date',d+1);
end $$;
create function public.exam_word_in_scope_v1(p_user_id uuid,p_date date,p_word_id uuid) returns boolean language sql stable set search_path=public as $$
 select exists(select 1 from daily_book_targets t join words w on w.id=p_word_id where t.user_id=p_user_id and t.local_date=p_date and (
 (t.private_kaoyan and exists(select 1 from word_sources s where s.user_id=p_user_id and s.word_id=p_word_id and s.source_book_id in ('ougkp','athgc')))
 or (not t.private_kaoyan and exists(select 1 from exam_book_words bw join exam_books b on b.id=bw.book_id
 where bw.book_id=t.book_id and bw.normalized_word=w.normalized_word and b.is_public and b.is_available))));
$$;
create function public.prepare_exam_pool_v1(p_user_id uuid,p_date date,p_limit integer) returns void language plpgsql set search_path=public as $$
declare target text; private_book boolean; remaining integer; item record; wid uuid;
begin
 select case when effective_date>p_date then previous_book_id else book_id end into target from user_book_preferences where user_id=p_user_id;
 if not found and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp')
 and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc') then target:='kaoyan';end if;
 private_book:=target='kaoyan' and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp')
 and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc');
 insert into daily_book_targets(user_id,local_date,book_id,private_kaoyan) values(p_user_id,p_date,target,coalesce(private_book,false)) on conflict do nothing;
 select book_id,private_kaoyan into target,private_book from daily_book_targets where user_id=p_user_id and local_date=p_date;
 if target is null or private_book then return;end if;
 select greatest(0,p_limit-count(*)) into remaining from user_words uw where uw.user_id=p_user_id and uw.status='new' and not uw.mastered
 and public.exam_word_in_scope_v1(p_user_id,p_date,uw.word_id)
 and not exists(select 1 from attempts a where a.user_id=p_user_id and a.word_id=uw.word_id and a.activity_type in
 ('exact_cloze','cloze','translation_cn_to_en','translation_en_to_cn','collocation','derivation','recall','sentence','spelling','word_recall','semantic_expression'))
 and not exists(select 1 from daily_import_words diw join daily_imports di on di.id=diw.import_id where di.user_id=p_user_id and di.import_date=p_date and diw.word_id=uw.word_id);
 for item in select bw.normalized_word,d.chinese_translation,d.parts_of_speech from exam_book_words bw
 join exam_books b on b.id=bw.book_id and b.is_public and b.is_available
 join lateral(select chinese_translation,parts_of_speech from lexical_dictionary_entries where language='en' and lemma=bw.normalized_word and chinese_translation<>'' order by imported_at desc,entry_id limit 1)d on true
 where bw.book_id=target and not exists(select 1 from words w join user_words uw on uw.word_id=w.id where uw.user_id=p_user_id and w.normalized_word=bw.normalized_word)
 order by bw.normalized_word limit least(200,remaining)
 loop
  insert into words(normalized_word,display_word,senses,lexical_source,lexical_updated_at)
  values(item.normalized_word,item.normalized_word,
   coalesce((select jsonb_agg(jsonb_build_object('pos',coalesce(g->>'label',''),'definition_cn',g->>'definition_zh')) from jsonb_array_elements(item.parts_of_speech)g where coalesce(g->>'definition_zh','')<>''),jsonb_build_array(jsonb_build_object('pos','','definition_cn',item.chinese_translation))),
   'ECDICT',now()) on conflict(normalized_word) do nothing;
  select id into wid from words where normalized_word=item.normalized_word;
  insert into user_words(user_id,word_id,source) values(p_user_id,wid,'exam_book') on conflict(user_id,word_id) do nothing;
 end loop;
end $$;
create function public.list_exam_books_v1(p_user_id uuid) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('selected_book_id',coalesce((select book_id from user_book_preferences where user_id=p_user_id),case when
 exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp') and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc') then 'kaoyan' end),
 'effective_date',(select effective_date from user_book_preferences where user_id=p_user_id),
 'books',(select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name_zh,'source',b.source,'source_version',b.source_version,'license',b.license,
 'is_public',b.is_public,'available',b.is_public and b.is_available or own.private_book,'published_at',b.published_at,
 'scope',case when own.private_book then 'private' else 'public' end,
 'unavailable_reason',case when b.is_public and b.is_available or own.private_book then null when b.id='kaoyan' then '公共词表授权与数据待准备' else '数据尚未完成复核和发布' end,
 'total',stats.total,'in_learning',stats.enrolled,'mastered',stats.mastered,'not_enrolled',stats.total-stats.enrolled)
 order by b.sort_order) from exam_books b
 cross join lateral(select b.id='kaoyan' and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp') and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc') private_book)own
 cross join lateral(select count(*) total,count(uw.id) enrolled,count(uw.id) filter(where uw.mastered) mastered from (
 select normalized_word from exam_book_words where book_id=b.id and b.is_public and b.is_available and not own.private_book
 union select w.normalized_word from word_sources s join words w on w.id=s.word_id where own.private_book and s.user_id=p_user_id and s.source_book_id in ('ougkp','athgc')
 ) scope left join words w on w.normalized_word=scope.normalized_word left join user_words uw on uw.word_id=w.id and uw.user_id=p_user_id)stats));
$$;
-- Clone the LIVE allocator instead of replaying a stale budget implementation.
-- Preserve the original function for rollback; fail closed if its insertion sites drift.
do $$
declare original text; patched text; marker text := E'  if v_remaining > 0 then'; filter_marker text:=E'        and uw.status=''new''';
begin
 original:=pg_get_functiondef('public.prepare_daily_new_words_budget_v1(uuid,date,integer)'::regprocedure);
 original:=replace(original,E'\r\n',E'\n');
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 or
 (length(original)-length(replace(original,filter_marker,'')))/length(filter_marker)<>1 then raise exception 'Allocator drift: review migration before applying';end if;
 alter function public.prepare_daily_new_words_budget_v1(uuid,date,integer) rename to prepare_daily_new_words_pre_exam_v1;
 patched:=replace(original,marker,marker||E'\n    perform public.prepare_exam_pool_v1(p_user_id,p_date,v_remaining);');
 patched:=replace(patched,filter_marker,filter_marker||E'\n        and public.exam_word_in_scope_v1(p_user_id,p_date,uw.word_id)');
 execute patched;
end $$;
revoke all on function public.set_exam_book_v1(uuid,text),public.list_exam_books_v1(uuid),public.exam_word_in_scope_v1(uuid,date,uuid),public.prepare_exam_pool_v1(uuid,date,integer),public.prepare_daily_new_words_budget_v1(uuid,date,integer) from public,anon,authenticated;
grant execute on function public.set_exam_book_v1(uuid,text),public.list_exam_books_v1(uuid),public.exam_word_in_scope_v1(uuid,date,uuid),public.prepare_exam_pool_v1(uuid,date,integer),public.prepare_daily_new_words_budget_v1(uuid,date,integer) to service_role;
