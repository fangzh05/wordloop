import {z} from 'zod';
import {normalizeWord,wordInputSchema} from '../../server/services/wordNormalization.js';
import {sha256} from './examBooks.js';
const bookSchema=z.enum(['ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo','ielts-xindongfang','ielts-youdao','ielts-youdao-luan','ielts-niannian','ielts-leiji','ielts-jianqiao','toefl-youdao','toefl-gaopin','toefl-kyle-expanded']);
export const privateImportRow=z.object({word:z.string(),normalized_word:z.string(),entry_key:z.string().length(64),source_row:z.number().int().positive(),requires_human_review:z.boolean().default(false),
 senses:z.array(z.object({pos:z.string(),definition_cn:z.string()}).passthrough()).min(1),definition_raw:z.string().min(1),source_locator:z.string().optional(),sheet:z.string().optional(),
 ipa_uk:z.string().nullable(),ipa_us:z.string().nullable(),chapter:z.string().nullable(),category:z.string().nullable(),logical_group:z.number().optional()}).passthrough();
const q=(value:unknown)=>value===null||value===undefined?'null':"E'"+String(value).replaceAll('\\','\\\\').replaceAll("'","''")+"'";
export function privateBookImportSql(id:string,source:{commit:string;sha256:string;path:string;repo:string},input:unknown,review:{private_use_attested:boolean;original_wording_verified:boolean;private_use_evidence_sha256?:string},testOnly:boolean){
 bookSchema.parse(id);if(!testOnly)throw Error('Only isolated test imports are enabled. Production requires a separate reviewed release.');
 if(!review.private_use_attested)throw Error('Private-use attestation required');
 z.string().regex(/^[a-f0-9]{40}$/).parse(source.commit);z.string().regex(/^[a-f0-9]{64}$/).parse(source.sha256);
 for(const field of [source.repo,source.path])z.string().min(1).regex(/^[^\u0000-\u001f]+$/u).parse(field);
 const all=z.array(privateImportRow).parse(input);
 if(all.some(r=>JSON.stringify(r).includes('\\u0000')))throw Error('Unsupported NUL in private source payload');
 const rows=all.filter(r=>wordInputSchema.safeParse(r.word).success&&!r.requires_human_review);
 if(rows.some(r=>normalizeWord(r.word)!==r.normalized_word))throw Error('Normalization mismatch');
 if(new Set(all.map(r=>r.entry_key)).size!==all.length)throw Error('Duplicate source entry keys');
 if(all.some(r=>r.entry_key!==sha256(JSON.stringify([source.sha256,r.source_locator??`${r.sheet}:${r.source_row}`,r.word]))))throw Error('Source entry identity mismatch');
 const contentHash=(row:z.infer<typeof privateImportRow>)=>sha256(JSON.stringify({word:row.normalized_word,senses:row.senses,definition_raw:row.definition_raw,source_row:row.source_row,source_locator:row.source_locator??`${row.sheet??"row"}:${row.source_row}`,ipa_uk:row.ipa_uk,ipa_us:row.ipa_us,chapter:row.chapter,category:row.category,logical_group:row.logical_group??null,...(row.source_details?{source_details:row.source_details}:{})}));
 const batch=sha256(JSON.stringify({id,source:{repo:source.repo,path:source.path,commit:source.commit,sha256:source.sha256},rows:rows.map(r=>[r.entry_key,contentHash(r)]).sort((a,b)=>a[0]!<b[0]!?-1:a[0]!>b[0]!?1:0)}));
 const statements=[`insert into source_definition_batches(id,book_id,source_commit,source_sha256,record_count) values(${q(batch)},${q(id)},${q(source.commit)},${q(source.sha256)},${rows.length}) on conflict do nothing;`];
 for(const row of rows){
  const provenance={repo:source.repo,path:source.path,commit:source.commit,sha256:source.sha256,original_wording_verified:review.original_wording_verified,private_use_attested:true,...(row.source_details?{source_details:row.source_details}:{}),private_use_evidence_sha256:review.private_use_evidence_sha256??null};
  statements.push(`do $drift$ begin if exists(select 1 from word_source_definitions where book_id=${q(id)} and entry_key=${q(row.entry_key)} and content_hash<>${q(contentHash(row))}) then raise exception 'IMMUTABLE_SOURCE_DRIFT';end if;end $drift$;
insert into words(normalized_word,display_word) values(${q(row.normalized_word)},${q(row.word)}) on conflict(normalized_word) do nothing;
insert into exam_book_words(book_id,normalized_word,source,source_version,source_records) values(${q(id)},${q(row.normalized_word)},${q(source.repo)},${q(source.commit)},array[${row.source_row}]) on conflict(book_id,normalized_word) do update set source_records=(select array_agg(distinct n order by n) from unnest(exam_book_words.source_records||excluded.source_records)n);
insert into word_source_definitions(book_id,entry_key,normalized_word,batch_id,source_row,source_locator,content_hash,senses,definition_raw,ipa_uk,ipa_us,chapter,category,logical_group,provenance)
values(${q(id)},${q(row.entry_key)},${q(row.normalized_word)},${q(batch)},${row.source_row},${q(row.source_locator??`${row.sheet??"row"}:${row.source_row}`)},${q(contentHash(row))},${q(JSON.stringify(row.senses))}::jsonb,${q(row.definition_raw)},${q(row.ipa_uk)},${q(row.ipa_us)},${q(row.chapter)},${q(row.category)},${q(row.logical_group)},${q(JSON.stringify(provenance))}::jsonb) on conflict do nothing;`);
 }
 const transferRows=rows.map(row=>({word:row.word,normalized_word:row.normalized_word,entry_key:row.entry_key,source_row:row.source_row,
  source_locator:row.source_locator??`${row.sheet??"row"}:${row.source_row}`,content_hash:contentHash(row),senses:row.senses,definition_raw:row.definition_raw,
  ipa_uk:row.ipa_uk,ipa_us:row.ipa_us,chapter:row.chapter,category:row.category,logical_group:row.logical_group??null,
  provenance:{repo:source.repo,path:source.path,commit:source.commit,sha256:source.sha256,original_wording_verified:review.original_wording_verified,private_use_attested:true,...(row.source_details?{source_details:row.source_details}:{}),private_use_evidence_sha256:review.private_use_evidence_sha256??null}}));
 const quarantine=all.filter(r=>!wordInputSchema.safeParse(r.word).success||r.requires_human_review).map(r=>({entry_key:r.entry_key,source_row:r.source_row,reason:r.requires_human_review?'model_candidate_requires_human_review':'invalid_format',record:r}));
 return {quarantine,batch,batch_statement:statements[0]!,sql:statements.join('\n'),transaction_sql:'begin;set local standard_conforming_strings=on;\n'+statements.join('\n')+'\ncommit;',accepted:rows.length,quarantined:all.length-rows.length,transferRows};
}
