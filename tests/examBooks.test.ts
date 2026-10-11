import {describe,it,expect} from 'vitest';
import {buildExamBooks,sha256,RULE_VERSION} from '../scripts/lib/examBooks.js';
const csv='word,phonetic,definition,translation,pos,tag\r\nApple,,"n. fruit\nfood","n. 苹果",n,"cet4 cet6"\r\napple,,fruit,苹果,n,ielts\r\nother,,x,其他,n,xcet4\r\nexam,,x,考试,n,ky\r\nwell-known,,x,著名,a,toefl\r\nwellknown,,x,著名,a,toefl\r\na b c,,x,异常,n,cet6\r\n';
describe('deterministic exam corpus',()=>{
 it('matches whitespace tags exactly, merges identities, excludes ky and preserves records',()=>{
  const r=buildExamBooks(csv,['apple'],[],false);
  expect(r.report.raw_counts).toEqual({cet4:1,cet6:2,ielts:1,toefl:2});
  expect(r.report.deterministic_duplicates).toBe(1);
  expect(r.relationships.filter(x=>x.normalized_word==='apple')).toHaveLength(3);
  expect(r.additions.some(x=>x.lemma==='apple')).toBe(false);
  expect(r.relationships.some(x=>x.book_id==='kaoyan')).toBe(false);
  expect(r.report.pending).toBe(3);
  expect(r.report.publication_ready).toBe(false);
  expect(buildExamBooks(csv,['apple'],[],false)).toEqual(r);
 });
 it('binds human reviews to input and rules; approval never merges variant identities',()=>{
  const r=buildExamBooks(csv,[],[],false);
  const reviews=r.candidates.map(c=>({key:c.key,input_sha256:sha256(csv),rules:RULE_VERSION,action:c.reason.includes('invalid_format')?'reject' as const:'approve' as const,reviewer:'test-human',reason:'keep spelling identities distinct'}));
  const approved=buildExamBooks(csv,[],reviews,false);
  expect(approved.report.publication_ready).toBe(true);
  expect(approved.additions.map(x=>x.lemma)).toEqual(expect.arrayContaining(['well-known','wellknown']));
  expect(()=>buildExamBooks(csv,[],[{...reviews[0]!,input_sha256:'stale'}],false)).toThrow();
 });
 it('rejects unpinned and malformed sources',()=>{
  expect(()=>buildExamBooks(csv,[])).toThrow('checksum');
  expect(()=>buildExamBooks('word,tag\nx,cet4,extra',[],[],false)).toThrow('Malformed');
 });
});
