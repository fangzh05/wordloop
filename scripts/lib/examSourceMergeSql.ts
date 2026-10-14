import {createHash} from 'node:crypto';
import {exams,type MappingSnapshot,planExamSourceMapping} from './examSourceMapping.js';
import {sha256} from './examBooks.js';
const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const md5=(s:string)=>createHash('md5').update(s).digest('hex');
// PostgreSQL COLLATE "C" sorts UTF-8 bytes, not JavaScript UTF-16 code units.
const byteOrder=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
export function examSourceMergeSql(snapshot:MappingSnapshot,plan:ReturnType<typeof planExamSourceMapping>){
 const batch=sha256(JSON.stringify({rules:plan.rules,additions:plan.additions,sources:snapshot.definition_hashes}));
 const signatures=exams.map(id=>{const old=[...new Set(snapshot.members.filter(m=>m.book_id===id).map(m=>m.normalized_word))].sort(byteOrder);
  return {id,old:md5(old.join('\n')),final:md5([...new Set([...old,...plan.additions.filter(a=>a.exam===id).map(a=>a.word)])].sort(byteOrder).join('\n'))};});
 const guards=signatures.map(s=>`if (select md5(coalesce(string_agg(normalized_word,E'\\n' order by normalized_word collate "C"),'')) from exam_book_words where book_id=${q(s.id)}) not in (${q(s.old)},${q(s.final)}) then raise exception 'MEMBERSHIP_BASELINE_DRIFT';end if;`).join('\n');
 const sourceGuards=(snapshot.definition_hashes as {book_id:string;total:number;content_md5:string;raw_md5:string}[]).map(s=>`if (select count(*) from word_source_definitions where book_id=${q(s.book_id)})<>${s.total} or (select md5(string_agg(entry_key||content_hash,'' order by entry_key)) from word_source_definitions where book_id=${q(s.book_id)}) is distinct from ${q(s.content_md5)} or (select md5(string_agg(definition_raw,'' order by entry_key)) from word_source_definitions where book_id=${q(s.book_id)}) is distinct from ${q(s.raw_md5)} then raise exception 'SOURCE_BASELINE_DRIFT';end if;`).join('\n');
 const sql=`begin;
select pg_advisory_xact_lock(hashtextextended('five-exam-source-merge',482));
lock table exam_book_words in share row exclusive mode;
do $guard$ begin ${guards}\n${sourceGuards} end $guard$;
create table if not exists commercial_import_admin.exam_source_merge_audit (
 batch_id text not null,exam_id text not null,normalized_word text not null,evidence jsonb not null,
 created_at timestamptz not null default now(),primary key(batch_id,exam_id,normalized_word));
alter table commercial_import_admin.exam_source_merge_audit enable row level security;
revoke all on commercial_import_admin.exam_source_merge_audit from public,anon,authenticated;
grant all on commercial_import_admin.exam_source_merge_audit to service_role;
create temporary table proposed_exam_members on commit drop as select * from jsonb_to_recordset(${q(JSON.stringify(plan.additions))}::jsonb) as r(exam text,word text,sources jsonb,independent_tag text);
do $identity$ begin if exists(select 1 from proposed_exam_members p where not exists(select 1 from words w where w.normalized_word=p.word) or not exists(select 1 from word_source_definitions s where s.normalized_word=p.word and p.sources ? s.book_id)) then raise exception 'UNVERIFIED_SOURCE_IDENTITY';end if;end $identity$;
insert into commercial_import_admin.exam_source_merge_audit(batch_id,exam_id,normalized_word,evidence)
select ${q(batch)},exam,word,jsonb_build_object('sources',sources,'independent_tag',independent_tag,'evidence_pin',${q(plan.independent_evidence.sha256)}) from proposed_exam_members on conflict do nothing;
insert into exam_book_words(book_id,normalized_word,source,source_version,source_records)
select exam,word,'reviewed-exam-source-union',${q(batch)},array[]::integer[] from proposed_exam_members on conflict do nothing;
-- Execute only after the compatible Worker has been explicitly approved and verified.
update exam_definition_sources set enabled=true where (exam_id,source_book_id) in (('cet6','cet6-xinghuo'),('ielts','ielts-zhenjing'),('ielts','ielts-wanglu-807-listening'));
do $final$ begin ${signatures.map(s=>`if (select md5(coalesce(string_agg(normalized_word,E'\\n' order by normalized_word collate "C"),'')) from exam_book_words where book_id=${q(s.id)}) is distinct from ${q(s.final)} then raise exception 'INCOMPLETE_EXAM_MERGE';end if;`).join('\n')} end $final$;
commit;`;
 const rollback=`begin;delete from exam_book_words bw using commercial_import_admin.exam_source_merge_audit a where a.batch_id=${q(batch)} and bw.book_id=a.exam_id and bw.normalized_word=a.normalized_word and bw.source='reviewed-exam-source-union' and bw.source_version=a.batch_id;update exam_definition_sources set enabled=false;commit;`;
 return {batch,sql,rollback,signatures};
}
