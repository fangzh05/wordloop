-- Keep the legacy progress response shape, but calculate stability only from
-- cards that have entered FSRS. The new Insights API provides null for an
-- empty/invalid sample; this compatibility field remains numeric for clients.
create or replace function public.get_progress_snapshot_v1(
  p_user_id uuid,
  p_now timestamptz
)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  with user_settings as (
    select
      coalesce(max(u.timezone), 'Asia/Shanghai') as time_zone,
      coalesce(max(u.daily_new_word_limit), 50)::integer as daily_new_word_limit
    from public.users as u
    where u.id = p_user_id
  ),
  calendar as (
    select
      time_zone,
      daily_new_word_limit,
      (p_now at time zone time_zone)::date as today_date
    from user_settings
  ),
  today_words as (
    select distinct on (diw.word_id)
      uw.status
    from public.daily_imports as di
    join public.daily_import_words as diw on diw.import_id = di.id
    join public.user_words as uw
      on uw.user_id = p_user_id
     and uw.word_id = diw.word_id
    cross join calendar as c
    where di.user_id = p_user_id
      and di.import_date = c.today_date
    order by diw.word_id, di.created_at, di.id, diw.position, diw.word_id
  ),
  today_counts as (
    select
      count(*)::integer as total,
      count(*) filter (where status = 'known')::integer as known,
      count(*) filter (where status = 'uncertain')::integer as uncertain,
      count(*) filter (where status = 'unknown')::integer as unknown,
      count(*) filter (where status <> 'new')::integer as completed
    from today_words
  ),
  all_counts as (
    select
      count(*)::integer as total_words,
      count(*) filter (where mastered)::integer as mastered,
      (
        count(*)
        - count(*) filter (where mastered)
        - count(*) filter (where (
          meaning_error or collocation_error or grammar_error
          or pronunciation_error or spelling_error
        ))
      )::integer as learning,
      count(*) filter (where (
        meaning_error or collocation_error or grammar_error
        or pronunciation_error or spelling_error
      ))::integer as error_book
    from public.user_words
    where user_id = p_user_id
  ),
  fsrs_counts as (
    select
      count(*) filter (where uw.next_review_at <= p_now)::integer as due_now,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date <= c.today_date)::integer as due_today,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date = (c.today_date + 1))::integer as tomorrow,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date <= (c.today_date + 7))::integer as due_next_7_days,
      coalesce(round((avg(uw.fsrs_stability) filter (
        where uw.fsrs_reps > 0
          and uw.fsrs_stability > 0
          and uw.fsrs_stability < 'Infinity'::double precision
      ))::numeric, 2), 0)::double precision as average_stability
    from public.user_words as uw
    cross join calendar as c
    where uw.user_id = p_user_id
      and uw.fsrs_reps > 0
  )
  select jsonb_build_object(
    'today', jsonb_build_object(
      'total', tc.total, 'known', tc.known, 'uncertain', tc.uncertain,
      'unknown', tc.unknown, 'completed', tc.completed
    ),
    'all_time', jsonb_build_object(
      'total_words', ac.total_words, 'mastered', ac.mastered,
      'learning', ac.learning, 'error_book', ac.error_book
    ),
    'fsrs', jsonb_build_object(
      'due_now', fc.due_now, 'due_today', fc.due_today,
      'tomorrow', fc.tomorrow, 'due_next_7_days', fc.due_next_7_days,
      'average_stability', fc.average_stability
    ),
    'settings', jsonb_build_object('daily_new_word_limit', c.daily_new_word_limit)
  )
  from today_counts as tc
  cross join all_counts as ac
  cross join fsrs_counts as fc
  cross join calendar as c;
$$;

revoke all on function public.get_progress_snapshot_v1(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.get_progress_snapshot_v1(uuid, timestamptz) to service_role;
