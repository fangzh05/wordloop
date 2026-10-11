import {it,expect} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {vocabularyItemFromRpc,type RpcVocabularyRow} from '../server/services/words.js';
import {hydrateExamCards} from '../server/services/examCardDictionary.js';
it('fails closed before hydration and only exposes public dictionary glosses on public cards',async()=>{
 const row={word:'apple',source:'exam_book',senses:[{pos:'n.',definition_cn:'PRIVATE COMMERCIAL'}],ipa_us:'PRIVATE IPA'} as RpcVocabularyRow;
 const item=vocabularyItemFromRpc(row);expect(item.senses).toEqual([]);expect(item.ipa_us).toBeNull();
 const query:any={select:()=>query,eq:()=>query,order:()=>query,limit:()=>query,maybeSingle:async()=>({data:{parts_of_speech:[{label:'n.',definition_zh:'PUBLIC ECDICT'}]},error:null})};
 const [safe]=await hydrateExamCards([item],{from:()=>query} as unknown as SupabaseClient);
 expect(JSON.stringify(safe)).not.toContain('PRIVATE');expect(safe!.senses![0]!.definition_cn).toBe('PUBLIC ECDICT');
 const owner=vocabularyItemFromRpc({...row,source:'shanbay'});expect(owner.senses).toEqual(row.senses);expect(owner.ipa_us).toBe('PRIVATE IPA');
});
