import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
const [input,output="tests/data"]=process.argv.slice(2);
if(!input)throw new Error("Usage: extract-sense-fixture OEWN_2025_XML [OUTPUT_DIRECTORY]");
const xml=readFileSync(input,"utf8"),hash=(text:string)=>createHash("sha256").update(text).digest("hex");
if(hash(xml)!=="6f49adeec174ab3092169fb25cf4a925226b63975a5d29a691a5dff88f0673b2")throw new Error("Expected pinned official OEWN 2025 XML");
const entries=[...xml.matchAll(/<LexicalEntry\b[^>]*>[\s\S]*?<\/LexicalEntry>/g)].map(m=>m[0]);
const synsets=[...xml.matchAll(/<Synset\b[^>]*>[\s\S]*?<\/Synset>/g)].map(m=>m[0]);
const wanted=new Set<string>();
for(const e of entries.filter(e=>/<Lemma writtenForm="(?:bear|bearing)"/.test(e)))for(const s of e.matchAll(/synset="([^"]+)"/g))wanted.add(s[1]!);
for(const s of synsets.filter(s=>wanted.has(s.match(/id="([^"]+)"/)![1]!)))for(const r of s.matchAll(/<SynsetRelation\b[^>]*>/g))
 if(/relType="(?:hypernym|hyponym)"/.test(r[0]))wanted.add(r[0].match(/target="([^"]+)"/)![1]!);
const chosen=entries.filter(e=>[...e.matchAll(/synset="([^"]+)"/g)].some(s=>wanted.has(s[1]!)));
const all=new Set<string>();for(const e of chosen)for(const s of e.matchAll(/synset="([^"]+)"/g))all.add(s[1]!);
const fixture='<Lexicon id="oewn" version="2025">\n'+chosen.join("\n")+"\n"+synsets.filter(s=>all.has(s.match(/id="([^"]+)"/)![1]!)).join("\n")+"\n</Lexicon>\n";
mkdirSync(output,{recursive:true});writeFileSync(join(output,"oewn-bear-bearing-2025.xml"),fixture);
writeFileSync(join(output,"oewn-bear-bearing-2025.manifest.json"),JSON.stringify({source:"https://en-word.net/static/english-wordnet-2025.xml.gz",edition:2025,
 license:"CC-BY-4.0 + Princeton-WordNet",upstream_sha256:hash(xml),fixture_sha256:hash(fixture),roots:["bear","bearing"],
 selection:"Complete root entries and all members of root synsets plus direct hypernym/hyponym synsets; retain complete chosen entries and their synsets.",
 entries:chosen.length,bytes:Buffer.byteLength(fixture)},null,2)+"\n");
console.log(JSON.stringify({entries:chosen.length,bytes:Buffer.byteLength(fixture),sha256:hash(fixture)}));
