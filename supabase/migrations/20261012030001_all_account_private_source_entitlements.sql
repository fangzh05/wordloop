-- Make mapped source definitions available to every WordLoop account through
-- the existing per-word service API. Keep direct table access revoked.
create or replace function commercial_import_admin.grant_mapped_source_entitlements_v1(
  p_user_id uuid default null,
  p_book_id text default null
) returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, commercial_import_admin
as $$
declare
  granted integer;
begin
  insert into public.exam_book_entitlements(
    user_id, book_id, rights_evidence, verified_at, expires_at, third_party_processing_allowed
  )
  select u.id, m.source_book_id,
    'Owner authorization 2026-10-12: all WordLoop accounts may use mapped source definitions only for noncommercial study; no redistribution or third-party processing. Publisher authorization not independently verified.',
    now(), null, false
  from public.users u
  join public.exam_definition_sources m on m.enabled
  join public.exam_books b on b.id = m.source_book_id
  where (p_user_id is null or u.id = p_user_id)
    and (p_book_id is null or m.source_book_id = p_book_id)
    and not b.is_public
    and b.source <> 'source_missing'
    and exists (
      select 1 from public.word_source_definitions d
      where d.book_id = m.source_book_id
    )
  on conflict (user_id, book_id) do nothing;

  get diagnostics granted = row_count;
  return granted;
end;
$$;

create or replace function commercial_import_admin.grant_sources_for_new_account_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, commercial_import_admin
as $$
begin
  perform commercial_import_admin.grant_mapped_source_entitlements_v1(new.id, null);
  return new;
end;
$$;

create or replace function commercial_import_admin.grant_sources_for_mapping_change_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, commercial_import_admin
as $$
begin
  if new.enabled then
    perform commercial_import_admin.grant_mapped_source_entitlements_v1(null, new.source_book_id);
  end if;
  return new;
end;
$$;

create or replace function commercial_import_admin.grant_sources_for_definition_import_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, commercial_import_admin
as $$
declare
  source_book text;
begin
  for source_book in select distinct n.book_id from new_source_rows n loop
    perform commercial_import_admin.grant_mapped_source_entitlements_v1(null, source_book);
  end loop;
  return null;
end;
$$;

revoke all on function commercial_import_admin.grant_mapped_source_entitlements_v1(uuid, text),
  commercial_import_admin.grant_sources_for_new_account_v1(),
  commercial_import_admin.grant_sources_for_mapping_change_v1(),
  commercial_import_admin.grant_sources_for_definition_import_v1()
  from public, anon, authenticated;
grant execute on function commercial_import_admin.grant_mapped_source_entitlements_v1(uuid, text),
  commercial_import_admin.grant_sources_for_new_account_v1(),
  commercial_import_admin.grant_sources_for_mapping_change_v1(),
  commercial_import_admin.grant_sources_for_definition_import_v1()
  to service_role;

create trigger grant_mapped_sources_for_new_account
after insert on public.users
for each row execute function commercial_import_admin.grant_sources_for_new_account_v1();

create trigger grant_mapped_sources_for_mapping_change
after insert or update on public.exam_definition_sources
for each row execute function commercial_import_admin.grant_sources_for_mapping_change_v1();

create trigger grant_mapped_sources_for_definition_import
after insert on public.word_source_definitions
referencing new table as new_source_rows
for each statement execute function commercial_import_admin.grant_sources_for_definition_import_v1();

-- Idempotent production backfill; existing owner grants and their evidence are retained.
select commercial_import_admin.grant_mapped_source_entitlements_v1(null, null);
