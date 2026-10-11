import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir=process.argv[2]??'.exam-books/expansion/backup';
const load=(f:string)=>JSON.parse(readFileSync(`${dir}/${f}`,'utf8'));
const schema=load('schema-columns.json') as Array<{relname:string;columns:string}>;
const db=new PGlite();const hashes:Record<string,string>={};const report:any={scope:'Actual production dictionary, exam catalog and memberships; excludes learner tables and is not a full-project backup',tables:{}};
try{
 await db.exec("set time zone 'UTC'");
 for(const s of schema){
  await db.exec(`create table ${s.relname}(${s.columns})`);
  const files=s.relname==='lexical_dictionary_entries'?Array.from({length:53},(_,i)=>`dictionary-${i}.json`):[`${s.relname}.json`];
  let count=0;
  for(const f of files){const raw=readFileSync(`${dir}/${f}`,'utf8');hashes[f]=createHash('sha256').update(raw).digest('hex');const rows=JSON.parse(raw);count+=rows.length;await db.query(`insert into ${s.relname} select * from jsonb_populate_recordset(null::${s.relname},$1::jsonb)`,[raw]);}
  const result=(await db.query(`select count(*) n,md5(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text collate "C")) hash from ${s.relname} t`)).rows[0] as any;
  if(result.n!==count)throw Error('Backup restore count mismatch');
  if(s.relname==='lexical_dictionary_entries'){for(const f of files){const mismatch=(await db.query(`select count(*) n from jsonb_array_elements($1::jsonb) j left join lexical_dictionary_entries t on t.entry_id=j->>'entry_id' where t.entry_id is null or to_jsonb(t)<>j`,[readFileSync(`${dir}/${f}`,'utf8')])).rows[0] as any;if(mismatch.n){console.log((await db.query(`select k.key, k.value original,to_jsonb(t)->k.key restored from jsonb_array_elements($1::jsonb) j join lexical_dictionary_entries t on t.entry_id=j->>'entry_id' cross join lateral jsonb_each(j) k where k.value is distinct from to_jsonb(t)->k.key limit 3`,[readFileSync(`${dir}/${f}`,'utf8')])).rows);throw Error('Restored dictionary JSON differs from backup: '+f+' count='+mismatch.n);}}}
  report.tables[s.relname]={...result,json_restore_exact:true};
 }
 const live=load('live-hashes.json');for(const t of live)if(report.tables[t.tab].hash!==t.hash||report.tables[t.tab].n!==t.n)throw Error('Live backup hash mismatch: '+t.tab);
 report.live_hashes_match=true;report.restored=true;report.files=hashes;report.note='Compare table hashes with a fresh live read before authorizing import';
 if(process.argv.includes('--replay')){
  await db.exec(`create role anon;create role authenticated;
alter table exam_books add primary key(id);
alter table exam_book_words add primary key(book_id,normalized_word);
create index exam_word_lookup on exam_book_words(normalized_word,book_id);
alter table lexical_dictionary_entries add primary key(entry_id);
alter table lexical_dictionary_entries add unique(language,lemma,source,source_version);`);
  const state=async()=> (await db.query(`select (select count(*) from exam_book_words) members,(select count(*) from lexical_dictionary_entries) dictionary,(select sum(pg_total_relation_size(oid))::bigint from pg_class where relkind='r' and relnamespace in ('public'::regnamespace,coalesce(to_regnamespace('exam_expansion_audit'),0))) bytes`)).rows[0];
  const before=await state();let sql=readFileSync(`${dir}/../review-import.sql`,'utf8');
  if(process.argv.includes('--transport')){
   await db.exec(readFileSync('supabase/migrations/20261011113807_exam_expansion_audit.sql','utf8'));
   const transportDir='.exam-books/expansion/deployment';
   for(const file of readdirSync(transportDir).filter(f=>/^part-\d+\.sql$/.test(f)))await db.exec(readFileSync(`${transportDir}/${file}`,'utf8'));
   sql=readFileSync(`${transportDir}/apply.sql`,'utf8');
  }
  await db.exec(sql);const first=await state();await db.exec(sql);const second=await state();
  if((first as any).members!==(second as any).members||(first as any).dictionary!==(second as any).dictionary)throw Error('Real backup replay not idempotent');
  const changed=(await db.query(`select count(*) n from exam_expansion_audit.snapshots s join lexical_dictionary_entries t on t.entry_id=s.row_data->>'entry_id' where s.table_name='lexical_dictionary_entries' and to_jsonb(t)<>s.row_data`)).rows[0] as any;
  if(changed.n)throw Error('Existing real dictionary changed');
  await db.exec(readFileSync(`${dir}/../rollback-members.sql`,'utf8'));const rollback=await state();
  if((rollback as any).members!==(before as any).members)throw Error('Real membership rollback failed');
  report.import_replay={before,first,second,rollback,existing_dictionary_unchanged:true,note:'Actual backed-up data in isolated PostgreSQL. Storage includes private audit snapshots, approximate production index layout; not a production measurement.'};
 }
 writeFileSync(`${dir}/verification.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,files:undefined}));
}finally{await db.close();}
