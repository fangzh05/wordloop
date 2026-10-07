import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {readOewn} from "./lib/familyCorpus.js";
import {normalizeLemma} from "../server/services/familyPolicy.js";
import {lexicalInsertSql,type LexicalTable} from "./lib/familyImportSql.js";

const [xmlPath,oldPath,vocabularyPath,out]=process.argv.slice(2);
if(!xmlPath||!oldPath||!vocabularyPath||!out)throw new Error("Usage: build-oewn-dictionary OEWN_XML PREVIOUS_CORPUS PRIVATE_VOCAB_JSON PRIVATE_OUTPUT_DIR");
const oewn=readOewn(readFileSync(xmlPath,"utf8")),old=JSON.parse(readFileSync(oldPath,"utf8"));
const words=new Set<string>(JSON.parse(readFileSync(vocabularyPath,"utf8")).map(normalizeLemma));
const previous=new Set<string>(old.lexemes.map((l:any)=>l.lexeme_id));
const entries=[...oewn.entries.values()].filter(e=>previous.has(e.id)||words.has(e.lemma)).sort((a,b)=>a.id.localeCompare(b.id));
const source={source:"OEWN",source_version:"2025",license:"CC-BY-4.0 + Princeton-WordNet"};
const provenance={url:"https://en-word.net/static/english-wordnet-2025.xml.gz",xml_sha256:oewn.sha256,attribution:"Open English WordNet team; Princeton University WordNet",adaptation:"Canonical lemma/POS and complete sense parsing including self-closing XML senses. No additional lexical relations or learner states are created."};
const lexemes=entries.filter(e=>!previous.has(e.id)).map(e=>({lexeme_id:e.id,lemma:e.lemma,language:"en",part_of_speech:e.pos,frequency_band:null,utility_score:.65,exam_relevance:.5,family_key:`family:${e.id}`}));
const senses=entries.flatMap(e=>e.senses.flatMap(s=>{const syn=oewn.synsets.get(s.synset);return syn?.definition?[{sense_id:s.id,lexeme_id:e.id,definition:syn.definition,synset_id:s.synset,register:null,...source,provenance:{...provenance,source_sense_id:s.id,example_sentences:syn.examples}}]:[];}));
mkdirSync(out,{recursive:true});const manifest:any[]=[];
for(const [table,rows] of [["lexical_lexemes",lexemes],["lexical_senses",senses]] as const)for(let offset=0;offset<rows.length;){let size=Math.min(1500,rows.length-offset);
  const sqlFor=(n:number)=>{const sql=lexicalInsertSql(table as LexicalTable,rows.slice(offset,offset+n));return table==="lexical_lexemes"?sql.slice(0,sql.indexOf(" on conflict"))+" on conflict (lexeme_id) do nothing;":sql;};
  let sql=sqlFor(size);while(sql.length>180000&&size>1){size=Math.floor(size*.8);sql=sqlFor(size);}
  const file=`${out}/${String(manifest.length).padStart(3,"0")}.sql`;writeFileSync(file,sql);manifest.push({file,table,rows:size,characters:sql.length,sha256:createHash("sha256").update(sql).digest("hex")});offset+=size;
}
writeFileSync(`${out}/manifest.json`,JSON.stringify(manifest));
writeFileSync(`${out}/corpus.json`,JSON.stringify({lexemes:[...old.lexemes,...lexemes],senses}));
console.log(JSON.stringify({newBaseLexemes:lexemes.length,completeSenses:senses.length,batches:manifest.length,graphEdgesUnchanged:true}));
