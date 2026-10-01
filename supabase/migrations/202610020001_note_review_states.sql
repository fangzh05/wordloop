-- Independent FSRS scheduling for explicitly enabled Capture notes.
-- This migration never writes words, user_words, daily queues, attempts,
-- review logs, or study sessions.

create table if not exists public.note_review_states (
  user_id uuid not null references public.users(id) on delete cascade,
  captured_note_id uuid not null,
  enabled boolean not null default false,
  card jsonb not null check (jsonb_typeof(card) = 'object'),
  due timestamptz not null,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, captured_note_id),
  foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade
);

create table if not exists public.note_review_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  captured_note_id uuid not null,
  idempotency_key uuid not null,
  expected_revision bigint not null check (expected_revision >= 0),
  expected_note_updated_at timestamptz not null,
  rating text not null check (rating in ('again', 'good')),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  server_time timestamptz not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade
);

create index if not exists note_review_states_user_due_idx
  on public.note_review_states(user_id, due asc, captured_note_id asc)
  where enabled = true;
create index if not exists note_review_events_user_note_created_idx
  on public.note_review_events(user_id, captured_note_id, created_at desc);

alter table public.note_review_states enable row level security;
alter table public.note_review_events enable row level security;
revoke all on public.note_review_states, public.note_review_events from public, anon, authenticated;
grant select, insert, update, delete on public.note_review_states, public.note_review_events to service_role;

create or replace function public.list_note_review_candidates_v1(
  p_user_id uuid,
  p_now timestamptz,
  p_limit integer
) returns table(
  note_id uuid,
  selected_text text,
  note text,
  note_updated_at timestamptz,
  due timestamptz,
  revision bigint,
  latest_context_text text,
  latest_source_type text,
  latest_source_title text,
  latest_source_url text,
  latest_captured_at timestamptz,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    n.id,
    n.selected_text,
    n.note,
    n.updated_at,
    s.due,
    s.revision,
    latest.context_text,
    latest.source_type,
    latest.source_title,
    latest.source_url,
    latest.captured_at,
    count(*) over () as total_count
  from public.note_review_states as s
  join public.captured_notes as n
    on n.user_id = s.user_id and n.id = s.captured_note_id
  left join lateral (
    select o.context_text, o.source_type, o.source_title, o.source_url, o.captured_at
    from public.captured_note_occurrences as o
    where o.user_id = n.user_id and o.captured_note_id = n.id
    order by o.captured_at desc, o.id desc
    limit 1
  ) as latest on true
  where s.user_id = p_user_id
    and s.enabled
    and s.due <= p_now
    and n.status in ('inbox', 'saved')
    and n.converted_user_word_id is null
    and length(btrim(n.note)) > 0
  order by s.due asc, n.id asc
  limit least(greatest(coalesce(p_limit, 10), 1), 10);
$$;

create or replace function public.set_note_review_enabled_v1(
  p_user_id uuid,
  p_captured_note_id uuid,
  p_enabled boolean,
  p_initial_card jsonb,
  p_now timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note public.captured_notes%rowtype;
  v_state public.note_review_states%rowtype;
  v_initial_due timestamptz;
begin
  select * into v_note
  from public.captured_notes
  where user_id = p_user_id and id = p_captured_note_id
  for update;

  if not found then raise exception 'NOTE_REVIEW_NOT_FOUND'; end if;

  if p_enabled and (v_note.status not in ('inbox', 'saved') or v_note.converted_user_word_id is not null) then
    raise exception 'NOTE_REVIEW_NOT_ELIGIBLE';
  end if;
  if p_enabled and length(btrim(v_note.note)) = 0 then
    raise exception 'NOTE_REVIEW_NOTE_EMPTY';
  end if;

  select * into v_state
  from public.note_review_states
  where user_id = p_user_id and captured_note_id = p_captured_note_id
  for update;

  if not found then
    if not p_enabled then
      return jsonb_build_object(
        'note_id', p_captured_note_id,
        'enabled', false,
        'due', null,
        'revision', null,
        'card', null
      );
    end if;
    if p_initial_card is null or jsonb_typeof(p_initial_card) <> 'object' or not (p_initial_card ? 'due') then
      raise exception 'NOTE_REVIEW_INVALID_CARD';
    end if;
    v_initial_due := (p_initial_card->>'due')::timestamptz;
    insert into public.note_review_states(
      user_id, captured_note_id, enabled, card, due, revision, created_at, updated_at
    ) values (
      p_user_id, p_captured_note_id, true, p_initial_card, v_initial_due, 0, p_now, p_now
    ) returning * into v_state;
  elsif v_state.enabled is distinct from p_enabled then
    update public.note_review_states
    set enabled = p_enabled, revision = v_state.revision + 1, updated_at = p_now
    where user_id = p_user_id and captured_note_id = p_captured_note_id
    returning * into v_state;
  end if;

  return jsonb_build_object(
    'note_id', v_state.captured_note_id,
    'enabled', v_state.enabled,
    'due', v_state.due,
    'revision', v_state.revision,
    'card', v_state.card
  );
end;
$$;

create or replace function public.record_note_review_rating_v1(
  p_user_id uuid,
  p_captured_note_id uuid,
  p_rating text,
  p_expected_revision bigint,
  p_expected_note_updated_at timestamptz,
  p_idempotency_key uuid,
  p_request_payload jsonb,
  p_next_card jsonb,
  p_server_time timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event public.note_review_events%rowtype;
  v_note public.captured_notes%rowtype;
  v_state public.note_review_states%rowtype;
  v_result jsonb;
  v_due timestamptz;
begin
  if p_rating not in ('again', 'good') then raise exception 'NOTE_REVIEW_INVALID_RATING'; end if;

  select * into v_event
  from public.note_review_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_event.captured_note_id is distinct from p_captured_note_id
      or v_event.request_payload <> p_request_payload then
      raise exception 'NOTE_REVIEW_IDEMPOTENCY_CONFLICT';
    end if;
    return v_event.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_note
  from public.captured_notes
  where user_id = p_user_id and id = p_captured_note_id
  for update;
  if not found then raise exception 'NOTE_REVIEW_NOT_FOUND'; end if;

  -- Recheck after waiting for the note lock so two simultaneous requests with
  -- the same key replay the committed result instead of racing the revision.
  select * into v_event
  from public.note_review_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_event.captured_note_id is distinct from p_captured_note_id
      or v_event.request_payload <> p_request_payload then
      raise exception 'NOTE_REVIEW_IDEMPOTENCY_CONFLICT';
    end if;
    return v_event.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_state
  from public.note_review_states
  where user_id = p_user_id and captured_note_id = p_captured_note_id
  for update;
  if not found then raise exception 'NOTE_REVIEW_NOT_ELIGIBLE'; end if;
  if not v_state.enabled
    or v_note.status not in ('inbox', 'saved')
    or v_note.converted_user_word_id is not null
    or length(btrim(v_note.note)) = 0 then
    raise exception 'NOTE_REVIEW_NOT_ELIGIBLE';
  end if;
  if v_state.revision <> p_expected_revision then raise exception 'NOTE_REVIEW_REVISION_CONFLICT'; end if;
  if v_note.updated_at is distinct from p_expected_note_updated_at then raise exception 'NOTE_REVIEW_CONTENT_CHANGED'; end if;
  if v_state.due > p_server_time then raise exception 'NOTE_REVIEW_NOT_DUE'; end if;
  if p_next_card is null
    or jsonb_typeof(p_next_card) <> 'object'
    or not (p_next_card ? 'due')
    or not (p_next_card ? 'stability')
    or not (p_next_card ? 'difficulty')
    or not (p_next_card ? 'elapsed_days')
    or not (p_next_card ? 'scheduled_days')
    or not (p_next_card ? 'learning_steps')
    or not (p_next_card ? 'reps')
    or not (p_next_card ? 'lapses')
    or not (p_next_card ? 'state') then
    raise exception 'NOTE_REVIEW_INVALID_CARD';
  end if;

  v_due := (p_next_card->>'due')::timestamptz;
  update public.note_review_states
  set card = p_next_card,
      due = v_due,
      revision = v_state.revision + 1,
      updated_at = p_server_time
  where user_id = p_user_id and captured_note_id = p_captured_note_id;

  v_result := jsonb_build_object(
    'note_id', p_captured_note_id,
    'enabled', true,
    'due', v_due,
    'revision', v_state.revision + 1,
    'card', p_next_card,
    'rating', p_rating,
    'server_time', p_server_time
  );

  insert into public.note_review_events(
    user_id, captured_note_id, idempotency_key, expected_revision,
    expected_note_updated_at, rating, request_payload, server_time, result
  ) values (
    p_user_id, p_captured_note_id, p_idempotency_key, p_expected_revision,
    p_expected_note_updated_at, p_rating, p_request_payload, p_server_time, v_result
  );

  return v_result;
end;
$$;

create or replace function public.note_review_schema_v1()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select to_regclass('public.note_review_states') is not null
    and to_regclass('public.note_review_events') is not null
    and to_regprocedure('public.list_note_review_candidates_v1(uuid,timestamptz,integer)') is not null
    and to_regprocedure('public.set_note_review_enabled_v1(uuid,uuid,boolean,jsonb,timestamptz)') is not null
    and to_regprocedure('public.record_note_review_rating_v1(uuid,uuid,text,bigint,timestamptz,uuid,jsonb,jsonb,timestamptz)') is not null;
$$;

revoke all on function public.list_note_review_candidates_v1(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.set_note_review_enabled_v1(uuid, uuid, boolean, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.record_note_review_rating_v1(uuid, uuid, text, bigint, timestamptz, uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.note_review_schema_v1() from public, anon, authenticated;
grant execute on function public.list_note_review_candidates_v1(uuid, timestamptz, integer) to service_role;
grant execute on function public.set_note_review_enabled_v1(uuid, uuid, boolean, jsonb, timestamptz) to service_role;
grant execute on function public.record_note_review_rating_v1(uuid, uuid, text, bigint, timestamptz, uuid, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.note_review_schema_v1() to service_role;
