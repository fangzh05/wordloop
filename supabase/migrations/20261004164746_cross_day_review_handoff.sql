-- Finish each immutable Review snapshot before handing off to learning.
-- Preserve the existing budget, FSRS cards, learning history and assignment lock.
create or replace function public.learning_budget_snapshot_v1(p_user_id uuid) returns jsonb language plpgsql set search_path=public as $$
declare d date; tz text; minutes integer; extra integer; used integer; due integer; overdue integer; cap integer; forecasts jsonb; enabled boolean; started integer;
begin
 select coalesce(timezone,'Asia/Shanghai'),daily_new_word_limit into tz,cap from public.users where id=p_user_id;
 tz:=coalesce(tz,'Asia/Shanghai');d:=(now() at time zone tz)::date;
 select daily_minutes,budget_enabled into minutes,enabled from public.learning_settings where user_id=p_user_id;
 minutes:=coalesce(minutes,45); enabled:=coalesce(enabled,true);
 select coalesce(extra_seconds,0) into extra from public.learning_budget_days where user_id=p_user_id and local_date=d;
 select coalesce(sum(estimated_seconds),0) into used from public.learning_budget_events where user_id=p_user_id and local_date=d;
 select count(*) filter(where next_review_at<=now()),count(*) filter(where (next_review_at at time zone tz)::date<d) into due,overdue
 from public.user_words where user_id=p_user_id and next_review_at is not null;
 select jsonb_agg(jsonb_build_object('date',day,'review_seconds',seconds) order by day) into forecasts from (
 select d+i as day, count(uw.id)*8 as seconds from generate_series(0,6) i left join public.user_words uw
 on uw.user_id=p_user_id and (uw.next_review_at at time zone tz)::date=d+i group by i) x;
 select count(*) into started from (
 select word_id,min(reviewed_at) as first_pretest from public.fsrs_review_logs
 where user_id=p_user_id and review_source='pretest' group by word_id
 ) firsts where (first_pretest at time zone tz)::date=d;
 return jsonb_build_object('date',d,'daily_minutes',minutes,'extra_seconds',coalesce(extra,0),'estimated_used_seconds',used,
 'remaining_seconds',greatest(0,minutes*60+coalesce(extra,0)-used),'due_count',due,'overdue_count',overdue,
 'new_words_started_today',started,'new_word_cap',coalesce(cap,50),'forecast',forecasts,'cost_version','static-v1','enabled',enabled);
end $$;

create or replace function public.prepare_daily_new_words_budget_v1(p_user_id uuid,p_date date,p_budget_limit integer default 200)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_import_id uuid;
  v_limit integer;
  v_today_assigned integer;
  v_pool_count integer;
  v_remaining integer;
  v_start integer;
  v_added integer := 0;
  v_budget jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,482));
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

  v_budget := public.learning_budget_snapshot_v1(p_user_id);
  if (v_budget->>'enabled')::boolean then
    v_limit := least(v_limit,greatest(0,p_budget_limit));
    if (v_budget->>'overdue_count')::integer>0 then
      v_limit:=least(v_limit,6,coalesce((v_budget->>'new_words_started_today')::integer,0)
        +floor(greatest(0,(v_budget->>'remaining_seconds')::integer)/77.0)::integer);
    else v_limit:=least(v_limit, floor(greatest(0,(v_budget->>'remaining_seconds')::integer-(v_budget->>'due_count')::integer*8)/77.0)::integer); end if;
  end if;
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
