import {afterAll,beforeAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {PGlite} from '@electric-sql/pglite';
import {privateBookTestDatabase} from '../scripts/lib/privateBookTestDatabase.js';
import {privateBookImportSql} from '../scripts/lib/privateBookImport.js';
import {prepareDeepImport,type DeepBook,type DeepSnapshot} from '../scripts/lib/deepExamImport.js';
import {deepExamSql} from '../scripts/lib/deepExamSql.js';
import {sha256} from '../scripts/lib/examBooks.js';
const snapshot:DeepSnapshot={mode:'read-only',words:[],dictionary_words:['economic','economical','organise','organize'],members:[]};
function book(repo:string,words:string[],exam:'ielts'|'toefl'='toefl'):DeepBook{return {name:'synthetic',exam,source:{repo,commit:'a'.repeat(40),sha256:'b'.repeat(64),path:'fixture.jsonl'},records:words.map((word,i)=>({word,source_row:i+1,definition_raw:'SYNTHETIC ONLY',senses:[{pos:'n.',definition_cn:'SYNTHETIC ONLY',definition_en:'test original English'}],ipa_uk:null,ipa_us:null,chapter:null,category:null}))};}
it('does not promote inherited sources even when a caller omits the derived flag, or merge distinct spellings',()=>{
 const plan=prepareDeepImport({'toefl-youdao':book('KyleBing/dict',['ecliptic','economic','economical','organise','organize']),'toefl-kyle-expanded':book('KyleBing/english-vocabulary',['ecliptic','advancedword'])},snapshot);
 expect(plan.additions.map(a=>a.word).sort()).toEqual(['economic','economical','organise','organize']);
 expect(plan.held.filter(h=>h.word==='ecliptic')).toHaveLength(2);
 expect(plan.accepted['toefl-kyle-expanded']).toEqual([]);
 expect(()=>deepExamSql(snapshot,{...plan,additions:[{exam:'cet6',word:'economic',sources:[]}]})).toThrow('Out of scope');
 expect(deepExamSql(snapshot,plan).sql).not.toContain('set enabled=true');
});
it('stores identical alphabetical/random meanings once and keeps alternate provenance and genuinely different senses',()=>{
 const a=book('KyleBing/dict',['economic','economical'],'ielts'),b=book('KyleBing/dict',['economic','economical'],'ielts');
 b.records[1]!.definition_raw='DIFFERENT ORIGINAL';b.records[1]!.senses[0]!.definition_cn='DIFFERENT ORIGINAL';
 const plan=prepareDeepImport({'ielts-youdao':a,'ielts-youdao-luan':b},snapshot);
 expect(plan.deduped_edition_records).toBe(1);expect(plan.accepted['ielts-youdao-luan']).toHaveLength(1);
 expect(plan.accepted['ielts-youdao']![0]!.source_details).toHaveProperty('alternate_edition');
 expect(plan.additions).toHaveLength(2);
});
let db:PGlite;
beforeAll(async()=>{db=await privateBookTestDatabase(true);await db.exec(readFileSync(new URL('../supabase/migrations/20261012030000_deep_exam_internal_sources.sql',import.meta.url),'utf8'));},30000);
afterAll(()=>db.close());
it('keeps new English senses and original metadata private; retries insert zero, and source drift aborts',async()=>{
 const b=book('KyleBing/dict',['economic']);const raw=b.records[0]!;const locator='line:1';
 const row={...raw,normalized_word:'economic',source_locator:locator,entry_key:sha256(JSON.stringify([b.source.sha256,locator,raw.word])),source_details:{phrases:[{phrase:'synthetic phrase'}],source_version:'synthetic'}};
 const p=privateBookImportSql('toefl-youdao',b.source,[row],{private_use_attested:true,original_wording_verified:false},true);
 await db.exec(p.sql.slice(0,p.sql.indexOf(';')+1));
 for(const expected of [1,0])expect((await db.query<{n:number}>('select commercial_import_admin.import_rows_v1($1,$2,$3::jsonb)n',['toefl-youdao',p.batch,JSON.stringify(p.transferRows)])).rows[0]!.n).toBe(expected);
 const stored=(await db.query<any>('select senses,provenance from word_source_definitions')).rows[0];expect(stored.senses[0].definition_en).toBe('test original English');expect(stored.provenance.source_details.phrases).toHaveLength(1);
 const w=(await db.query<any>('select senses from words')).rows[0];expect(w.senses).toEqual([]);
 const changed=privateBookImportSql('toefl-youdao',b.source,[{...row,source_details:{phrases:[]}}],{private_use_attested:true,original_wording_verified:false},true);
 await db.exec(changed.sql.slice(0,changed.sql.indexOf(';')+1));await expect(db.query('select commercial_import_admin.import_rows_v1($1,$2,$3::jsonb)',['toefl-youdao',changed.batch,JSON.stringify(changed.transferRows)])).rejects.toThrow('IMMUTABLE_SOURCE_DRIFT');
 for(const role of ['anon','authenticated']){await db.exec('begin;set local role '+role);await expect(db.query('select * from word_source_definitions')).rejects.toThrow('permission denied');await db.exec('rollback');}
});
it('new internal sources stay out of catalog; authorized definitions expire without changing a shared FSRS card',async()=>{
 const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
 await db.exec(`insert into users(id) values('${a}'),('${b}');update exam_books set is_public=true,is_available=true,published_at=now(),checksum=repeat('a',64) where id in ('cet4','cet6','kaoyan','ielts','toefl');update exam_books set source='fixture' where id='toefl-youdao';update exam_definition_sources set enabled=true where source_book_id='toefl-youdao';insert into exam_book_words values('toefl','economic','fixture','test','{}');insert into user_words(user_id,word_id,fsrs_stability,mastered) select '${a}',id,9,true from words where normalized_word='economic';`);
 await db.query("insert into exam_book_entitlements(user_id,book_id,rights_evidence,verified_at) values($1,'toefl-youdao','SYNTHETIC ISOLATED TEST GRANT',now())",[a]);
 for(const uid of [a,b]){await db.query("select set_exam_book_v1($1,'toefl')",[uid]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[uid]);const catalog=(await db.query<any>('select list_exam_books_v1($1)v',[uid])).rows[0].v;expect(catalog.books).toHaveLength(5);expect(JSON.stringify(catalog)).not.toContain('youdao');}
 expect((await db.query<any>("select current_book_definitions_v1($1,'economic')v",[a])).rows[0].v).toHaveLength(1);
 expect((await db.query<any>("select current_book_definitions_v1($1,'economic')v",[b])).rows[0].v).toEqual([]);
 await db.query('update exam_book_entitlements set expires_at=now()-interval \'1 second\' where user_id=$1',[a]);
 expect((await db.query<any>("select current_book_definitions_v1($1,'economic')v",[a])).rows[0].v).toEqual([]);
 await db.query("select set_exam_book_v1($1,'ielts')",[a]);const card=(await db.query<any>('select fsrs_stability,mastered from user_words where user_id=$1',[a])).rows;expect(card).toEqual([{fsrs_stability:9,mastered:true}]);
});
it('standalone SQL handles a missing logical group and backslashes safely with SCS disabled',async()=>{
 const b=book('KyleBing/dict',['organise']);const word=b.records[0]!;const locator='line:1';
 const row={...word,normalized_word:word.word,source_locator:locator,entry_key:sha256(JSON.stringify([b.source.sha256,locator,word.word])),definition_raw:"SYNTHETIC apostrophe ' and trailing slash \\"};
 const p=privateBookImportSql('ielts-xindongfang',b.source,[row],{private_use_attested:true,original_wording_verified:false},true);
 await db.exec('set standard_conforming_strings=off');await db.exec(p.sql);await db.exec('set standard_conforming_strings=on');
 expect((await db.query<any>("select definition_raw,logical_group from word_source_definitions where book_id='ielts-xindongfang'")).rows[0]).toEqual({definition_raw:row.definition_raw,logical_group:null});
});
