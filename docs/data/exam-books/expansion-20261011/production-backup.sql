begin; set local time zone 'UTC';
select pg_advisory_xact_lock(hashtextextended('wordloop-exam-dictionary-import',482));
insert into exam_expansion_audit.snapshots select 'expansion_d7df5e05d9b42663_predeploy','lexical_dictionary_entries',to_jsonb(t) from public.lexical_dictionary_entries t;
insert into exam_expansion_audit.snapshots select 'expansion_d7df5e05d9b42663_predeploy','exam_book_words',to_jsonb(t) from public.exam_book_words t;
insert into exam_expansion_audit.snapshots select 'expansion_d7df5e05d9b42663_predeploy','exam_books',to_jsonb(t) from public.exam_books t;
do $$declare rel text; n bigint; h text; result jsonb:='[]'; begin
for rel in select tablename from pg_tables where schemaname='public' and tablename not in ('lexical_dictionary_entries','exam_book_words','exam_books') order by tablename loop
execute format('select count(*),md5(string_agg(to_jsonb(t)::text,E''\n'' order by to_jsonb(t)::text collate "C")) from public.%I t',rel) into n,h;
result:=result||jsonb_build_array(jsonb_build_object('table',rel,'n',n,'hash',h));
end loop;
insert into exam_expansion_audit.checkpoints(batch,phase,data) values('expansion_d7df5e05d9b42663','before',result);
end$$;
commit;
select table_name,count(*) n,md5(string_agg(row_data::text,E'\n' order by row_data::text collate "C")) hash from exam_expansion_audit.snapshots where batch='expansion_d7df5e05d9b42663_predeploy' group by table_name order by table_name;
