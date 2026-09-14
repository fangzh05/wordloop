-- Daily queue repair and configurable daily-new-word limit.
-- Safe to run after 202609130001 + 202609130002. It intentionally preserves
-- all existing imports, attempts, FSRS cards, and error-layer state.

alter table public.users
  drop constraint if exists users_daily_new_word_limit_check;

alter table public.users
  add constraint users_daily_new_word_limit_check
  check (daily_new_word_limit between 1 and 200);

create or replace function public.set_daily_new_word_limit_v1(p_user_id uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_limit not between 1 and 200 then
    raise exception 'Daily new word limit must be between 1 and 200';
  end if;
  insert into users(id,daily_new_word_limit) values(p_user_id,p_limit)
  on conflict(id) do update set daily_new_word_limit=excluded.daily_new_word_limit;
  return jsonb_build_object('daily_new_word_limit',p_limit);
end;
$$;

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

  -- The limit applies to the complete daily list, including queues created by
  -- older/manual imports, not just the WordLoop vocabulary-pool row.
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
        -- A word scheduled yesterday remains eligible today while still new.
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
revoke all on function public.set_daily_new_word_limit_v1(uuid,integer) from public,anon,authenticated;
grant execute on function public.prepare_daily_new_words_v1(uuid,date) to service_role;
grant execute on function public.set_daily_new_word_limit_v1(uuid,integer) to service_role;
