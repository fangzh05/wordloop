import { createHash } from "node:crypto";
import { normalizeLemma } from "../../server/services/familyPolicy.js";
import type { DictionaryGloss,LexicalDictionaryEntry } from "../../shared/familyContracts.js";

export const ECDICT_VERSION="bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b";
export const ECDICT_SHA256="1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf";
export const ECDICT_URL=`https://raw.githubusercontent.com/skywind3000/ECDICT/${ECDICT_VERSION}/ecdict.csv`;
// CSV parser handles quoted commas/newlines and escaped quotes; no evaluation.
export function* csvRecords(text:string):Generator<string[]> {
  let fields:string[]=[],field="",quoted=false;
  for(let i=text.charCodeAt(0)===0xfeff?1:0;i<text.length;i++) {
    const c=text[i]!;
    if(c==='"') {
      if(quoted&&text[i+1]==='"'){field+='"';i++;}
      else if(quoted||field.length===0)quoted=!quoted;
      else field+=c;
    } else if(c===","&&!quoted){fields.push(field);field="";}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;fields.push(field);if(fields.some(Boolean))yield fields;fields=[];field="";}
    else field+=c;
  }
  if(quoted)throw new Error("Unclosed dictionary CSV quote");
  if(fields.length||field){fields.push(field);yield fields;}
}
const multiline=(value:string)=>value.replace(/\\r\\n|\\n|\\r/g,"\n").replace(/\r\n?/g,"\n").trim();
const posPrefix=/^((?:(?:vt|vi|vti|v|n|adj|a|adv|ad|r|s|pron|prep|conj|interj|int|num|aux|art|det|modal|abbr|pl)\.\s*(?:(?:&|\/|,|or\b|and\b|及|和|、)\s*)?)+)([\s\S]*)$/i;
const canonicalPos=(label:string)=>{
  const first=label.match(/^[a-z]+/i)?.[0]?.toLowerCase();
  if(first&&["vt","vi","vti","v","aux","modal"].includes(first))return "v";
  if(first&&["adj","a","s"].includes(first))return "a";
  if(first&&["adv","ad","r"].includes(first))return "r";
  if(first==="n")return "n";
  return first??null;
};
export function dictionaryGlosses(translation:string,definition:string):DictionaryGloss[] {
  const groups:DictionaryGloss[]=[],known=new Set<string>();
  for(const line of multiline(translation).split("\n").filter(Boolean)) {
    const match=line.match(posPrefix),label=match?.[1]?.trim()??"",pos=label?canonicalPos(label):null;
    const text=match?.[2]?.trim()??line;
    if(pos)known.add(pos);
    groups.push({label,part_of_speech:pos,definition_zh:text,definition_en:null});
  }
  // Preserve English-only POS evidence too; do not align independent glosses.
  for(const line of multiline(definition).split("\n").filter(Boolean)) {
    const match=line.match(posPrefix);if(!match)continue;
    const label=match[1]!.trim(),pos=canonicalPos(label);
    if(pos&&known.has(pos))continue;
    const existing=groups.find(g=>g.part_of_speech===pos&&!g.definition_zh);
    if(existing)existing.definition_en+="; "+match[2]!.trim();
    else groups.push({label,part_of_speech:pos,definition_zh:null,definition_en:match[2]!.trim()});
  }
  if(groups.length>32)throw new Error("Dictionary entry exceeds bounded gloss count");
  return groups;
}
export function buildEcdictCorpus(csv:string,wanted:Iterable<string>,checksum=createHash("sha256").update(csv).digest("hex")) {
  const scope=new Set([...wanted].map(normalizeLemma)),records=csvRecords(csv),header:string[]|undefined=records.next().value;
  if(!header||header[0]!=="word"||!header.includes("translation")||!header.includes("definition"))throw new Error("Unexpected ECDICT header");
  const entries=new Map<string,LexicalDictionaryEntry>();let recordNumber=1,rejected=0;
  for(const row of records){recordNumber++;const raw=Object.fromEntries(header.map((key,i)=>[key,row[i]??""]));const lemma=normalizeLemma(raw.word!);
    if(!scope.has(lemma)||lemma.length>120)continue;
    const en=multiline(raw.definition!),zh=multiline(raw.translation!);
    if((!en&&!zh)||en.length>20000||zh.length>20000){rejected++;continue;}
    const groups=dictionaryGlosses(zh,en),existing=entries.get(lemma);
    const evidence={record_number:recordNumber,surface:raw.word,raw_pos:raw.pos};
    if(existing) {
      // Case/whitespace variants share an entry, preserving all source records.
      for(const g of groups)if(!existing.parts_of_speech.some(x=>JSON.stringify(x)===JSON.stringify(g)))existing.parts_of_speech.push(g);
      if(en&&!existing.english_definition.includes(en))existing.english_definition+="\n"+en;
      if(zh&&!existing.chinese_translation.includes(zh))existing.chinese_translation+="\n"+zh;
      (existing.provenance.records as unknown[]).push(evidence);
      if(existing.parts_of_speech.length>32||existing.english_definition.length>20000||existing.chinese_translation.length>20000)throw new Error("Merged dictionary entry exceeds payload bound");
      continue;
    }
    entries.set(lemma,{entry_id:`ecdict:${ECDICT_VERSION}:en:${lemma}`,lemma,language:"en",phonetic:raw.phonetic?.trim()||null,
      english_definition:en,chinese_translation:zh,parts_of_speech:groups,source:"ECDICT",source_version:ECDICT_VERSION,license:"MIT",confidence:.9,
      provenance:{url:ECDICT_URL,file_sha256:checksum,license_url:`https://github.com/skywind3000/ECDICT/blob/${ECDICT_VERSION}/LICENSE`,attribution:"Copyright (c) 2025 Linwei; ECDICT contributors",records:[evidence],adaptation:"NFC/lowercase/whitespace normalization; multiline and POS extraction; selected vocabulary subset. Dictionary glosses are not aligned to OEWN synsets."}});
  }
  const rows=[...entries.values()].sort((a,b)=>a.lemma.localeCompare(b.lemma,"en"));
  return {dictionary_entries:rows,report:{requested:scope.size,covered:rows.length,chinese:rows.filter(r=>r.chinese_translation).length,missing:[...scope].filter(w=>!entries.has(w)).sort(),rejected}};
}
