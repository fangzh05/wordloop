import { readFileSync, writeFileSync } from "node:fs";
import { lexicalInsertSql } from "./lib/familyImportSql.js";
import { lexemeId } from "../server/services/familyPolicy.js";
const [path,output]=process.argv.slice(2);
if(!path||!output)throw new Error("Usage: import-lexical-corpus CORPUS_JSON OUTPUT_SQL (review, then apply in admin environment)");
const corpus=JSON.parse(readFileSync(path,"utf8"));
for(const l of corpus.lexemes??[])if(l.lexeme_id!==lexemeId(l.lemma,l.part_of_speech))throw new Error("Non-canonical lexeme ID");
for(const key of ["senses","forms","etymons","etymological_links","sense_relations","usage_patterns","lexeme_morphemes","spelling_variants"])
 for(const r of corpus[key]??[])if(!r.source?.trim()||!r.source_version?.trim()||!r.license?.trim()||!Object.keys(r.provenance??{}).length)
  throw new Error(`Missing source metadata in ${key}`);
const mapping={morphemes:"lexical_morphemes",lexemes:"lexical_lexemes",senses:"lexical_senses",forms:"lexical_forms",etymons:"lexical_etymons",
  etymological_links:"lexical_etymological_links",sense_relations:"lexical_sense_relations",usage_patterns:"lexical_usage_patterns",lexeme_morphemes:"lexical_lexeme_morphemes",spelling_variants:"lexical_spelling_variants"} as const;
const statements:string[]=["begin;"];
for(const [key,table] of Object.entries(mapping))for(let i=0;i<(corpus[key]?.length??0);i+=100){
 const rows=corpus[key].slice(i,i+100);
 // Preserve ALL existing lexical IDs, family keys, scores and dictionary definitions.
 statements.push(lexicalInsertSql(table,rows).replace(/do update set [\s\S]*;$/,"do nothing;"));
}
statements.push("commit;");writeFileSync(output,statements.join("\n"));
console.log("Knowledge-only SQL written; no production write performed.");
