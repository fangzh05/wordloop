-- Keep duplicate rows as idempotency receipts; only distinct sources are visible.
create or replace function public.capture_occurrence_fingerprint_v1(
  p_context_text text, p_source_type text, p_source_ref text, p_source_url text
) returns text
language sql immutable security invoker
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(jsonb_build_array(
    btrim(regexp_replace(normalize(coalesce(p_context_text, ''), NFC), U&'[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g')),
    p_source_type, nullif(btrim(p_source_ref), ''), nullif(btrim(p_source_url), '')
  )::text, 'UTF8')), 'hex');
$$;

alter table public.captured_note_occurrences
  add column is_duplicate boolean not null default false;

-- Retain the oldest source and every original request key without deleting data.
with ranked as (
  select id, row_number() over (
    partition by user_id, captured_note_id,
      public.capture_occurrence_fingerprint_v1(context_text, source_type, source_ref, source_url)
    order by captured_at, id
  ) as position
  from public.captured_note_occurrences
)
update public.captured_note_occurrences as o
set is_duplicate = true
from ranked where ranked.id = o.id and ranked.position > 1;

create unique index captured_note_occurrences_distinct_source_key
  on public.captured_note_occurrences (
    user_id, captured_note_id,
    public.capture_occurrence_fingerprint_v1(context_text, source_type, source_ref, source_url)
  ) where not is_duplicate;

create or replace function public.create_captured_note_v1(
  p_user_id uuid, p_selected_text text, p_normalized_text text, p_selection_type text,
  p_note text, p_context_text text, p_source_type text, p_source_ref text,
  p_source_title text, p_source_url text, p_idempotency_key uuid
) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_note_id uuid;
  v_occurrence_id uuid;
  v_receipt_note_id uuid;
  v_occurrence_count integer;
  v_new_occurrence boolean := false;
begin
  insert into public.captured_notes(user_id, selected_text, normalized_text, selection_type, note)
  values (p_user_id, p_selected_text, p_normalized_text, p_selection_type, coalesce(p_note, ''))
  on conflict (user_id, normalized_text) do nothing
  returning id into v_note_id;

  -- Serialize captures of one note, including count and updated_at changes.
  select id into v_note_id from public.captured_notes
  where user_id = p_user_id and normalized_text = p_normalized_text
  for update;

  select captured_note_id into v_receipt_note_id from public.captured_note_occurrences
  where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_receipt_note_id is distinct from v_note_id then
      raise exception 'CAPTURE_IDEMPOTENCY_CONFLICT';
    end if;
  else
    insert into public.captured_note_occurrences(
      user_id, captured_note_id, context_text, source_type, source_ref,
      source_title, source_url, idempotency_key
    ) values (
      p_user_id, v_note_id, coalesce(p_context_text, ''), p_source_type, p_source_ref,
      p_source_title, p_source_url, p_idempotency_key
    ) on conflict do nothing returning id into v_occurrence_id;
    v_new_occurrence := v_occurrence_id is not null;

    if not v_new_occurrence then
      -- Preserve this new request key even when its source already exists.
      insert into public.captured_note_occurrences(
        user_id, captured_note_id, context_text, source_type, source_ref,
        source_title, source_url, idempotency_key, is_duplicate
      ) values (
        p_user_id, v_note_id, coalesce(p_context_text, ''), p_source_type, p_source_ref,
        p_source_title, p_source_url, p_idempotency_key, true
      ) on conflict (user_id, idempotency_key) do nothing;
      select captured_note_id into v_receipt_note_id from public.captured_note_occurrences
      where user_id = p_user_id and idempotency_key = p_idempotency_key;
      if v_receipt_note_id is distinct from v_note_id then
        raise exception 'CAPTURE_IDEMPOTENCY_CONFLICT';
      end if;
    else
      update public.captured_notes
      set updated_at = greatest(updated_at, clock_timestamp())
      where user_id = p_user_id and id = v_note_id;
    end if;
  end if;

  select count(*)::integer into v_occurrence_count
  from public.captured_note_occurrences
  where user_id = p_user_id and captured_note_id = v_note_id and not is_duplicate;
  return jsonb_build_object('note_id', v_note_id, 'occurrence_count', v_occurrence_count,
    'new_occurrence', v_new_occurrence);
end;
$$;

create or replace function public.list_captured_notes_v1(
  p_user_id uuid,
  p_status text,
  p_query text,
  p_before_updated_at timestamptz,
  p_before_id uuid,
  p_limit integer
) returns table(
  id uuid,
  selected_text text,
  normalized_text text,
  selection_type text,
  note text,
  status text,
  converted_user_word_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  occurrence_count bigint,
  occurrences jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    n.id, n.selected_text, n.normalized_text, n.selection_type, n.note, n.status,
    n.converted_user_word_id, n.created_at, n.updated_at,
    (select count(*) from public.captured_note_occurrences as o
      where o.user_id = p_user_id and o.captured_note_id = n.id and not o.is_duplicate) as occurrence_count,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'context_text', recent.context_text,
        'source_type', recent.source_type,
        'source_ref', recent.source_ref,
        'source_title', recent.source_title,
        'source_url', recent.source_url,
        'captured_at', recent.captured_at
      ) order by recent.captured_at desc, recent.id desc)
      from (
        select o.id, o.context_text, o.source_type, o.source_ref, o.source_title,
          o.source_url, o.captured_at
        from public.captured_note_occurrences as o
        where o.user_id = p_user_id and o.captured_note_id = n.id and not o.is_duplicate
        order by o.captured_at desc, o.id desc
        limit 3
      ) as recent
    ), '[]'::jsonb) as occurrences
  from public.captured_notes as n
  where n.user_id = p_user_id
    and (p_status = 'all' or n.status = p_status)
    and (p_before_updated_at is null or
      (p_before_id is not null and (n.updated_at, n.id) < (p_before_updated_at, p_before_id)))
    and (coalesce(p_query, '') = ''
      or strpos(lower(n.selected_text), lower(p_query)) > 0
      or strpos(lower(n.note), lower(p_query)) > 0
      or exists (
        select 1 from public.captured_note_occurrences as o
        where o.user_id = p_user_id and o.captured_note_id = n.id and not o.is_duplicate
          and strpos(lower(o.context_text), lower(p_query)) > 0
      ))
  order by n.updated_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 51);
$$;

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
    where o.user_id = n.user_id and o.captured_note_id = n.id and not o.is_duplicate
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

revoke all on function public.capture_occurrence_fingerprint_v1(text, text, text, text) from public, anon, authenticated;
grant execute on function public.capture_occurrence_fingerprint_v1(text, text, text, text) to service_role;
revoke all on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) to service_role;
