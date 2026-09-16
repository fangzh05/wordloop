-- WordLoop hot-path query consolidation.
-- This migration only adds read indexes and read/aggregation RPCs. It does not
-- alter user data, scheduling state, grading, or study-session semantics.

create index if not exists user_words_active_error_idx
  on public.user_words(user_id)
  where meaning_error
     or collocation_error
     or grammar_error
     or pronunciation_error
     or spelling_error;

create index if not exists user_words_new_pool_idx
  on public.user_words(user_id, first_seen_at, id)
  where status = 'new' and mastered = false;

create or replace function public.get_today_words_v2(p_user_id uuid, p_date date)
returns table(
  word text,
  display_word text,
  status text,
  source text,
  consecutive_correct integer,
  wrong_count integer,
  mastered boolean,
  next_review_at timestamptz,
  meaning_error boolean,
  collocation_error boolean,
  grammar_error boolean,
  pronunciation_error boolean,
  spelling_error boolean,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_scheduled_days integer,
  fsrs_state smallint,
  ipa_us text,
  ipa_uk text,
  senses jsonb
)
language sql stable set search_path = public as $$
  with canonical_rows as (
    select
      di.created_at as import_created_at,
      di.id as import_id,
      diw.position,
      diw.word_id,
      w.normalized_word,
      w.display_word,
      w.ipa_us,
      w.ipa_uk,
      w.senses,
      uw.status,
      uw.source,
      uw.consecutive_correct,
      uw.wrong_count,
      uw.mastered,
      uw.next_review_at,
      uw.meaning_error,
      uw.collocation_error,
      uw.grammar_error,
      uw.pronunciation_error,
      uw.spelling_error,
      uw.fsrs_stability,
      uw.fsrs_difficulty,
      uw.fsrs_scheduled_days,
      uw.fsrs_state,
      row_number() over (
        partition by diw.word_id
        order by di.created_at, di.id, diw.position, diw.word_id
      ) as canonical_rank
    from public.daily_imports as di
    join public.daily_import_words as diw on diw.import_id = di.id
    join public.words as w on w.id = diw.word_id
    join public.user_words as uw
      on uw.user_id = p_user_id
     and uw.word_id = diw.word_id
    where di.user_id = p_user_id
      and di.import_date = p_date
  )
  select
    normalized_word as word,
    display_word,
    status,
    source,
    consecutive_correct,
    wrong_count,
    mastered,
    next_review_at,
    meaning_error,
    collocation_error,
    grammar_error,
    pronunciation_error,
    spelling_error,
    fsrs_stability,
    fsrs_difficulty,
    fsrs_scheduled_days,
    fsrs_state,
    ipa_us,
    ipa_uk,
    coalesce(senses, '[]'::jsonb) as senses
  from canonical_rows
  where canonical_rank = 1
  order by import_created_at, import_id, position, word_id;
$$;

create or replace function public.get_review_candidates_v1(
  p_user_id uuid,
  p_now timestamptz,
  p_limit integer
)
returns table(
  word text,
  display_word text,
  status text,
  source text,
  consecutive_correct integer,
  wrong_count integer,
  mastered boolean,
  next_review_at timestamptz,
  meaning_error boolean,
  collocation_error boolean,
  grammar_error boolean,
  pronunciation_error boolean,
  spelling_error boolean,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_scheduled_days integer,
  fsrs_state smallint,
  ipa_us text,
  ipa_uk text,
  senses jsonb
)
language sql stable set search_path = public as $$
  select
    w.normalized_word as word,
    w.display_word,
    uw.status,
    uw.source,
    uw.consecutive_correct,
    uw.wrong_count,
    uw.mastered,
    uw.next_review_at,
    uw.meaning_error,
    uw.collocation_error,
    uw.grammar_error,
    uw.pronunciation_error,
    uw.spelling_error,
    uw.fsrs_stability,
    uw.fsrs_difficulty,
    uw.fsrs_scheduled_days,
    uw.fsrs_state,
    w.ipa_us,
    w.ipa_uk,
    coalesce(w.senses, '[]'::jsonb) as senses
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id
    and (
      uw.meaning_error
      or uw.collocation_error
      or uw.grammar_error
      or uw.pronunciation_error
      or uw.spelling_error
      or uw.next_review_at <= p_now
    )
  order by
    case when (
      uw.meaning_error
      or uw.collocation_error
      or uw.grammar_error
      or uw.pronunciation_error
      or uw.spelling_error
    ) then 0 else 1 end,
    uw.next_review_at asc nulls last,
    w.normalized_word asc
  limit greatest(coalesce(p_limit, 0), 0);
$$;

create or replace function public.get_progress_snapshot_v1(
  p_user_id uuid,
  p_now timestamptz
)
returns jsonb
language sql stable set search_path = public as $$
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
          meaning_error
          or collocation_error
          or grammar_error
          or pronunciation_error
          or spelling_error
        ))
      )::integer as learning,
      count(*) filter (where (
        meaning_error
        or collocation_error
        or grammar_error
        or pronunciation_error
        or spelling_error
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
      coalesce(round(avg(uw.fsrs_stability)::numeric, 1), 0)::double precision as average_stability
    from public.user_words as uw
    cross join calendar as c
    where uw.user_id = p_user_id
  )
  select jsonb_build_object(
    'today', jsonb_build_object(
      'total', tc.total,
      'known', tc.known,
      'uncertain', tc.uncertain,
      'unknown', tc.unknown,
      'completed', tc.completed
    ),
    'all_time', jsonb_build_object(
      'total_words', ac.total_words,
      'mastered', ac.mastered,
      'learning', ac.learning,
      'error_book', ac.error_book
    ),
    'fsrs', jsonb_build_object(
      'due_now', fc.due_now,
      'due_today', fc.due_today,
      'tomorrow', fc.tomorrow,
      'due_next_7_days', fc.due_next_7_days,
      'average_stability', fc.average_stability
    ),
    'settings', jsonb_build_object(
      'daily_new_word_limit', c.daily_new_word_limit
    )
  )
  from today_counts as tc
  cross join all_counts as ac
  cross join fsrs_counts as fc
  cross join calendar as c;
$$;

revoke all on function public.get_today_words_v2(uuid, date) from public, anon, authenticated;
revoke all on function public.get_review_candidates_v1(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.get_progress_snapshot_v1(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.get_today_words_v2(uuid, date) to service_role;
grant execute on function public.get_review_candidates_v1(uuid, timestamptz, integer) to service_role;
grant execute on function public.get_progress_snapshot_v1(uuid, timestamptz) to service_role;
