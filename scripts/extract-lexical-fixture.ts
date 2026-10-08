import { readFileSync,writeFileSync } from "node:fs";
const [input,scope,output]=process.argv.slice(2);
if(!input||!scope||!output)throw new Error("Usage: extract-lexical-fixture CORPUS_JSON PUBLIC_VOCAB_JSON OUTPUT_JSON");
const c=JSON.parse(readFileSync(input,"utf8")),words=new Set(JSON.parse(readFileSync(scope,"utf8")));
const roots=new Set<string>(c.lexemes.filter((l:any)=>words.has(l.lemma)).map((l:any)=>l.lexeme_id));
const owners=new Map<string,string>(c.senses.map((s:any)=>[s.sense_id,s.lexeme_id]));
const chosen=new Map<string,any>();
for(const root of [...roots].sort())for(const type of ["SYNONYM","ANTONYM","HYPERNYM","HYPONYM","CONFUSABLE"]){
 const edges=c.sense_relations.filter((r:any)=>r.relation_type===type&&(owners.get(r.source_sense_id)===root||owners.get(r.target_sense_id)===root)).sort((a:any,b:any)=>a.relation_id.localeCompare(b.relation_id));
 for(const e of edges.slice(0,4))chosen.set(e.relation_id,e);
}
for(const r of c.sense_relations)if(!r.relation_id.startsWith("oewn-network:"))chosen.set(r.relation_id,r);
const ids=new Set<string>([...roots,...[...chosen.values()].flatMap(r=>[owners.get(r.source_sense_id)!,owners.get(r.target_sense_id)!])]);
const fixture={...c,lexemes:c.lexemes.filter((l:any)=>ids.has(l.lexeme_id)),senses:c.senses.filter((s:any)=>ids.has(s.lexeme_id)),forms:c.forms.filter((f:any)=>ids.has(f.lexeme_id)),sense_relations:[...chosen.values()]};
writeFileSync(output,JSON.stringify(fixture,null,2)+"\n");
console.log(JSON.stringify({lexemes:fixture.lexemes.length,senses:fixture.senses.length,relations:fixture.sense_relations.length}));
