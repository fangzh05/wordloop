import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {getAuthenticatedUserId,shouldExposeStagingDiagnostics} from '../db.js';
import {normalizeWord} from './wordNormalization.js';
import {getFamilyDictionary} from './familyDictionary.js';
const sourceSchema=z.object({book_id:z.string(),entry_key:z.string(),definition_raw:z.string(),senses:z.array(z.object({pos:z.string(),definition_cn:z.string(),definition_en:z.string().nullable().optional()})),
 ipa_us:z.string().nullable(),ipa_uk:z.string().nullable(),chapter:z.string().nullable(),category:z.string().nullable(),is_ai_generated:z.boolean(),
 third_party_processing_allowed:z.boolean()});
export type SourceDefinition=z.infer<typeof sourceSchema>;
export class PrivateBookAccessError extends Error {readonly status=403;readonly code='PRIVATE_BOOK_ACCESS_REVOKED';constructor(){super('PRIVATE_BOOK_ACCESS_REVOKED');}}
function safeDiagnosticMessage(value:unknown):string{
 return String(value??'unknown error').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[token]').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]').replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi,'[id]').replace(/https?:\/\/[^\s"'()]+/gi,'[url]').replace(/[\r\n\t]+/g,' ').slice(0,180);
}
export function privateSourceIds(value:unknown):string[]{
 const ids=new Set<string>();
 const collect=(v:unknown):void=>{if(!v||typeof v!=='object')return;const obj=v as Record<string,unknown>;
  if(obj.private===true&&typeof obj.book_id==='string')ids.add(obj.book_id);
  if(typeof obj.definition_raw==='string'&&typeof obj.book_id==='string')ids.add(obj.book_id);
  for(const[k,child]of Object.entries(v)){if(k==='private_source_book_id'&&typeof child==='string')ids.add(child);else if(child&&typeof child==='object')collect(child);}};
 collect(value);return [...ids];
}
export async function assertPrivateSourceAccess(value:unknown,db:SupabaseClient,userId:string):Promise<void>{
 for(const id of privateSourceIds(value)){const r=await db.rpc('can_access_private_source_v1',{p_user_id:userId,p_book_id:id});if(r.error||r.data!==true)throw new PrivateBookAccessError();}
}
export async function currentBookDefinitions(word:string,db:SupabaseClient,userId=getAuthenticatedUserId()):Promise<SourceDefinition[]> {
 const result=await db.rpc('current_book_definitions_v1',{p_user_id:userId,p_word:normalizeWord(word)});
 // Rolling migration compatibility. Missing RPC contains no private data.
 if(result.error?.code==='PGRST202')return [];
 if(result.error){if(shouldExposeStagingDiagnostics(userId))console.error('WordLoop staging source definitions RPC failed',{code:result.error.code??null,message:safeDiagnosticMessage(result.error.message)});throw Error('来源释义暂时不可用。');}
 const parsed=z.array(sourceSchema).safeParse(result.data??[]);if(!parsed.success){if(shouldExposeStagingDiagnostics(userId))console.error('WordLoop staging source definitions response invalid',{issue_count:parsed.error.issues.length});throw Error('来源释义暂时不可用。');}return parsed.data;
}
export async function sourceDictionaryDetail(word:string,db:SupabaseClient,userId=getAuthenticatedUserId()){
 const [current,dictionary]=await Promise.all([currentBookDefinitions(word,db,userId),getFamilyDictionary(word,db)]);
 const senses=(Array.isArray(dictionary?.parts_of_speech)?dictionary.parts_of_speech:[]).filter(s=>s.definition_zh).map(s=>({pos:s.label,definition_cn:s.definition_zh!}))??[];
 if(!senses.length&&dictionary?.chinese_translation)senses.push({pos:'',definition_cn:dictionary.chinese_translation});
 return {current_book_definitions:current,dictionary_senses:senses};
}
