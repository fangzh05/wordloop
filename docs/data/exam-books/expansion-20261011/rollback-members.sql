-- Explicit approval required. Retain dictionary additions and ALL learning data.
begin;
select pg_advisory_xact_lock(hashtextextended('wordloop-exam-dictionary-import',482));
delete from public.exam_book_words w using exam_expansion_audit.members a where a.batch='expansion_d7df5e05d9b42663' and a.book_id=w.book_id and a.normalized_word=w.normalized_word and w.source='WordLoop exam expansion' and w.source_version='expansion-v1';
update public.exam_books b set checksum=s.row_data->>'checksum',source=s.row_data->>'source',source_version=s.row_data->>'source_version',license=s.row_data->>'license' from exam_expansion_audit.snapshots s where s.batch='expansion_d7df5e05d9b42663' and s.table_name='exam_books' and b.id=s.row_data->>'id' and b.source_version='expansion_d7df5e05d9b42663';
commit;
