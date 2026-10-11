import {readFileSync,writeFileSync} from 'node:fs';
import {sha256} from './lib/examBooks.js';
const [dir,output]=process.argv.slice(2);
if(!dir||!output)throw Error('Usage: prepare-exam-import REVIEWED_OUTPUT_DIR SQL_OUTPUT');
const manifest=JSON.parse(readFileSync(`${dir}/manifest.json`,'utf8'));
if(!manifest.publication_ready)throw Error('Unresolved review: no production import permitted');
const raw=readFileSync(`${dir}/final-corpus.json`,'utf8');
if(sha256(raw)!==manifest.files['final-corpus.json'])throw Error('Manifest hash mismatch');
for(const [file,hash] of Object.entries(manifest.files))if(sha256(readFileSync(`${dir}/${file}`,'utf8'))!==hash)throw Error(`Audit artifact changed: ${file}`);
const payload=JSON.parse(raw);
const quote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
const sql=`-- Review this diff and verify a restorable backup BEFORE execution.
-- Does not publish books or change learner data. Run as an administrative role.
begin;
select pg_advisory_xact_lock(hashtextextended('wordloop-exam-dictionary-import',482));
create temp table exam_import_dictionary on commit drop as select * from jsonb_populate_recordset(null::public.lexical_dictionary_entries,${quote(JSON.stringify(payload.dictionary_entries))}::jsonb);
insert into public.lexical_dictionary_entries(entry_id,lemma,language,phonetic,english_definition,chinese_translation,parts_of_speech,source,source_version,license,provenance,confidence)
select entry_id,lemma,language,phonetic,english_definition,chinese_translation,parts_of_speech,source,source_version,license,provenance,confidence from exam_import_dictionary incoming
where not exists(select 1 from public.lexical_dictionary_entries existing where existing.language=incoming.language and existing.lemma=incoming.lemma)
on conflict do nothing;
insert into public.exam_book_words(book_id,normalized_word,source,source_version,source_records)
select book_id,normalized_word,source,source_version,source_records from jsonb_populate_recordset(null::public.exam_book_words,${quote(JSON.stringify(payload.relationships))}::jsonb)
on conflict(book_id,normalized_word) do nothing;
commit;
-- Publication requires separate exact-count, dictionary coverage, RLS, backup
-- and license checks; this import never sets is_public or is_available.
`;
writeFileSync(output,sql);console.log(JSON.stringify({sha256:sha256(sql),rows:payload.dictionary_entries.length,relationships:payload.relationships.length}));
