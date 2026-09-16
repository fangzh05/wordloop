-- Initial Review session snapshot selection.
-- This is deliberately due-only: active error flags alone must never gate the
-- start of a Review session. The existing (user_id, next_review_at) index from
-- migration 002 supports the indexed predicate and stable bounded read.

create or replace function public.get_due_review_candidates_v1(
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
    and uw.next_review_at is not null
    and uw.next_review_at <= p_now
  order by uw.next_review_at asc, w.normalized_word asc
  limit least(greatest(coalesce(p_limit, 0), 0), 200);
$$;

revoke all on function public.get_due_review_candidates_v1(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.get_due_review_candidates_v1(uuid, timestamptz, integer) to service_role;
