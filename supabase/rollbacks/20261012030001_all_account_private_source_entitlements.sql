-- Roll back the all-account grant only; preserve pre-existing account grants.
drop trigger if exists grant_mapped_sources_for_definition_import on public.word_source_definitions;
drop trigger if exists grant_mapped_sources_for_mapping_change on public.exam_definition_sources;
drop trigger if exists grant_mapped_sources_for_new_account on public.users;

delete from public.exam_book_entitlements
where rights_evidence = 'Owner authorization 2026-10-12: all WordLoop accounts may use mapped source definitions only for noncommercial study; no redistribution or third-party processing. Publisher authorization not independently verified.';

drop function if exists commercial_import_admin.grant_sources_for_definition_import_v1();
drop function if exists commercial_import_admin.grant_sources_for_mapping_change_v1();
drop function if exists commercial_import_admin.grant_sources_for_new_account_v1();
drop function if exists commercial_import_admin.grant_mapped_source_entitlements_v1(uuid, text);
