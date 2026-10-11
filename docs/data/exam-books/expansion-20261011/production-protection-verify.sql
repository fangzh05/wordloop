begin;set local time zone 'UTC';
do $$declare rel text; n bigint; h text; result jsonb:='[]'; begin
for rel in select tablename from pg_tables where schemaname='public' and tablename not in ('lexical_dictionary_entries','exam_book_words','exam_books') order by tablename loop
execute format('select count(*),md5(string_agg(to_jsonb(t)::text,E''\n'' order by to_jsonb(t)::text collate "C")) from public.%I t',rel) into n,h;
result:=result||jsonb_build_array(jsonb_build_object('table',rel,'n',n,'hash',h));
end loop;
insert into exam_expansion_audit.checkpoints(batch,phase,data) values('expansion_d7df5e05d9b42663','after',result);
if result<>(select data from exam_expansion_audit.checkpoints where batch='expansion_d7df5e05d9b42663' and phase='before') then raise exception 'Protected public table changed';end if;
end$$;commit;
select phase,created_at,jsonb_array_length(data) protected_tables from exam_expansion_audit.checkpoints where batch='expansion_d7df5e05d9b42663' and phase in ('before','after');
