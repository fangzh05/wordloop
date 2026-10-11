import {sha256} from './examBooks.js';
const quote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
export function expansionSql(payload:{dictionary_entries:unknown[];relationships:unknown[]},provenance:unknown,baseline:unknown[]){
 const hash=sha256(JSON.stringify({payload,provenance,baseline})),batch='expansion_'+hash.slice(0,16);
 const catalog=['cet6','ielts','toefl'].map(book=>{const words=[...new Set([...baseline,...payload.relationships].filter((x:any)=>x.book_id===book).map((x:any)=>x.normalized_word as string))].sort();return {id:book,checksum:sha256(JSON.stringify(words)),count:words.length};});
 const sql=`-- REVIEW ONLY. Execute only after explicit production approval and current backup restore verification.
begin;
select pg_advisory_xact_lock(hashtextextended('wordloop-exam-dictionary-import',482));
create schema if not exists exam_expansion_audit;
revoke all on schema exam_expansion_audit from public,anon,authenticated;
create table if not exists exam_expansion_audit.batches(id text primary key,created_at timestamptz default now(),baseline jsonb not null,provenance jsonb not null);
create table if not exists exam_expansion_audit.members(batch text not null,book_id text not null,normalized_word text not null,primary key(batch,book_id,normalized_word));
create table if not exists exam_expansion_audit.snapshots(batch text not null,table_name text not null,row_data jsonb not null);
revoke all on all tables in schema exam_expansion_audit from public,anon,authenticated;
create temp table expansion_incoming on commit drop as select * from jsonb_populate_recordset(null::public.exam_book_words,${quote(JSON.stringify(payload.relationships))}::jsonb);
do $$begin
 if exists(select 1 from expansion_incoming where book_id not in ('cet6','ielts','toefl')) then raise exception 'Forbidden book'; end if;
 if not exists(select 1 from exam_expansion_audit.batches where id=${quote(batch)}) and
 (select coalesce(jsonb_agg(jsonb_build_object('book_id',book_id,'normalized_word',normalized_word) order by book_id,normalized_word),'[]') from public.exam_book_words)
 <> (select jsonb_agg(x order by x->>'book_id',x->>'normalized_word') from jsonb_array_elements(${quote(JSON.stringify(baseline))}::jsonb) x)
 then raise exception 'Membership baseline drift';end if;
end$$;
-- A same-transaction scoped snapshot precedes every first import. Offsite backup and restore probe are separate release gates.
insert into exam_expansion_audit.snapshots select ${quote(batch)},'lexical_dictionary_entries',to_jsonb(d) from public.lexical_dictionary_entries d where not exists(select 1 from exam_expansion_audit.batches where id=${quote(batch)});
insert into exam_expansion_audit.snapshots select ${quote(batch)},'exam_book_words',to_jsonb(w) from public.exam_book_words w where not exists(select 1 from exam_expansion_audit.batches where id=${quote(batch)});
insert into exam_expansion_audit.snapshots select ${quote(batch)},'exam_books',to_jsonb(b) from public.exam_books b where not exists(select 1 from exam_expansion_audit.batches where id=${quote(batch)});
insert into exam_expansion_audit.batches(id,baseline,provenance) values(${quote(batch)},${quote(JSON.stringify(baseline))}::jsonb,${quote(JSON.stringify(provenance))}::jsonb) on conflict do nothing;
insert into public.lexical_dictionary_entries(entry_id,lemma,language,phonetic,english_definition,chinese_translation,parts_of_speech,source,source_version,license,provenance,confidence)
select entry_id,lemma,language,phonetic,english_definition,chinese_translation,parts_of_speech,source,source_version,license,provenance,confidence from jsonb_populate_recordset(null::public.lexical_dictionary_entries,${quote(JSON.stringify(payload.dictionary_entries))}::jsonb) incoming
where not exists(select 1 from public.lexical_dictionary_entries existing where existing.language=incoming.language and existing.lemma=incoming.lemma)
on conflict do nothing;
do $$begin if exists(select 1 from expansion_incoming i where not exists(select 1 from public.lexical_dictionary_entries d where d.lemma=i.normalized_word and d.language='en' and length(btrim(d.chinese_translation))>0)) then raise exception 'Missing Chinese dictionary coverage';end if;end$$;
with inserted as (insert into public.exam_book_words(book_id,normalized_word,source,source_version,source_records) select book_id,normalized_word,source,source_version,source_records from expansion_incoming on conflict(book_id,normalized_word) do nothing returning book_id,normalized_word)
insert into exam_expansion_audit.members select ${quote(batch)},book_id,normalized_word from inserted on conflict do nothing;
do $$begin if exists(select 1 from jsonb_to_recordset(${quote(JSON.stringify(catalog))}::jsonb) as expected(id text,count integer,checksum text) where expected.count<>(select count(*) from public.exam_book_words w where w.book_id=expected.id)) then raise exception 'Final count mismatch';end if;end$$;
update public.exam_books b set checksum=c.checksum,source=b.source||' + curated expansion',source_version=${quote(batch)},license=b.license||'; supplementary headwords: KyleBing BSD-3-Clause, NAWL CC-BY-SA-4.0, gungorkaya MIT; see WordLoop exam expansion source ledger' from jsonb_to_recordset(${quote(JSON.stringify(catalog))}::jsonb) as c(id text,checksum text,count integer) where b.id=c.id and b.source_version<>${quote(batch)};
commit;
`;
 const rollback=`-- Explicit approval required. Retain dictionary additions and ALL learning data.
begin;
select pg_advisory_xact_lock(hashtextextended('wordloop-exam-dictionary-import',482));
delete from public.exam_book_words w using exam_expansion_audit.members a where a.batch=${quote(batch)} and a.book_id=w.book_id and a.normalized_word=w.normalized_word and w.source='WordLoop exam expansion' and w.source_version='expansion-v1';
update public.exam_books b set checksum=s.row_data->>'checksum',source=s.row_data->>'source',source_version=s.row_data->>'source_version',license=s.row_data->>'license' from exam_expansion_audit.snapshots s where s.batch=${quote(batch)} and s.table_name='exam_books' and b.id=s.row_data->>'id' and b.source_version=${quote(batch)};
commit;
`;
 return {batch,hash,sql,rollback};
}
