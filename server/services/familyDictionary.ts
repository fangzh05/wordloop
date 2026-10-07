import type {SupabaseClient} from "@supabase/supabase-js";
import type {LexicalDictionaryEntry} from "../../shared/familyContracts.js";
import {getDatabase} from "../db.js";
import {normalizeLemma} from "./familyPolicy.js";
import {FamilyServiceError} from "./familyErrors.js";

export async function getFamilyDictionary(lemma:string,db:SupabaseClient=getDatabase()):Promise<LexicalDictionaryEntry|null> {
  const word=normalizeLemma(lemma);
  if(!word||word.length>120)throw new FamilyServiceError(400,"FAMILY_DICTIONARY_INVALID","词条格式不正确。");
  const result=await db.from("lexical_dictionary_entries")
    .select("entry_id,lemma,language,phonetic,english_definition,chinese_translation,parts_of_speech,source,source_version,license,provenance,confidence")
    .eq("language","en").eq("lemma",word).order("imported_at",{ascending:false}).limit(1).maybeSingle();
  if(result.error)throw new FamilyServiceError(503,"FAMILY_DICTIONARY_UNAVAILABLE","词典释义暂时不可用，请重试。");
  return result.data as LexicalDictionaryEntry|null;
}
