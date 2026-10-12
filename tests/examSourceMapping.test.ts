import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {PGlite} from '@electric-sql/pglite';
import {privateBookTestDatabase} from '../scripts/lib/privateBookTestDatabase.js';
import {privateBookImportSql} from '../scripts/lib/privateBookImport.js';
import {planExamSourceMapping,type MappingSnapshot} from '../scripts/lib/examSourceMapping.js';
import {examSourceMergeSql} from '../scripts/lib/examSourceMergeSql.js';
import {sha256} from '../scripts/lib/examBooks.js';
import {examBookId} from '../server/services/examBooks.js';
let db:PGlite;const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002',c='00000000-0000-4000-8000-000000000003';
const v=async(sql:string,args:unknown[]=[]) => (await db.query<any>(sql,args)).rows[0];
beforeAll(async()=>{db=await privateBookTestDatabase(true);await db.exec(readFileSync(new URL('../supabase/migrations/20261012030001_all_account_private_source_entitlements.sql',import.meta.url),'utf8'));await db.exec('grant select,insert on users to service_role');},30000);afterAll(()=>db.close());
beforeEach(async()=>{await db.exec(`begin;insert into users(id) values('${a}'),('${b}');update exam_books set is_public=true,is_available=true,published_at=now(),checksum=repeat('a',64) where id in ('cet4','cet6','kaoyan','ielts','toefl');update exam_definition_sources set enabled=true;`);});afterEach(()=>db.exec('rollback'));
async function seed(book:string){const source={commit:'a'.repeat(40),sha256:'b'.repeat(64),path:'synthetic.json',repo:'fixture'};
 const row={word:'academic',normalized_word:'academic',source_locator:'row:2',source_row:2,entry_key:sha256(JSON.stringify([source.sha256,'row:2','academic'])),senses:[{pos:'adj.',definition_cn:'SYNTHETIC '+book}],definition_raw:'SYNTHETIC '+book,ipa_uk:null,ipa_us:null,chapter:null,category:null};
 await db.exec(privateBookImportSql(book,source,[row],{private_use_attested:true,original_wording_verified:false},true).sql);
 await db.query("insert into exam_book_entitlements(user_id,book_id,rights_evidence,verified_at) values($1,$2,'SYNTHETIC AUTHORIZATION FOR TESTS',now()) on conflict(user_id,book_id) do nothing",[a,book]);
}
async function choose(user:string,book:string){await db.query('select set_exam_book_v1($1,$2)',[user,book]);await db.query('update user_book_preferences set effective_date=current_date where user_id=$1',[user]);}
it('only five targets exist in API/catalog even for licensed accounts; source IDs cannot be activated',async()=>{
 await seed('ielts-zhenjing');expect(examBookId.safeParse('ielts-zhenjing').success).toBe(false);
 await db.query("insert into user_book_preferences(user_id,book_id,effective_date) values($1,'ielts-zhenjing',current_date)",[a]);
 expect((await v('select list_exam_books_v1($1) v',[a])).v.selected_book_id).toBeNull();
 for(const user of [a,b]){const catalog=(await v('select list_exam_books_v1($1) v',[user])).v;expect(catalog.books.map((x:any)=>x.id).sort()).toEqual(['cet4','cet6','ielts','kaoyan','toefl']);expect(JSON.stringify(catalog)).not.toContain('zhenjing');}
 await db.exec('savepoint denied');await expect(db.query("select set_exam_book_v1($1,'ielts-zhenjing')",[a])).rejects.toThrow('unavailable');await db.exec('rollback to savepoint denied');
 await db.exec('savepoint flags');await expect(db.exec("update exam_books set is_available=true where id='ielts-zhenjing'")).rejects.toThrow('internal_sources_not_selectable');await db.exec('rollback to savepoint flags');
});
it('uses licensed exam sources with stable priority and keeps ECDICT and legacy definitions unchanged',async()=>{
 await seed('ielts-zhenjing');await seed('ielts-wanglu-807-listening');await seed('cet6-xinghuo');
 await db.exec("insert into exam_book_words values('ielts','academic','fixture','test','{}'),('cet6','academic','fixture','test','{}');insert into lexical_dictionary_entries(lemma,entry_id,chinese_translation) values('academic','academic','PUBLIC ECDICT');update words set senses='[{\"pos\":\"n.\",\"definition_cn\":\"PROTECTED RED BOOK\"}]';");
 await choose(a,'ielts');const rows=(await v("select current_book_definitions_v1($1,'academic') v",[a])).v;
 expect(rows.map((r:any)=>r.book_id)).toEqual(['ielts-zhenjing','ielts-wanglu-807-listening']);expect(rows[0]).not.toHaveProperty('provenance');
 await choose(a,'cet6');expect((await v("select current_book_definitions_v1($1,'academic') v",[a])).v.map((r:any)=>r.book_id)).toEqual(['cet6-xinghuo']);
 await choose(b,'ielts');expect((await v("select current_book_definitions_v1($1,'academic') v",[b])).v.map((r:any)=>r.book_id)).toEqual(['ielts-zhenjing','ielts-wanglu-807-listening']);
 await db.exec('set local role service_role');await db.query('insert into users(id) values($1)',[c]);await db.exec('reset role');await choose(c,'ielts');expect((await v("select current_book_definitions_v1($1,'academic') v",[c])).v.map((r:any)=>r.book_id)).toEqual(['ielts-zhenjing','ielts-wanglu-807-listening']);
 await db.query('update exam_book_entitlements set expires_at=now()-interval \'1 second\' where user_id=$1',[a]);expect((await v("select current_book_definitions_v1($1,'academic') v",[a])).v).toEqual([]);
 expect((await v('select senses from words')).senses[0].definition_cn).toBe('PROTECTED RED BOOK');expect((await v('select chinese_translation v from lexical_dictionary_entries')).v).toBe('PUBLIC ECDICT');
 for(const role of ['anon','authenticated'])for(const sql of ['select * from exam_definition_sources',`select can_access_private_source_v1('${a}','ielts-zhenjing')`,`select list_exam_books_source_scope_v1('${a}')`]){await db.exec('savepoint denied;set local role '+role);await expect(db.query(sql)).rejects.toThrow('permission denied');await db.exec('rollback to savepoint denied');}
});
it('grants existing accounts when an already imported source is mapped later',async()=>{
 await db.exec("update exam_definition_sources set enabled=false where source_book_id='ielts-zhenjing'");await seed('ielts-zhenjing');
 expect((await v("select can_access_private_source_v1($1,'ielts-zhenjing') v",[b])).v).toBe(false);
 await db.exec("update exam_definition_sources set enabled=true where source_book_id='ielts-zhenjing'");
 expect((await v("select can_access_private_source_v1($1,'ielts-zhenjing') v",[b])).v).toBe(true);
});
it('merges only evidenced memberships idempotently and preserves shared FSRS state',async()=>{
 await seed('cet6-xinghuo');
 const snapshot:MappingSnapshot={mode:'read-only',members:[],sources:[{book_id:'cet6-xinghuo',normalized_word:'academic',definitions:1,missing:0}],dictionary_words:['academic'],protected:{},definition_hashes:[]};
 const plan=planExamSourceMapping(snapshot,new Map([['academic',new Set(['ky'])]]));expect(plan.additions.map(a=>a.exam)).toEqual(['cet6','kaoyan']);
 const prepared=examSourceMergeSql(snapshot,plan);
 // Replaying the guarded transaction is isolated from each test's outer transaction.
 const inner=prepared.sql.replace(/^begin;/,'').replace(/commit;$/,'');await db.exec(inner);await db.exec('drop table proposed_exam_members');await db.exec(inner);
 expect((await v("select count(*) n from exam_book_words where book_id in ('cet6','kaoyan')")).n).toBe(2);
 await choose(a,'cet6');await db.query('select prepare_exam_pool_v1($1,current_date,2)',[a]);
 expect((await v('select count(*) n from user_words')).n).toBe(1);
 await db.query("insert into word_sources(user_id,word_id,source_type,source_book_id) select $1,id,'fixture',x from words cross join unnest(array['ougkp','athgc']) x",[a]);
 await db.exec('update user_words set correct_count=7,fsrs_stability=3');const history=await v('select to_jsonb(u) v from user_words u');
 await choose(a,'kaoyan');await db.query('select prepare_exam_pool_v1($1,current_date+1,2)',[a]);expect(await v('select to_jsonb(u) v from user_words u')).toEqual(history);expect((await v('select count(*) n from fsrs_review_logs')).n).toBe(0);
 expect((await v('select list_exam_books_v1($1) v',[a])).v.books.find((x:any)=>x.id==='kaoyan').total).toBe(1);
});
it('does not assign IELTS or CET6 vocabulary to CET4/Kaoyan without exact independent tags',()=>{
 const snapshot:MappingSnapshot={mode:'read-only',members:[],sources:[{book_id:'ielts-zhenjing',normalized_word:'atmosphere',definitions:1,missing:0}],dictionary_words:[],protected:{},definition_hashes:[]};
 expect(planExamSourceMapping(snapshot,new Map()).additions.map(a=>a.exam)).toEqual(['ielts']);
 expect(planExamSourceMapping(snapshot,new Map([['atmosphere',new Set(['xcet4','sky'])]])).additions.map(a=>a.exam)).toEqual(['ielts']);
 expect(planExamSourceMapping({...snapshot,sources:[{...snapshot.sources[0]!,missing:1}]},new Map()).additions).toEqual([]);
});
it('keeps private-only Kaoyan entries in scope and enrolls independently evidenced additions',async()=>{
 await db.exec("insert into words(normalized_word,display_word,senses) values('legacy','legacy','[{\"pos\":\"n.\",\"definition_cn\":\"PROTECTED PRIVATE KAОYAN\"}]'),('academic','academic','[]');insert into exam_book_words values('kaoyan','academic','ECDICT','fixture','{}');insert into lexical_dictionary_entries(entry_id,lemma,chinese_translation) values('academic','academic','PUBLIC ECDICT');");
 await db.query("insert into word_sources(user_id,word_id,source_type,source_book_id) select $1,id,'fixture',x from words cross join unnest(array['ougkp','athgc'])x where normalized_word='legacy'",[a]);
 await db.query("insert into user_words(user_id,word_id,source,correct_count,fsrs_stability) select $1,id,'shanbay',7,3 from words where normalized_word='legacy'",[a]);
 const original=await v("select to_jsonb(u) v from user_words u");await choose(a,'kaoyan');await db.query('select prepare_exam_pool_v1($1,current_date,2)',[a]);
 expect((await v('select count(*) n from user_words')).n).toBe(2);expect(await v("select to_jsonb(u) v from user_words u join words w on w.id=u.word_id where w.normalized_word='legacy'")).toEqual(original);
 expect((await v('select list_exam_books_v1($1) v',[a])).v.books.find((x:any)=>x.id==='kaoyan').total).toBe(2);
 expect((await v("select exam_word_in_scope_v1($1,current_date,(select id from words where normalized_word='legacy')) ok",[a])).ok).toBe(true);
 expect((await v('select count(*) n from fsrs_review_logs')).n).toBe(0);
});
it('matches PostgreSQL C collation for Unicode and deduplicates snapshot memberships',async()=>{
 const words=['é','𐐨','中'];for(const word of words)await db.query("insert into exam_book_words values('cet4',$1,'fixture','test','{}')",[word]);
 const members=[...words,...words].map(normalized_word=>({book_id:'cet4',normalized_word}));
 const snapshot:MappingSnapshot={mode:'read-only',members,sources:[],dictionary_words:[],protected:{},definition_hashes:[]};
 const plan=planExamSourceMapping(snapshot,new Map());expect(plan.books.find(b=>b.id==='cet4')?.old).toBe(3);
 await db.exec(examSourceMergeSql(snapshot,plan).sql.replace(/^begin;/,'').replace(/commit;$/,''));
 expect((await v("select count(*) n from exam_book_words where book_id='cet4'")).n).toBe(3);
});
