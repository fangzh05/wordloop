-- Let WordLoop exclude words already visited in a formal Lesson across local
-- day boundaries, while leaving Review and Pretest history out of that set.
create or replace function public.get_formal_lesson_attempt_words_v1(
  p_user_id uuid,
  p_before timestamptz default null
)
returns table(normalized_word text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct w.normalized_word
  from public.attempts a
  join public.words w on w.id = a.word_id
  where a.user_id = p_user_id
    and a.activity_type in (
      'exact_cloze', 'cloze', 'translation_cn_to_en', 'translation_en_to_cn',
      'collocation', 'derivation', 'recall', 'sentence', 'spelling',
      'word_recall', 'semantic_expression'
    )
    and (p_before is null or a.created_at < p_before);
$$;

-- If a formal Lesson happened while the card remained status='new', prevent
-- tomorrow's pool from presenting that same card as a fresh word again.
create index if not exists attempts_formal_lesson_word_idx
  on public.attempts(user_id, word_id)
  where activity_type in (
    'exact_cloze', 'cloze', 'translation_cn_to_en', 'translation_en_to_cn',
    'collocation', 'derivation', 'recall', 'sentence', 'spelling',
    'word_recall', 'semantic_expression'
  );

create or replace function public.prepare_daily_new_words_v1(p_user_id uuid,p_date date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_import_id uuid;
  v_limit integer;
  v_today_assigned integer;
  v_pool_count integer;
  v_remaining integer;
  v_start integer;
  v_added integer := 0;
begin
  insert into users(id) values(p_user_id) on conflict(id) do nothing;

  select daily_new_word_limit into v_limit
  from users where id=p_user_id;

  insert into daily_imports(user_id,import_date,source,raw_count)
  values(p_user_id,p_date,'wordloop_pool',0)
  on conflict(user_id,import_date,source) do update set source=excluded.source
  returning id into v_import_id;

  select count(distinct diw.word_id) into v_today_assigned
  from daily_imports di
  join daily_import_words diw on diw.import_id=di.id
  where di.user_id=p_user_id and di.import_date=p_date;

  select coalesce(max(position)+1,0), count(*) into v_start,v_pool_count
  from daily_import_words where import_id=v_import_id;

  v_remaining := greatest(v_limit-v_today_assigned,0);

  if v_remaining > 0 then
    insert into daily_import_words(import_id,word_id,position)
    select v_import_id, candidates.word_id,
      v_start + (row_number() over(order by candidates.first_seen_at,candidates.id)-1)::integer
    from (
      select uw.id,uw.word_id,uw.first_seen_at
      from user_words uw
      where uw.user_id=p_user_id
        and uw.status='new'
        and uw.mastered=false
        and not exists (
          select 1
          from attempts a
          where a.user_id=uw.user_id
            and a.word_id=uw.word_id
            and a.activity_type in (
              'exact_cloze', 'cloze', 'translation_cn_to_en', 'translation_en_to_cn',
              'collocation', 'derivation', 'recall', 'sentence', 'spelling',
              'word_recall', 'semantic_expression'
            )
        )
        and not exists (
          select 1
          from daily_imports di
          join daily_import_words diw on diw.import_id=di.id
          where di.user_id=p_user_id
            and di.import_date=p_date
            and diw.word_id=uw.word_id
        )
      order by uw.first_seen_at,uw.id
      limit v_remaining
    ) candidates
    on conflict do nothing;
    get diagnostics v_added = row_count;
  end if;

  select count(distinct diw.word_id) into v_today_assigned
  from daily_imports di
  join daily_import_words diw on diw.import_id=di.id
  where di.user_id=p_user_id and di.import_date=p_date;

  select count(*) into v_pool_count
  from daily_import_words where import_id=v_import_id;
  update daily_imports set raw_count=v_pool_count where id=v_import_id;

  return jsonb_build_object(
    'date',p_date,
    'prepared',v_today_assigned,
    'added',v_added,
    'limit',v_limit
  );
end;
$$;

revoke all on function public.prepare_daily_new_words_v1(uuid,date) from public,anon,authenticated;
grant execute on function public.prepare_daily_new_words_v1(uuid,date) to service_role;

revoke all on function public.get_formal_lesson_attempt_words_v1(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_formal_lesson_attempt_words_v1(uuid, timestamptz)
  to service_role;
