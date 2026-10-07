import { readFileSync,writeFileSync,mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { LEXICAL_TABLES,lexicalInsertSql } from "./lib/familyImportSql.js";
import { lexemeId,normalizeRelation } from "../server/services/familyPolicy.js";
import type { LexicalRelation } from "../shared/familyContracts.js";
const [input,out]=process.argv.slice(2);if(!input||!out)throw new Error("Usage: prepare-family-sql CORPUS_JSON PRIVATE_OUTPUT_DIRECTORY");
const text=readFileSync(input,"utf8"),data=JSON.parse(text),ids=new Set(data.lexemes.map((l:any)=>l.lexeme_id));
for(const l of data.lexemes)if(l.lexeme_id!==lexemeId(l.lemma,l.part_of_speech))throw new Error("Non-canonical lexeme");
for(const r of data.relations){normalizeRelation(r as LexicalRelation);if(!ids.has(r.source_id)||!ids.has(r.target_id))throw new Error("Broken adjacency");}
mkdirSync(out,{recursive:true});const manifest:any[]=[];
for(const table of LEXICAL_TABLES){const rows=data[table.replace("lexical_","")],pk=Object.keys(rows[0]??{})[0]!,seen=new Set();
 for(const row of rows){if(seen.has(row[pk]))throw new Error(`Duplicate primary key in ${table}`);seen.add(row[pk]);}
 // Source groups keep common attribution compact; provenance is reconstituted in PostgreSQL.
 const groups=new Map<string,any[]>();for(const row of rows){const key=JSON.stringify([row.source,row.source_version,row.license]);const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 for(const group of groups.values())for(let offset=0;offset<group.length;){let size=Math.min(1500,group.length-offset),sql=lexicalInsertSql(table,group.slice(offset,offset+size));
  while(sql.length>180000&&size>1){size=Math.floor(size*.8);sql=lexicalInsertSql(table,group.slice(offset,offset+size));}
  const filename=`${out}/${String(manifest.length).padStart(3,"0")}.sql`;writeFileSync(filename,sql);manifest.push({table,rows:size,file:filename,characters:sql.length,sha256:createHash("sha256").update(sql).digest("hex")});offset+=size;
 }
}
writeFileSync(`${out}/manifest.json`,JSON.stringify(manifest,null,2));console.log(JSON.stringify({batches:manifest.length,totalSqlCharacters:manifest.reduce((n,r)=>n+r.characters,0),tables:Object.fromEntries(LEXICAL_TABLES.map(t=>[t,manifest.filter(r=>r.table===t).reduce((n,r)=>n+r.rows,0)]))}));
