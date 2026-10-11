import type {SupabaseClient} from '@supabase/supabase-js';
import {getFamilyDictionary} from './familyDictionary.js';
import type {VocabularyItem} from '../types.js';
import {getAuthenticatedUserId} from '../db.js';
import {currentBookDefinitions} from './sourceDictionary.js';
// Global words can contain the owner's private commercial gloss. A newly
// enrolled public-book card must never inherit that gloss or private IPA.
export async function publicExamLexical(word:string,db:SupabaseClient) {
 const entry=await getFamilyDictionary(word,db);
 const senses=(Array.isArray(entry?.parts_of_speech)?entry.parts_of_speech:[]).filter(g=>g.definition_zh).map(g=>({pos:g.label,definition_cn:g.definition_zh!}))??[];
 if(!senses.length&&entry?.chinese_translation)senses.push({pos:'',definition_cn:entry.chinese_translation});
 return {ipa_us:entry?.phonetic??null,ipa_uk:null,senses};
}
export async function hydrateExamCards(items:VocabularyItem[],db:SupabaseClient,userId=getAuthenticatedUserId(),includePrivate=true):Promise<VocabularyItem[]> {
 return Promise.all(items.map(async item=>{
  const safe=item.source==='exam_book'?{...item,...await publicExamLexical(item.word,db)}:item;
  const rows=includePrivate?await currentBookDefinitions(item.word,db,userId):[];
  const defined=rows.filter(r=>r.senses.some(s=>s.definition_cn.trim()));
  if(!defined.length)return safe;
  return {...safe,senses:defined.flatMap(r=>r.senses),ipa_us:defined.find(r=>r.ipa_us)?.ipa_us??safe.ipa_us,
   ipa_uk:defined.find(r=>r.ipa_uk)?.ipa_uk??safe.ipa_uk,
   definition_source:{book_id:defined[0]!.book_id,entry_keys:defined.map(r=>r.entry_key),private:true as const,third_party_processing_allowed:defined.every(r=>r.third_party_processing_allowed)}};
 }));
}
