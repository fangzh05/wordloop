import type {SupabaseClient} from '@supabase/supabase-js';
import {getFamilyDictionary} from './familyDictionary.js';
import type {VocabularyItem} from '../types.js';
// Global words can contain the owner's private commercial gloss. A newly
// enrolled public-book card must never inherit that gloss or private IPA.
export async function publicExamLexical(word:string,db:SupabaseClient) {
 const entry=await getFamilyDictionary(word,db);
 return {ipa_us:null,ipa_uk:null,senses:entry?.parts_of_speech.filter(g=>g.definition_zh).map(g=>({pos:g.label,definition_cn:g.definition_zh!}))??[]};
}
export async function hydrateExamCards(items:VocabularyItem[],db:SupabaseClient):Promise<VocabularyItem[]> {
 return Promise.all(items.map(async item=>item.source==='exam_book'?{...item,...await publicExamLexical(item.word,db)}:item));
}
