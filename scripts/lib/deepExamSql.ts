import {createHash} from 'node:crypto';
import {sha256} from './examBooks.js';
import {prepareDeepImport,type DeepSnapshot} from './deepExamImport.js';
const q=(v:string)=>"'"+v.replaceAll("'","''")+"'";
const signature=(words:string[])=>createHash('md5').update([...new Set(words)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).join('\n')).digest('hex');
export function deepExamSql(snapshot:DeepSnapshot,plan:ReturnType<typeof prepareDeepImport>){
 if(plan.additions.some(a=>!['ielts','toefl'].includes(a.exam)))throw Error('Out of scope membership');
 const batch=sha256(JSON.stringify({rules:plan.rules,additions:plan.additions}));
 const guards=plan.metrics.map(m=>{const old=snapshot.members.filter(x=>x.book_id===m.exam).map(x=>x.normalized_word),after=[...old,...plan.additions.filter(x=>x.exam===m.exam).map(x=>x.word)];return {exam:m.exam,old:signature(old),after:signature(after)};});
 const check=(id:string)=>`(select md5(coalesce(string_agg(normalized_word,E'\\n' order by normalized_word collate "C"),'')) from exam_book_words where book_id=${q(id)})`;
 const sql=`begin;
set local standard_conforming_strings=on;
select pg_advisory_xact_lock(hashtextextended('ielts-toefl-deep-import',483));
lock table exam_book_words in share row exclusive mode;
do $guard$ begin ${guards.map(g=>`if ${check(g.exam)} not in (${q(g.old)},${q(g.after)}) then raise exception 'DEEP_MEMBERSHIP_BASELINE_DRIFT';end if;`).join('\n')} end $guard$;
create table if not exists commercial_import_admin.deep_exam_merge_audit(batch_id text not null,exam_id text not null,normalized_word text not null,evidence jsonb not null,primary key(batch_id,exam_id,normalized_word));
alter table commercial_import_admin.deep_exam_merge_audit enable row level security;
revoke all on commercial_import_admin.deep_exam_merge_audit from public,anon,authenticated;
grant all on commercial_import_admin.deep_exam_merge_audit to service_role;
create temporary table deep_exam_proposed on commit drop as select * from jsonb_to_recordset(${q(JSON.stringify(plan.additions))}::jsonb) as r(exam text,word text,sources jsonb);
do $identity$ begin
if exists(select 1 from deep_exam_proposed where exam not in ('ielts','toefl')) then raise exception 'DEEP_EXAM_SCOPE';end if;
if exists(select 1 from deep_exam_proposed p join exam_book_words b on b.book_id=p.exam and b.normalized_word=p.word where b.source<>'reviewed-deep-exam-union' or b.source_version<>${q(batch)}) then raise exception 'DEEP_BATCH_OWNERSHIP_DRIFT';end if;
if exists(select 1 from deep_exam_proposed p where not exists(select 1 from words w where w.normalized_word=p.word) or not exists(select 1 from word_source_definitions s where s.normalized_word=p.word and p.sources ? s.book_id)) then raise exception 'DEEP_SOURCE_IDENTITY_MISSING';end if;end $identity$;
insert into commercial_import_admin.deep_exam_merge_audit select ${q(batch)},exam,word,jsonb_build_object('sources',sources) from deep_exam_proposed on conflict do nothing;
insert into exam_book_words(book_id,normalized_word,source,source_version,source_records) select exam,word,'reviewed-deep-exam-union',${q(batch)},array[]::integer[] from deep_exam_proposed on conflict do nothing;
-- This activation is part of the explicitly reviewed release, never run by download/dry-run.
do $final$ begin ${guards.map(g=>`if ${check(g.exam)} is distinct from ${q(g.after)} then raise exception 'DEEP_MEMBERSHIP_FINAL_MISMATCH';end if;`).join('\n')} end $final$;
commit;`;
 // Keep original source payloads and identities. Remove only this batch's memberships.
 const rollback=`begin;delete from exam_book_words b using commercial_import_admin.deep_exam_merge_audit a where a.batch_id=${q(batch)} and b.book_id=a.exam_id and b.normalized_word=a.normalized_word and b.source='reviewed-deep-exam-union' and b.source_version=a.batch_id;commit;`;
 return {batch,sql,rollback};
}
