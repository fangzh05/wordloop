-- WordLoop integrity guards. This migration adds no tables or scheduling
-- infrastructure; it closes the existing session and review transaction
-- boundaries in the database.

-- Keep the newest active session for each user before enforcing uniqueness.
with ranked_active as (
  select id,
    row_number() over (partition by user_id order by started_at desc, id desc) as rank
  from public.study_sessions
  where ended_at is null
)
update public.study_sessions as sessions
set ended_at = now(),
    state = '{}'::jsonb,
    updated_at = now()
from ranked_active
where sessions.id = ranked_active.id
  and ranked_active.rank > 1;

drop index if exists public.study_sessions_active_idx;
create unique index if not exists study_sessions_one_active_per_user
  on public.study_sessions(user_id)
  where ended_at is null;

create or replace function public.record_review_result_v1(
  p_user_id uuid, p_normalized_word text, p_session_id uuid, p_rating smallint,
  p_source text, p_reason text, p_card jsonb, p_log jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_word user_words%rowtype;
begin
  select uw.* into v_user_word from user_words uw join words w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = p_normalized_word for update of uw;
  if v_user_word.id is null then raise exception 'Word is not in the user vocabulary'; end if;
  if v_user_word.next_review_at is null
     or v_user_word.next_review_at > clock_timestamp()
  then
    raise exception 'FSRS_CARD_NOT_DUE';
  end if;
  if p_rating not between 1 and 4 then raise exception 'Invalid FSRS rating'; end if;
  if p_source not in ('pretest','review','session_checkpoint') then raise exception 'Invalid review source'; end if;
  update user_words set
    fsrs_stability = (p_card->>'fsrs_stability')::double precision,
    fsrs_difficulty = (p_card->>'fsrs_difficulty')::double precision,
    fsrs_elapsed_days = (p_card->>'fsrs_elapsed_days')::integer,
    fsrs_scheduled_days = (p_card->>'fsrs_scheduled_days')::integer,
    fsrs_learning_steps = (p_card->>'fsrs_learning_steps')::integer,
    fsrs_reps = (p_card->>'fsrs_reps')::integer,
    fsrs_lapses = (p_card->>'fsrs_lapses')::integer,
    fsrs_state = (p_card->>'fsrs_state')::smallint,
    next_review_at = (p_card->>'next_review_at')::timestamptz,
    last_reviewed_at = (p_card->>'last_reviewed_at')::timestamptz,
    mastered = case when p_rating = 1 then false else mastered end,
    status = case when p_rating = 1 then 'review' else status end
  where id = v_user_word.id;
  insert into fsrs_review_logs(user_id, word_id, session_id, rating, state, due,
    stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, learning_steps,
    reviewed_at, review_source, reason)
  values (p_user_id, v_user_word.word_id, p_session_id, p_rating, (p_log->>'state')::smallint,
    (p_log->>'due')::timestamptz, (p_log->>'stability')::double precision,
    (p_log->>'difficulty')::double precision, (p_log->>'elapsed_days')::integer,
    (p_log->>'last_elapsed_days')::integer, (p_log->>'scheduled_days')::integer,
    (p_log->>'learning_steps')::integer, (p_log->>'reviewed_at')::timestamptz, p_source, p_reason);
  return jsonb_build_object('word', p_normalized_word);
end;
$$;

create or replace function public.record_review_submission_v1(
  p_user_id uuid, p_normalized_word text, p_session_id uuid,
  p_user_answer text, p_is_correct boolean, p_error_layer text,
  p_rating smallint, p_card jsonb, p_log jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_attempt jsonb;
  v_review jsonb;
begin
  select public.record_attempt_v2(
    p_user_id, p_normalized_word, p_session_id, 'review',
    p_user_answer, p_is_correct, p_error_layer
  ) into v_attempt;
  select public.record_review_result_v1(
    p_user_id, p_normalized_word, p_session_id, p_rating,
    'review', null, p_card, p_log
  ) into v_review;
  return jsonb_build_object('attempt', v_attempt, 'review', v_review);
end;
$$;

revoke all on function public.record_review_result_v1(uuid,text,uuid,smallint,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.record_review_submission_v1(uuid,text,uuid,text,boolean,text,smallint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_review_result_v1(uuid,text,uuid,smallint,text,text,jsonb,jsonb) to service_role;
grant execute on function public.record_review_submission_v1(uuid,text,uuid,text,boolean,text,smallint,jsonb,jsonb) to service_role;
