create table public.captured_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  selected_text text not null check (length(btrim(selected_text)) between 1 and 500),
  normalized_text text not null check (length(btrim(normalized_text)) between 1 and 500),
  selection_type text not null check (selection_type in ('word', 'phrase', 'collocation', 'sentence', 'grammar')),
  note text not null default '' check (length(note) <= 500),
  status text not null default 'inbox' check (status in ('inbox', 'saved', 'dismissed', 'converted')),
  converted_user_word_id uuid references public.user_words(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, normalized_text)
);

create table public.captured_note_occurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  captured_note_id uuid not null,
  context_text text not null default '' check (length(context_text) <= 1200),
  source_type text not null check (source_type in ('lesson_example', 'lesson_prompt', 'review_question', 'manual')),
  source_ref text check (source_ref is null or length(source_ref) <= 256),
  source_title text check (source_title is null or length(source_title) <= 200),
  source_url text check (source_url is null or length(source_url) <= 500),
  captured_at timestamptz not null default now(),
  idempotency_key uuid not null,
  foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade,
  unique (user_id, idempotency_key)
);

create index captured_notes_user_status_updated_idx
  on public.captured_notes(user_id, status, updated_at desc, id desc);
create index captured_note_occurrences_user_note_captured_idx
  on public.captured_note_occurrences(user_id, captured_note_id, captured_at desc);

alter table public.captured_notes enable row level security;
alter table public.captured_note_occurrences enable row level security;
revoke all on public.captured_notes, public.captured_note_occurrences from public, anon, authenticated;
grant select, insert, update, delete on public.captured_notes, public.captured_note_occurrences to service_role;

-- Keep word/card insertion shared with the existing import RPC. Imports retain
-- their historical last_seen_at behavior; Capture promotions never touch an
-- existing user_words row.
create or replace function public.ensure_user_word_v1(
  p_user_id uuid,
  p_normalized_word text,
  p_display_word text,
  p_source text,
  p_touch_existing boolean
) returns table(word_id uuid, user_word_id uuid, inserted boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_word_id uuid;
  v_user_word_id uuid;
  v_inserted integer;
begin
  insert into public.words(normalized_word, display_word)
  values (p_normalized_word, p_display_word)
  on conflict (normalized_word) do update set normalized_word = excluded.normalized_word
  returning id into v_word_id;

  insert into public.user_words(user_id, word_id, source)
  values (p_user_id, v_word_id, p_source)
  on conflict (user_id, word_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 and p_touch_existing then
    update public.user_words
    set last_seen_at = now()
    where user_id = p_user_id and word_id = v_word_id;
  end if;

  select id into v_user_word_id
  from public.user_words
  where user_id = p_user_id and word_id = v_word_id;

  return query select v_word_id, v_user_word_id, v_inserted = 1;
end;
$$;

create or replace function public.import_words_v1(
  p_user_id uuid,
  p_words jsonb,
  p_date date,
  p_source text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_word_id uuid;
  v_import_id uuid;
  v_start_position integer;
  v_new integer := 0;
  v_existing integer := 0;
  v_total integer := jsonb_array_length(p_words);
  v_ensured record;
begin
  insert into public.users(id) values (p_user_id) on conflict (id) do nothing;
  insert into public.daily_imports(user_id, import_date, source, raw_count)
  values (p_user_id, p_date, p_source, 0)
  on conflict (user_id, import_date, source) do update set source = excluded.source
  returning id into v_import_id;

  select coalesce(max(position) + 1, 0) into v_start_position
  from public.daily_import_words where import_id = v_import_id;

  for v_item in select value from jsonb_array_elements(p_words)
  loop
    select * into v_ensured
    from public.ensure_user_word_v1(
      p_user_id,
      v_item->>'normalized',
      v_item->>'display',
      p_source,
      true
    );
    v_word_id := v_ensured.word_id;

    if v_ensured.inserted then v_new := v_new + 1; else v_existing := v_existing + 1; end if;

    insert into public.daily_import_words(import_id, word_id, position)
    values (v_import_id, v_word_id, v_start_position + (v_item->>'position')::integer)
    on conflict (import_id, word_id) do nothing;
  end loop;

  update public.daily_imports set raw_count = (
    select count(*) from public.daily_import_words where import_id = v_import_id
  ) where id = v_import_id;

  return jsonb_build_object('date', p_date, 'source', p_source, 'total', v_total, 'new', v_new, 'existing', v_existing);
end;
$$;

create or replace function public.create_captured_note_v1(
  p_user_id uuid,
  p_selected_text text,
  p_normalized_text text,
  p_selection_type text,
  p_note text,
  p_context_text text,
  p_source_type text,
  p_source_ref text,
  p_source_title text,
  p_source_url text,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note_id uuid;
  v_occurrence_id uuid;
  v_occurrence_note_id uuid;
  v_occurrence_count integer;
begin
  insert into public.captured_notes(user_id, selected_text, normalized_text, selection_type, note)
  values (p_user_id, p_selected_text, p_normalized_text, p_selection_type, coalesce(p_note, ''))
  on conflict (user_id, normalized_text) do nothing
  returning id into v_note_id;

  if v_note_id is null then
    select id into v_note_id
    from public.captured_notes
    where user_id = p_user_id and normalized_text = p_normalized_text;
  end if;

  insert into public.captured_note_occurrences(
    user_id, captured_note_id, context_text, source_type, source_ref, source_title, source_url, idempotency_key
  ) values (
    p_user_id, v_note_id, coalesce(p_context_text, ''), p_source_type, p_source_ref, p_source_title, p_source_url, p_idempotency_key
  ) on conflict (user_id, idempotency_key) do nothing
  returning id into v_occurrence_id;

  if v_occurrence_id is null then
    select captured_note_id into v_occurrence_note_id
    from public.captured_note_occurrences
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_occurrence_note_id is distinct from v_note_id then
      raise exception 'CAPTURE_IDEMPOTENCY_CONFLICT';
    end if;
  end if;

  select count(*)::integer into v_occurrence_count
  from public.captured_note_occurrences
  where user_id = p_user_id and captured_note_id = v_note_id;

  return jsonb_build_object(
    'note_id', v_note_id,
    'occurrence_count', v_occurrence_count,
    'new_occurrence', v_occurrence_id is not null
  );
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
    n.id,
    n.selected_text,
    n.normalized_text,
    n.selection_type,
    n.note,
    n.status,
    n.converted_user_word_id,
    n.created_at,
    n.updated_at,
    (
      select count(*)
      from public.captured_note_occurrences as o
      where o.user_id = p_user_id and o.captured_note_id = n.id
    ) as occurrence_count,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'context_text', recent.context_text,
        'source_type', recent.source_type,
        'source_title', recent.source_title,
        'source_url', recent.source_url,
        'captured_at', recent.captured_at
      ) order by recent.captured_at desc)
      from (
        select o.context_text, o.source_type, o.source_title, o.source_url, o.captured_at
        from public.captured_note_occurrences as o
        where o.user_id = p_user_id and o.captured_note_id = n.id
        order by o.captured_at desc
        limit 3
      ) as recent
    ), '[]'::jsonb) as occurrences
  from public.captured_notes as n
  where n.user_id = p_user_id
    and (p_status = 'all' or n.status = p_status)
    and (
      p_before_updated_at is null
      or (
        p_before_id is not null
        and (n.updated_at < p_before_updated_at or (n.updated_at = p_before_updated_at and n.id < p_before_id))
      )
    )
    and (
      coalesce(p_query, '') = ''
      or strpos(lower(n.selected_text), lower(p_query)) > 0
      or strpos(lower(n.note), lower(p_query)) > 0
      or exists (
        select 1
        from public.captured_note_occurrences as o
        where o.user_id = p_user_id
          and o.captured_note_id = n.id
          and strpos(lower(o.context_text), lower(p_query)) > 0
      )
    )
  order by n.updated_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 51);
$$;

create or replace function public.promote_captured_note_v1(
  p_user_id uuid,
  p_captured_note_id uuid,
  p_import_date date,
  p_display_text text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note public.captured_notes%rowtype;
  v_user_word_id uuid;
  v_word_id uuid;
  v_import_id uuid;
  v_position integer;
  v_ensured record;
begin
  select * into v_note
  from public.captured_notes
  where user_id = p_user_id and id = p_captured_note_id
  for update;

  if not found then raise exception 'CAPTURE_NOT_FOUND'; end if;
  if v_note.selection_type not in ('word', 'phrase', 'collocation') then
    raise exception 'CAPTURE_UNSUPPORTED_TYPE';
  end if;
  if p_display_text is null or length(btrim(p_display_text)) = 0 or length(p_display_text) > 100
    or p_display_text <> btrim(p_display_text) or lower(p_display_text) <> v_note.normalized_text then
    raise exception 'CAPTURE_TERM_INVALID';
  end if;

  if v_note.converted_user_word_id is not null then
    select id into v_user_word_id
    from public.user_words
    where user_id = p_user_id and id = v_note.converted_user_word_id;
    if not found then raise exception 'CAPTURE_LINK_INVALID'; end if;
    return jsonb_build_object(
      'note_id', v_note.id,
      'user_word_id', v_user_word_id,
      'normalized_word', v_note.normalized_text,
      'is_new', false
    );
  end if;

  select uw.id, uw.word_id into v_user_word_id, v_word_id
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = v_note.normalized_text
  for update of uw;

  if found then
    update public.captured_notes
    set converted_user_word_id = v_user_word_id, status = 'converted', updated_at = now()
    where user_id = p_user_id and id = v_note.id;
    return jsonb_build_object(
      'note_id', v_note.id,
      'user_word_id', v_user_word_id,
      'normalized_word', v_note.normalized_text,
      'is_new', false
    );
  end if;

  select * into v_ensured
  from public.ensure_user_word_v1(p_user_id, v_note.normalized_text, p_display_text, 'capture', false);
  v_word_id := v_ensured.word_id;
  v_user_word_id := v_ensured.user_word_id;

  if v_ensured.inserted then
    insert into public.daily_imports(user_id, import_date, source, raw_count)
    values (p_user_id, p_import_date, 'capture', 0)
    on conflict (user_id, import_date, source) do nothing
    returning id into v_import_id;
    if v_import_id is null then
      select id into v_import_id
      from public.daily_imports
      where user_id = p_user_id and import_date = p_import_date and source = 'capture';
    end if;

    select coalesce(max(position) + 1, 0) into v_position
    from public.daily_import_words where import_id = v_import_id;
    insert into public.daily_import_words(import_id, word_id, position)
    values (v_import_id, v_word_id, v_position)
    on conflict (import_id, word_id) do nothing;
    update public.daily_imports
    set raw_count = (select count(*) from public.daily_import_words where import_id = v_import_id)
    where id = v_import_id;
  end if;

  update public.captured_notes
  set converted_user_word_id = v_user_word_id, status = 'converted', updated_at = now()
  where user_id = p_user_id and id = v_note.id;

  return jsonb_build_object(
    'note_id', v_note.id,
    'user_word_id', v_user_word_id,
    'normalized_word', v_note.normalized_text,
    'is_new', v_ensured.inserted
  );
end;
$$;

create or replace function public.captured_notes_schema_v1()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    to_regprocedure('public.ensure_user_word_v1(uuid,text,text,text,boolean)') is not null
    and to_regprocedure('public.create_captured_note_v1(uuid,text,text,text,text,text,text,text,text,text,uuid)') is not null
    and to_regprocedure('public.list_captured_notes_v1(uuid,text,text,timestamp with time zone,uuid,integer)') is not null
    and to_regprocedure('public.promote_captured_note_v1(uuid,uuid,date,text)') is not null;
$$;

revoke all on function public.ensure_user_word_v1(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.import_words_v1(uuid, jsonb, date, text) from public, anon, authenticated;
revoke all on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.list_captured_notes_v1(uuid, text, text, timestamp with time zone, uuid, integer) from public, anon, authenticated;
revoke all on function public.promote_captured_note_v1(uuid, uuid, date, text) from public, anon, authenticated;
revoke all on function public.captured_notes_schema_v1() from public, anon, authenticated;

grant execute on function public.ensure_user_word_v1(uuid, text, text, text, boolean) to service_role;
grant execute on function public.import_words_v1(uuid, jsonb, date, text) to service_role;
grant execute on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.list_captured_notes_v1(uuid, text, text, timestamp with time zone, uuid, integer) to service_role;
grant execute on function public.promote_captured_note_v1(uuid, uuid, date, text) to service_role;
grant execute on function public.captured_notes_schema_v1() to service_role;
