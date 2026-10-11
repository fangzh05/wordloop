import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,isAbsolute,relative} from 'node:path';
import {privateDataRoot} from './lib/privateDataPath.js';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {sha256} from './lib/examBooks.js';
import {privateBookImportSql} from './lib/privateBookImport.js';
const root=privateDataRoot(process.argv[2]);
const load=(name:string)=>readFileSync(resolve(root,name),'utf8');
const gate=z.object({production_write_authorized:z.literal(true),private_use_attestation:z.string().min(20),workbuddy_review_sha256:z.string().length(64),dry_run_sha256:z.string().length(64),snapshot_sha256:z.string().length(64),normalized_draft_sha256:z.string().length(64)}).parse(JSON.parse(load('release-gate.json')));
if(sha256(load('workbuddy-code-audit-final.json'))!==gate.workbuddy_review_sha256||sha256(load('replay-report.json'))!==gate.dry_run_sha256||sha256(load('identity-snapshot.json'))!==gate.snapshot_sha256)throw Error('Release evidence changed');
const audit=JSON.parse(load('workbuddy-code-audit-final.json'));if(audit.verdict!=='pass')throw Error('Release review has unresolved findings');
for(const [path,hash] of Object.entries(audit.code_sha256??{})){if(sha256(readFileSync(new URL('../'+path,import.meta.url),'utf8'))!==hash)throw Error('Code changed after review: '+path);}
if(sha256(load('normalized-draft.json'))!==gate.normalized_draft_sha256)throw Error('Reviewed draft changed');
const replay=JSON.parse(load('replay-report.json'));if(!replay.existing_rows_unchanged||replay.passes.length!==2||replay.passes.some((p:any)=>p.user_words!==0||p.fsrs_logs!==0)||['words','members','definitions','batches','user_words','fsrs_logs'].some(k=>!Number.isInteger(replay.passes[0][k])||replay.passes[0][k]!==replay.passes[1][k]))throw Error('Dry run failed');
const snapshot=JSON.parse(load('identity-snapshot.json'));if(!snapshot.words.length||snapshot.mode!=='read-only')throw Error('Invalid baseline snapshot');
const draft=JSON.parse(load('normalized-draft.json'));const dir=resolve(root,'production-sql-'+randomUUID());mkdirSync(dir);
const manifest=[];let index=0;
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
for(const[id,book]of Object.entries(draft.books) as [string,any][]){
 if(book.records.some((r:any)=>typeof r.requires_human_review!=='boolean'))throw Error('Missing explicit review decision');
 const source=book.source;if(!isAbsolute(source.local))throw Error('Source file path must be absolute');const sourcePath=privateDataRoot(source.local);if(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')!==source.sha256)throw Error('Source checksum drift');
 const prepared=privateBookImportSql(id,source,book.records,{private_use_attested:true,original_wording_verified:false,private_use_evidence_sha256:sha256(gate.private_use_attestation)},true);
 const expected=replay.imports.find((b:any)=>b.id===id);if(!expected||expected.batch!==prepared.batch||expected.accepted!==prepared.accepted)throw Error('Prepared data differs from dry run');
 const quarantineFile=id+'-quarantine.json',quarantineText=JSON.stringify(prepared.quarantine,null,2);writeFileSync(resolve(dir,quarantineFile),quarantineText);const quarantine_artifact={file:quarantineFile,sha256:sha256(quarantineText)};
 if(!prepared.accepted){manifest.push({id,batch:null,accepted:0,quarantined:prepared.quarantined,status:'quarantined',quarantine_artifact,files:[]});continue;}
 const files=[];
 const header=`do $batch$ begin if exists(select 1 from source_definition_batches where id=${quote(prepared.batch)} and (book_id is distinct from ${quote(id)} or source_commit is distinct from ${quote(source.commit)} or source_sha256 is distinct from ${quote(source.sha256)} or record_count is distinct from ${prepared.accepted})) then raise exception 'BATCH_METADATA_DRIFT';end if;end $batch$;insert into source_definition_batches(id,book_id,source_commit,source_sha256,record_count) values(${quote(prepared.batch)},${quote(id)},${quote(source.commit)},${quote(source.sha256)},${prepared.accepted}) on conflict do nothing;`;
 for(let start=0;start<prepared.transferRows.length;start+=150){
  const sql=`begin;\n${header}\nselect commercial_import_admin.import_rows_v1(${quote(id)},${quote(prepared.batch)},${quote(JSON.stringify(prepared.transferRows.slice(start,start+150)))}::jsonb) inserted;\ncommit;`;
  const file=`${String(index++).padStart(3,'0')}.sql`;writeFileSync(resolve(dir,file),sql);files.push({file,sha256:sha256(sql),rows:Math.min(150,prepared.transferRows.length-start)});
 }
 const sorted=[...prepared.transferRows].sort((a,b)=>a.entry_key<b.entry_key?-1:a.entry_key>b.entry_key?1:0);
 manifest.push({id,quarantine_artifact,batch:prepared.batch,accepted:prepared.accepted,unique_words:new Set(prepared.transferRows.map(r=>r.normalized_word)).size,quarantined:prepared.quarantined,
  content_md5:createHash('md5').update(sorted.map(r=>r.entry_key+r.content_hash).join('')).digest('hex'),
  raw_definition_md5:createHash('md5').update(sorted.map(r=>r.definition_raw).join('')).digest('hex'),files});
}
const finalizeSql=manifest.filter(b=>b.batch).map(b=>`do $final$ begin if (select count(*) from word_source_definitions where batch_id=${quote(b.batch!)})<>${b.accepted} or (select md5(string_agg(entry_key||content_hash,'' order by entry_key)) from word_source_definitions where batch_id=${quote(b.batch!)}) is distinct from ${quote(b.content_md5!)} or (select md5(string_agg(definition_raw,'' order by entry_key)) from word_source_definitions where batch_id=${quote(b.batch!)}) is distinct from ${quote(b.raw_definition_md5!)} then raise exception 'INCOMPLETE_SOURCE_BATCH';end if;end $final$;`).join('\n');writeFileSync(resolve(dir,'finalize.sql'),finalizeSql);
writeFileSync(resolve(root,'production-sql-manifest.json'),JSON.stringify({gate,sql_directory:relative(root,dir),execution_contract:'Abort on first SQL error; checksum every listed file; execute finalize.sql before activation. psql requires -v ON_ERROR_STOP=1.',finalize:{file:'finalize.sql',sha256:sha256(finalizeSql)},books:manifest},null,2));console.log(JSON.stringify({books:manifest.map(({files,...book})=>({...book,chunks:files.length})),chunks:index}));
