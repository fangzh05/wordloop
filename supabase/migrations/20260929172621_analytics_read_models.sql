-- Server-only read models for the standalone Insights pages.
-- Aggregates always receive an explicit owner and never mutate study state.

create or replace function public.list_user_vocabulary_v1(
  p_user_id uuid,
  p_query text,
  p_filters text[],
  p_before_first_seen timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_as_of timestamptz
) returns table(
  id uuid,
  user_id uuid,
  word_id uuid,
  status text,
  source text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_reviewed_at timestamptz,
  correct_count integer,
  wrong_count integer,
  consecutive_correct integer,
  meaning_error boolean,
  collocation_error boolean,
  grammar_error boolean,
  pronunciation_error boolean,
  spelling_error boolean,
  mastered boolean,
  next_review_at timestamptz,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_elapsed_days integer,
  fsrs_scheduled_days integer,
  fsrs_learning_steps integer,
  fsrs_reps integer,
  fsrs_lapses integer,
  fsrs_state smallint,
  normalized_word text,
  display_word text,
  ipa_us text,
  ipa_uk text,
  senses jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    uw.id, uw.user_id, uw.word_id, uw.status, uw.source,
    uw.first_seen_at, uw.last_seen_at, uw.last_reviewed_at,
    uw.correct_count, uw.wrong_count, uw.consecutive_correct,
    uw.meaning_error, uw.collocation_error, uw.grammar_error,
    uw.pronunciation_error, uw.spelling_error, uw.mastered,
    uw.next_review_at, uw.fsrs_stability, uw.fsrs_difficulty,
    uw.fsrs_elapsed_days, uw.fsrs_scheduled_days, uw.fsrs_learning_steps,
    uw.fsrs_reps, uw.fsrs_lapses, uw.fsrs_state,
    w.normalized_word, w.display_word, w.ipa_us, w.ipa_uk,
    coalesce(w.senses, '[]'::jsonb)
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id
    and (coalesce(p_query, '') = '' or strpos(lower(w.normalized_word), lower(p_query)) > 0)
    and (not ('not_started' = any(coalesce(p_filters, '{}'::text[]))) or uw.status = 'new')
    and (not ('in_memory' = any(coalesce(p_filters, '{}'::text[]))) or uw.fsrs_reps > 0)
    and (not ('active_error' = any(coalesce(p_filters, '{}'::text[]))) or (
      uw.meaning_error or uw.collocation_error or uw.grammar_error
      or uw.pronunciation_error or uw.spelling_error
    ))
    and (not ('due' = any(coalesce(p_filters, '{}'::text[]))) or (
      uw.fsrs_reps > 0 and uw.next_review_at <= p_as_of
    ))
    and (p_before_first_seen is null or p_before_id is null
      or (uw.first_seen_at, uw.id) < (p_before_first_seen, p_before_id))
  order by uw.first_seen_at desc, uw.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 101);
$$;

create or replace function public.get_analytics_review_days_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text,
  p_days integer
) returns table(
  local_date date,
  first_review_count bigint,
  eligible_count bigint,
  successes bigint,
  failures bigint,
  invalid_rating_count bigint,
  below_interval_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      p_days as days,
      (p_as_of at time zone p_timezone)::date as today,
      ((p_as_of at time zone p_timezone)::date - (p_days + 28)) as history_start
  ), first_formal_review as (
    select distinct on (logs.word_id, (logs.reviewed_at at time zone params.timezone)::date)
      logs.word_id,
      (logs.reviewed_at at time zone params.timezone)::date as local_date,
      logs.rating,
      logs.scheduled_days
    from public.fsrs_review_logs as logs
    cross join params
    where logs.user_id = params.user_id
      and logs.review_source = 'review'
      and logs.reviewed_at <= params.as_of
      and (logs.reviewed_at at time zone params.timezone)::date >= params.history_start
    order by logs.word_id,
      (logs.reviewed_at at time zone params.timezone)::date,
      logs.reviewed_at,
      logs.id
  ), daily as (
    select
      first_formal_review.local_date,
      count(*) as first_review_count,
      count(*) filter (
        where first_formal_review.scheduled_days >= 1
          and first_formal_review.rating between 1 and 4
      ) as eligible_count,
      count(*) filter (
        where first_formal_review.scheduled_days >= 1
          and first_formal_review.rating in (2, 3, 4)
      ) as successes,
      count(*) filter (
        where first_formal_review.scheduled_days >= 1
          and first_formal_review.rating = 1
      ) as failures,
      count(*) filter (
        where first_formal_review.rating is null
          or first_formal_review.rating not between 1 and 4
      ) as invalid_rating_count,
      count(*) filter (where first_formal_review.scheduled_days < 1) as below_interval_count
    from first_formal_review
    group by first_formal_review.local_date
  ), calendar as (
    select (series.day)::date as local_date
    from params
    cross join lateral generate_series(
      params.history_start::timestamp,
      params.today::timestamp,
      interval '1 day'
    ) as series(day)
  )
  select
    calendar.local_date,
    coalesce(daily.first_review_count, 0),
    coalesce(daily.eligible_count, 0),
    coalesce(daily.successes, 0),
    coalesce(daily.failures, 0),
    coalesce(daily.invalid_rating_count, 0),
    coalesce(daily.below_interval_count, 0)
  from calendar
  left join daily using (local_date)
  order by calendar.local_date;
$$;

create or replace function public.get_analytics_due_distribution_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text
) returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      (p_as_of at time zone p_timezone)::date as today
  ), scheduled as (
    select
      words.next_review_at,
      (words.next_review_at at time zone params.timezone)::date as due_date,
      params.today,
      params.as_of
    from public.user_words as words
    cross join params
    where words.user_id = params.user_id
      and words.fsrs_reps > 0
      and words.next_review_at is not null
  ), future_counts as (
    select scheduled.due_date, count(*) as due_count
    from scheduled
    cross join params
    where scheduled.due_date between params.today + 1 and params.today + 30
    group by scheduled.due_date
  ), future_calendar as (
    select (series.day)::date as due_date
    from params
    cross join lateral generate_series(
      (params.today + 1)::timestamp,
      (params.today + 30)::timestamp,
      interval '1 day'
    ) as series(day)
  )
  select jsonb_build_object(
    'overdue_previous_days', coalesce(count(*) filter (where scheduled.due_date < scheduled.today), 0),
    'due_today_elapsed', coalesce(count(*) filter (
      where scheduled.due_date = scheduled.today and scheduled.next_review_at <= scheduled.as_of
    ), 0),
    'due_today_later', coalesce(count(*) filter (
      where scheduled.due_date = scheduled.today and scheduled.next_review_at > scheduled.as_of
    ), 0),
    'future_days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', future_calendar.due_date,
        'count', coalesce(future_counts.due_count, 0)
      ) order by future_calendar.due_date)
      from future_calendar
      left join future_counts using (due_date)
    ), '[]'::jsonb),
    'future_next_7_days', coalesce((
      select sum(future_counts.due_count)
      from future_counts cross join params
      where future_counts.due_date <= params.today + 7
    ), 0),
    'future_next_30_days', coalesce((select sum(due_count) from future_counts), 0)
  )
  from scheduled;
$$;

create or replace function public.get_analytics_error_matrix_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text,
  p_days integer
) returns table(
  activity_type text,
  error_layer text,
  error_events bigint,
  distinct_words bigint,
  activity_attempts bigint,
  determinable_attempts bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      ((p_as_of at time zone p_timezone)::date - (p_days - 1)) as first_day
  ), selected_attempts as (
    select
      attempt.activity_type,
      case
        when attempt.error_layer in ('meaning', 'collocation', 'grammar', 'pronunciation', 'spelling') then attempt.error_layer
        else 'unclassified'
      end as normalized_error_layer,
      attempt.word_id,
      attempt.is_correct
    from public.attempts as attempt
    cross join params
    where attempt.user_id = params.user_id
      and attempt.created_at <= params.as_of
      and (attempt.created_at at time zone params.timezone)::date >= params.first_day
  ), activities as (
    select distinct activity_type from selected_attempts
  ), layers as (
    select unnest(array['meaning', 'collocation', 'grammar', 'pronunciation', 'spelling', 'unclassified']::text[]) as error_layer
  ), totals as (
    select
      selected_attempts.activity_type,
      count(*) as activity_attempts,
      count(*) filter (where normalized_error_layer <> 'unclassified') as determinable_attempts
    from selected_attempts
    group by selected_attempts.activity_type
  ), errors as (
    select
      selected_attempts.activity_type,
      selected_attempts.normalized_error_layer as error_layer,
      count(*) as error_events,
      count(distinct selected_attempts.word_id) as distinct_words
    from selected_attempts
    where selected_attempts.is_correct = false
    group by selected_attempts.activity_type, selected_attempts.normalized_error_layer
  )
  select
    activities.activity_type,
    layers.error_layer,
    coalesce(errors.error_events, 0),
    coalesce(errors.distinct_words, 0),
    totals.activity_attempts,
    totals.determinable_attempts
  from activities
  cross join layers
  join totals using (activity_type)
  left join errors on errors.activity_type = activities.activity_type and errors.error_layer = layers.error_layer
  order by activities.activity_type, layers.error_layer;
$$;

create or replace function public.get_analytics_activity_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text,
  p_days integer
) returns table(
  local_date date,
  formal_review_count bigint,
  distinct_review_words bigint,
  pretest_count bigint,
  first_introductions bigint,
  capture_count bigint,
  ordinary_attempt_count bigint,
  distinct_attempt_words bigint,
  first_formal_learning_completion bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      (p_as_of at time zone p_timezone)::date as today,
      ((p_as_of at time zone p_timezone)::date - (p_days - 1)) as first_day
  ), calendar as (
    select (series.day)::date as local_date
    from params
    cross join lateral generate_series(
      params.first_day::timestamp,
      params.today::timestamp,
      interval '1 day'
    ) as series(day)
  ), daily_reviews as (
    select
      (logs.reviewed_at at time zone params.timezone)::date as local_date,
      count(*) filter (where logs.review_source = 'review') as formal_review_count,
      count(distinct logs.word_id) filter (where logs.review_source = 'review') as distinct_review_words,
      count(*) filter (where logs.review_source = 'pretest') as pretest_count
    from public.fsrs_review_logs as logs
    cross join params
    where logs.user_id = params.user_id
      and logs.review_source in ('review', 'pretest')
      and logs.reviewed_at <= params.as_of
      and (logs.reviewed_at at time zone params.timezone)::date >= params.first_day
    group by (logs.reviewed_at at time zone params.timezone)::date
  ), first_pretest as (
    select distinct on (logs.word_id)
      logs.word_id,
      (logs.reviewed_at at time zone params.timezone)::date as local_date
    from public.fsrs_review_logs as logs
    cross join params
    where logs.user_id = params.user_id
      and logs.review_source = 'pretest'
      and logs.reviewed_at <= params.as_of
    order by logs.word_id, logs.reviewed_at, logs.id
  ), daily_introductions as (
    select first_pretest.local_date, count(*) as first_introductions
    from first_pretest cross join params
    where first_pretest.local_date between params.first_day and params.today
    group by first_pretest.local_date
  ), daily_attempts as (
    select
      (attempt.created_at at time zone params.timezone)::date as local_date,
      count(*) as ordinary_attempt_count,
      count(distinct attempt.word_id) as distinct_attempt_words
    from public.attempts as attempt
    cross join params
    where attempt.user_id = params.user_id
      and attempt.created_at <= params.as_of
      and (attempt.created_at at time zone params.timezone)::date between params.first_day and params.today
    group by (attempt.created_at at time zone params.timezone)::date
  ), daily_captures as (
    select
      (occurrence.captured_at at time zone params.timezone)::date as local_date,
      count(*) as capture_count
    from public.captured_note_occurrences as occurrence
    cross join params
    where occurrence.user_id = params.user_id
      and occurrence.captured_at <= params.as_of
      and (occurrence.captured_at at time zone params.timezone)::date between params.first_day and params.today
    group by (occurrence.captured_at at time zone params.timezone)::date
  )
  select
    calendar.local_date,
    coalesce(daily_reviews.formal_review_count, 0),
    coalesce(daily_reviews.distinct_review_words, 0),
    coalesce(daily_reviews.pretest_count, 0),
    coalesce(daily_introductions.first_introductions, 0),
    coalesce(daily_captures.capture_count, 0),
    coalesce(daily_attempts.ordinary_attempt_count, 0),
    coalesce(daily_attempts.distinct_attempt_words, 0),
    null::bigint as first_formal_learning_completion
  from calendar
  left join daily_reviews using (local_date)
  left join daily_introductions using (local_date)
  left join daily_attempts using (local_date)
  left join daily_captures using (local_date)
  order by calendar.local_date;
$$;

revoke all on function public.get_analytics_review_days_v1(uuid, timestamptz, text, integer) from public, anon, authenticated;
revoke all on function public.list_user_vocabulary_v1(uuid, text, text[], timestamptz, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.get_analytics_due_distribution_v1(uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.get_analytics_error_matrix_v1(uuid, timestamptz, text, integer) from public, anon, authenticated;
revoke all on function public.get_analytics_activity_v1(uuid, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.get_analytics_review_days_v1(uuid, timestamptz, text, integer) to service_role;
grant execute on function public.list_user_vocabulary_v1(uuid, text, text[], timestamptz, uuid, integer, timestamptz) to service_role;
grant execute on function public.get_analytics_due_distribution_v1(uuid, timestamptz, text) to service_role;
grant execute on function public.get_analytics_error_matrix_v1(uuid, timestamptz, text, integer) to service_role;
grant execute on function public.get_analytics_activity_v1(uuid, timestamptz, text, integer) to service_role;
