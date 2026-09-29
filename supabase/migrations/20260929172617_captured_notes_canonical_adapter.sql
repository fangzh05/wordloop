-- Canonical Capture source is captured_notes + captured_note_occurrences.
-- The legacy capture_* tables remain available for reconciliation and rollback.

-- These additive guards make a clean database migration chain reproducible,
-- while remaining no-ops for environments where the canonical store already exists.
create table if not exists public.captured_notes (
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

-- A clean chain creates both keys above. Older canonical deployments may have
-- the same globally unique IDs without the composite keys used for ownership.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_notes'::regclass
      and contype in ('u', 'p')
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'id')
      ]::smallint[]
  ) then
    alter table public.captured_notes
      add constraint captured_notes_user_id_id_key unique (user_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_notes'::regclass
      and contype in ('u', 'p')
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'normalized_text')
      ]::smallint[]
  ) then
    if exists (
      select 1 from public.captured_notes
      group by user_id, normalized_text
      having count(*) > 1
    ) then
      raise exception 'CAPTURE_CANONICAL_DUPLICATE_NORMALIZED_TEXT';
    end if;
    alter table public.captured_notes
      add constraint captured_notes_user_normalized_text_key unique (user_id, normalized_text);
  end if;
end;
$$;

create table if not exists public.captured_note_occurrences (
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

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_note_occurrences'::regclass
      and contype in ('u', 'p')
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'idempotency_key')
      ]::smallint[]
  ) then
    if exists (
      select 1 from public.captured_note_occurrences
      group by user_id, idempotency_key
      having count(*) > 1
    ) then
      raise exception 'CAPTURE_CANONICAL_DUPLICATE_IDEMPOTENCY_KEY';
    end if;
    alter table public.captured_note_occurrences
      add constraint captured_note_occurrences_user_idempotency_key_key unique (user_id, idempotency_key);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_note_occurrences'::regclass
      and contype = 'f'
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'captured_note_id')
      ]::smallint[]
      and confkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'id')
      ]::smallint[]
  ) then
    if exists (
      select 1 from public.captured_note_occurrences as occurrence
      left join public.captured_notes as note
        on note.user_id = occurrence.user_id and note.id = occurrence.captured_note_id
      where note.id is null
    ) then
      raise exception 'CAPTURE_CANONICAL_ORPHAN_OCCURRENCE';
    end if;
    alter table public.captured_note_occurrences
      add constraint captured_note_occurrences_user_note_fkey
      foreign key (user_id, captured_note_id) references public.captured_notes(user_id, id) on delete cascade;
  end if;
end;
$$;

create index if not exists captured_notes_user_status_updated_idx
  on public.captured_notes(user_id, status, updated_at desc, id desc);
create index if not exists captured_note_occurrences_user_note_captured_idx
  on public.captured_note_occurrences(user_id, captured_note_id, captured_at desc);
alter table public.captured_notes enable row level security;
alter table public.captured_note_occurrences enable row level security;
revoke all on public.captured_notes, public.captured_note_occurrences from public, anon, authenticated;
grant select, insert, update, delete on public.captured_notes, public.captured_note_occurrences to service_role;

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
      where o.user_id = p_user_id and o.captured_note_id = n.id) as occurrence_count,
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
        where o.user_id = p_user_id and o.captured_note_id = n.id
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
        where o.user_id = p_user_id and o.captured_note_id = n.id
          and strpos(lower(o.context_text), lower(p_query)) > 0
      ))
  order by n.updated_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 51);
$$;

do $$
begin
  if exists (
    select 1
    from public.capture_notes as legacy
    left join public.user_words as uw
      on uw.user_id = legacy.user_id and uw.word_id = legacy.linked_word_id
    where legacy.status = 'learning'
      and (legacy.linked_word_id is null or uw.id is null)
  ) then
    raise exception 'CAPTURE_MIGRATION_UNRESOLVED_LEGACY_LINK';
  end if;
end;
$$;

-- Preserve historical text if the older writer exceeded canonical limits.
do $$
declare
  v_note_limit integer;
  v_context_limit integer;
  v_source_ref_limit integer;
begin
  select greatest(500, coalesce(max(length(note)), 0))
    into v_note_limit from public.capture_notes;
  if v_note_limit > 500 then
    alter table public.captured_notes drop constraint if exists captured_notes_note_check;
    execute format(
      'alter table public.captured_notes add constraint captured_notes_note_check check (length(note) <= %s)',
      v_note_limit
    );
  end if;

  select greatest(1200, coalesce(max(length(context_text)), 0))
    into v_context_limit from public.capture_note_occurrences;
  if v_context_limit > 1200 then
    alter table public.captured_note_occurrences drop constraint if exists captured_note_occurrences_context_text_check;
    execute format(
      'alter table public.captured_note_occurrences add constraint captured_note_occurrences_context_text_check check (length(context_text) <= %s)',
      v_context_limit
    );
  end if;

  select greatest(256, coalesce(max(length(source_ref)), 0))
    into v_source_ref_limit from public.capture_note_occurrences;
  if v_source_ref_limit > 256 then
    alter table public.captured_note_occurrences drop constraint if exists captured_note_occurrences_source_ref_check;
    execute format(
      'alter table public.captured_note_occurrences add constraint captured_note_occurrences_source_ref_check check (source_ref is null or length(source_ref) <= %s)',
      v_source_ref_limit
    );
  end if;
end;
$$;

create table if not exists public.capture_note_legacy_map (
  legacy_note_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  captured_note_id uuid not null,
  legacy_word_id uuid,
  legacy_note text not null,
  legacy_status text not null,
  legacy_occurrence_count integer not null,
  legacy_created_at timestamptz not null,
  legacy_updated_at timestamptz not null,
  migrated_at timestamptz not null default now(),
  constraint capture_note_legacy_map_canonical_fk
    foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade
);

alter table public.capture_note_legacy_map enable row level security;
revoke all on table public.capture_note_legacy_map from public, anon, authenticated;
grant all on table public.capture_note_legacy_map to service_role;

-- Preserve each old parent ID and word_id -> user_words.id conversion for audit.
insert into public.captured_notes(
  user_id, selected_text, normalized_text, selection_type, note, status,
  converted_user_word_id, created_at, updated_at
)
select
  legacy.user_id,
  legacy.selected_text,
  legacy.normalized_text,
  legacy.selection_type,
  legacy.note,
  case
    when legacy.status = 'archived' then 'dismissed'
    when uw.id is not null then 'converted'
    else legacy.status
  end,
  uw.id,
  legacy.created_at,
  legacy.updated_at
from public.capture_notes as legacy
left join public.user_words as uw
  on uw.user_id = legacy.user_id and uw.word_id = legacy.linked_word_id
order by legacy.created_at, legacy.id
on conflict (user_id, normalized_text) do nothing;

insert into public.capture_note_legacy_map(
  legacy_note_id, user_id, captured_note_id, legacy_word_id, legacy_note,
  legacy_status, legacy_occurrence_count, legacy_created_at, legacy_updated_at
)
select
  legacy.id,
  legacy.user_id,
  canonical.id,
  legacy.linked_word_id,
  legacy.note,
  legacy.status,
  legacy.occurrence_count,
  legacy.created_at,
  legacy.updated_at
from public.capture_notes as legacy
join public.captured_notes as canonical
  on canonical.user_id = legacy.user_id
 and canonical.normalized_text = legacy.normalized_text
on conflict (legacy_note_id) do nothing;

do $$
begin
  if exists (
    select 1
    from public.capture_note_occurrences as legacy_occurrence
    join public.capture_note_legacy_map as mapping
      on mapping.legacy_note_id = legacy_occurrence.note_id
     and mapping.user_id = (select user_id from public.capture_notes where id = legacy_occurrence.note_id)
    join public.captured_note_occurrences as canonical_occurrence
      on canonical_occurrence.user_id = mapping.user_id
     and canonical_occurrence.idempotency_key = legacy_occurrence.id
    where canonical_occurrence.captured_note_id <> mapping.captured_note_id
  ) then
    raise exception 'CAPTURE_MIGRATION_OCCURRENCE_KEY_CONFLICT';
  end if;
end;
$$;

insert into public.captured_note_occurrences(
  user_id, captured_note_id, context_text, source_type, source_ref,
  source_title, source_url, captured_at, idempotency_key
)
select
  mapping.user_id,
  mapping.captured_note_id,
  legacy_occurrence.context_text,
  case legacy_occurrence.source_type
    when 'lesson' then 'lesson_example'
    when 'review' then 'review_question'
    else 'manual'
  end,
  legacy_occurrence.source_ref,
  case legacy_occurrence.source_type
    when 'pretest' then 'WordLoop · 预测试（旧来源）'
    when 'dashboard' then 'WordLoop · 今日（旧来源）'
    else null
  end,
  null,
  legacy_occurrence.created_at,
  legacy_occurrence.id
from public.capture_note_occurrences as legacy_occurrence
join public.capture_note_legacy_map as mapping
  on mapping.legacy_note_id = legacy_occurrence.note_id
on conflict (user_id, idempotency_key) do nothing;

update public.captured_notes as canonical
set updated_at = greatest(canonical.updated_at, recent.last_seen_at)
from (
  select captured_note_id, max(captured_at) as last_seen_at
  from public.captured_note_occurrences
  group by captured_note_id
) as recent
where canonical.id = recent.captured_note_id
  and recent.last_seen_at > canonical.updated_at;

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
  else
    update public.captured_notes
    set updated_at = greatest(updated_at, clock_timestamp())
    where user_id = p_user_id and id = v_note_id;
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
  v_inserted integer;
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
    or p_display_text <> btrim(p_display_text) or lower(p_display_text) <> v_note.normalized_text
    or cardinality(regexp_split_to_array(btrim(p_display_text), '[[:space:]]+')) > 2 then
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

  insert into public.words(normalized_word, display_word)
  values (v_note.normalized_text, p_display_text)
  on conflict (normalized_word) do update set normalized_word = excluded.normalized_word
  returning id into v_word_id;

  insert into public.user_words(user_id, word_id, source)
  values (p_user_id, v_word_id, 'capture')
  on conflict (user_id, word_id) do nothing;
  get diagnostics v_inserted = row_count;

  select id into v_user_word_id
  from public.user_words
  where user_id = p_user_id and word_id = v_word_id;

  if v_inserted = 1 then
    insert into public.daily_imports(user_id, import_date, source, raw_count)
    values (p_user_id, p_import_date, 'capture', 0)
    on conflict (user_id, import_date, source) do nothing
    returning id into v_import_id;

    if v_import_id is null then
      select id into v_import_id
      from public.daily_imports
      where user_id = p_user_id and import_date = p_import_date and source = 'capture'
      for update;
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
    'is_new', v_inserted = 1
  );
end;
$$;

revoke all on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.list_captured_notes_v1(uuid, text, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.promote_captured_note_v1(uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.list_captured_notes_v1(uuid, text, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.promote_captured_note_v1(uuid, uuid, date, text) to service_role;
