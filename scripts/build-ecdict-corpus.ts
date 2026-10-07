import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {buildEcdictCorpus,ECDICT_SHA256} from "./lib/ecdictCorpus.js";
import {lexicalInsertSql} from "./lib/familyImportSql.js";
const [csvPath,lexicalPath,vocabularyPath,out]=process.argv.slice(2);
if(!csvPath||!lexicalPath||!vocabularyPath||!out)throw new Error("Usage: build-ecdict-corpus PINNED_CSV LEXICAL_CORPUS PRIVATE_VOCAB_JSON PRIVATE_OUTPUT_DIR");
const csv=readFileSync(csvPath,"utf8"),checksum=createHash("sha256").update(csv).digest("hex");
if(checksum!==ECDICT_SHA256)throw new Error("ECDICT checksum differs from pinned source");
const lexemes=JSON.parse(readFileSync(lexicalPath,"utf8")).lexemes;
const vocabulary:string[]=JSON.parse(readFileSync(vocabularyPath,"utf8"));
const corpus=buildEcdictCorpus(csv,[...lexemes.map((l:any)=>l.lemma),...vocabulary],checksum);
mkdirSync(out,{recursive:true});writeFileSync(`${out}/corpus.json`,JSON.stringify({dictionary_entries:corpus.dictionary_entries}));writeFileSync(`${out}/report.json`,JSON.stringify(corpus.report,null,2));
const manifest:any[]=[];
for(let offset=0;offset<corpus.dictionary_entries.length;){let size=Math.min(1000,corpus.dictionary_entries.length-offset),sql=lexicalInsertSql("lexical_dictionary_entries",corpus.dictionary_entries.slice(offset,offset+size));
  while(sql.length>180000&&size>1){size=Math.floor(size*.8);sql=lexicalInsertSql("lexical_dictionary_entries",corpus.dictionary_entries.slice(offset,offset+size));}
  const file=`${out}/${String(manifest.length).padStart(3,"0")}.sql`;writeFileSync(file,sql);manifest.push({file,rows:size,characters:sql.length,sha256:createHash("sha256").update(sql).digest("hex")});offset+=size;
}
writeFileSync(`${out}/manifest.json`,JSON.stringify(manifest));console.log(JSON.stringify({...corpus.report,missing:corpus.report.missing.length,batches:manifest.length}));
