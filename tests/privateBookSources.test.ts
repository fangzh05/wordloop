import {isOutsideCheckout} from '../scripts/lib/privateDataPath.js';
import {resolve} from 'node:path';
import {it,expect,vi} from 'vitest';
import {parseStaticData} from '../scripts/lib/staticData.js';
import {planLessonRound,cadenceCandidatePlans} from '../server/services/exercisePlanner.js';
import {privateBookLesson} from '../server/services/privateBookLesson.js';
import {generateLesson,gradeEnglishDefinition,containsPrivateSource} from '../server/services/deepseek.js';
import {hydrateExamCards} from '../server/services/examCardDictionary.js';
import {assertPrivateSourceAccess} from '../server/services/sourceDictionary.js';
import {privateBookImportSql} from '../scripts/lib/privateBookImport.js';
import type {VocabularyItem} from '../server/types.js';
import type {SupabaseClient} from '@supabase/supabase-js';
const user='00000000-0000-4000-8000-000000000001';
const source={book_id:'ielts-zhenjing',entry_keys:['entry-1'],private:true as const,third_party_processing_allowed:false};
it('reads TS/JS literals without executing code and rejects expressions',()=>{
 expect(parseStaticData("export const data = {word: 'fixture', senses: [{pos: 'n.', definition: '示例'}]} as const")).toEqual({word:'fixture',senses:[{pos:'n.',definition:'示例'}]});
 expect(()=>parseStaticData('const data = fetch("https://example.org")')).toThrow('Non-literal');
 expect(()=>parseStaticData('const data = {get word(){return "x"}}')).toThrow('Executable');
});
it('uses a frozen private target with existing deterministic planner/BKT and makes no model request',async()=>{
 const [plan]=planLessonRound({words:[{word_id:user,word:'fixture',target_sense:'原义项（测试）',part_of_speech:'n.',lesson_profile:'reinforce',error_focus:null,private_source:source}]});
 expect(plan!.planned_activity_type).toBe('word_recall');expect(cadenceCandidatePlans(plan!,'fixture')).toEqual({});
 const network=vi.spyOn(globalThis,'fetch');
 try{
  const lesson=await generateLesson({word:'fixture',meaning_zh:'切换后的其他义项',part_of_speech:'n.',lesson_profile:'reinforce',error_focus:null,plan:plan!});
  expect(lesson.meaning_zh).toBe('原义项（测试）');expect(lesson.exercise.accepted_answers).toEqual(['fixture']);expect(network).not.toHaveBeenCalled();
  expect(privateBookLesson('fixture',plan!,'n.','—')).toEqual(lesson);
 }finally{network.mockRestore();}
});
it('prefers authorized source senses on an existing card and falls back to ECDICT when source text is missing',async()=>{
 const item={word:'fixture',source:'exam_book',senses:[],ipa_us:null} as unknown as VocabularyItem;
 const query:any={select:()=>query,eq:()=>query,order:()=>query,limit:()=>query,maybeSingle:async()=>({data:{phonetic:null,parts_of_speech:[{label:'n.',definition_zh:'PUBLIC DICTIONARY'}]},error:null})};
 const definition={book_id:source.book_id,entry_key:'entry-1',definition_raw:'PRIVATE TEST',senses:[{pos:'n.',definition_cn:'PRIVATE TEST'}],ipa_us:null,ipa_uk:null,chapter:'test',category:null,is_ai_generated:false,third_party_processing_allowed:false};
 const rpc=vi.fn(async()=>({data:[definition],error:null}));const db={from:()=>query,rpc} as unknown as SupabaseClient;
 expect((await hydrateExamCards([item],db,user))[0]?.senses?.[0]?.definition_cn).toBe('PRIVATE TEST');
 definition.senses=[];expect((await hydrateExamCards([item],db,user))[0]?.senses?.[0]?.definition_cn).toBe('PUBLIC DICTIONARY');
 expect(rpc).toHaveBeenCalledWith('current_book_definitions_v1',{p_user_id:user,p_word:'fixture'});
});
it('denies revoked frozen sessions before exposing stored source definitions',async()=>{
 const db={rpc:async()=>({data:false,error:null})} as unknown as SupabaseClient;
 await expect(assertPrivateSourceAccess({payload:{plan:{private_source_book_id:source.book_id}}},db,user)).rejects.toThrow('ACCESS_REVOKED');
});
it('has no executable production importer',()=>{
 expect(()=>privateBookImportSql('ielts-zhenjing',{commit:'a'.repeat(40),sha256:'b'.repeat(64),path:'test',repo:'test'},[],{private_use_attested:true,original_wording_verified:false},false)).toThrow('Only isolated test imports');
});


it('blocks explicit private review grading before any network request',async()=>{
 const network=vi.spyOn(globalThis,'fetch');try{
 expect(containsPrivateSource({nested:[{private:true,book_id:'ielts-zhenjing'}]})).toBe(true);
 await expect(gradeEnglishDefinition({word:'fixture',meaning_zh:'SYNTHETIC PRIVATE',answer:'example',private_source_book_id:'ielts-zhenjing'})).rejects.toThrow('Private source');
 expect(network).not.toHaveBeenCalled();
 }finally{network.mockRestore();}
});

it('rejects checkout directories whose names start with two dots',()=>{
 const checkout=process.cwd();expect(isOutsideCheckout(checkout,resolve(checkout,'..private'))).toBe(false);
 expect(isOutsideCheckout(checkout,checkout)).toBe(false);expect(isOutsideCheckout(checkout,resolve(checkout,'..','private-data'))).toBe(true);
});
