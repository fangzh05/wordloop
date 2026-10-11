import { createHash } from 'node:crypto';
import { csvRecords, buildEcdictCorpus, ECDICT_VERSION, ECDICT_SHA256 } from './ecdictCorpus.js';
import { normalizeWord, wordInputSchema } from '../../server/services/wordNormalization.js';

export const EXAM_TAGS = ['cet4','cet6','ielts','toefl'] as const;
export const RULE_VERSION = 'exam-dedupe-v1';
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export type Review = { key: string; input_sha256: string; rules: string; action: 'approve'|'reject'; reviewer: string; reason: string };
// Folded identity is ONLY a review hint. It never changes the learning identity.
export const foldedHint = (value: string) => normalizeWord(value.normalize('NFKC')).replace(/[’‘]/g,"'").replace(/[‐‑–—]/g,'-').replace(/\s+/g,' ').replace(/[-' ]/g,'');

export function buildExamBooks(csv: string, existing: string[], reviews: Review[] = [], requirePinned = true) {
  const checksum = sha256(csv);
  if (requirePinned && checksum !== ECDICT_SHA256) throw Error('Pinned ECDICT checksum mismatch');
  const records = csvRecords(csv), header = records.next().value as string[];
  if (!header?.includes('tag') || !header.includes('word')) throw Error('Missing ECDICT headers');
  const counts = Object.fromEntries(EXAM_TAGS.map(t=>[t,0])) as Record<string,number>;
  const words = new Map<string,{word:string; tags:Set<string>; records:number[]; surfaces:Set<string>}>();
  let rowNumber = 1, duplicates = 0;
  for (const row of records) {
    rowNumber++;
    if (row.length !== header.length) throw Error(`Malformed CSV record ${rowNumber}`);
    const raw = Object.fromEntries(header.map((k,i)=>[k,row[i]!]));
    const tags = EXAM_TAGS.filter(t=>new Set(raw.tag!.split(/\s+/)).has(t));
    if (!tags.length) continue;
    tags.forEach(t=>counts[t]=(counts[t]??0)+1);
    const word = normalizeWord(raw.word!);
    const prior = words.get(word);
    if(prior) { duplicates++; tags.forEach(t=>prior.tags.add(t)); prior.records.push(rowNumber); prior.surfaces.add(raw.word!); }
    else words.set(word,{word,tags:new Set(tags),records:[rowNumber],surfaces:new Set([raw.word!])});
  }
  const known = new Set(existing), hints = new Map<string,Set<string>>();
  for(const word of [...known,...words.keys()]) { const key=foldedHint(word); const set=hints.get(key)??new Set();set.add(word);hints.set(key,set); }
  const candidates: Array<{key:string;word:string;tags:string[];records:number[];reason:string;alternatives:string[]}> = [];
  const approved: typeof candidates = [], rejected: typeof candidates = [], pending: typeof candidates = [];
  for(const item of [...words.values()].sort((a,b)=>a.word<b.word?-1:a.word>b.word?1:0)) {
    const alternatives=[...(hints.get(foldedHint(item.word))??[])].filter(w=>w!==item.word).sort();
    const invalid=!wordInputSchema.safeParse(item.word).success;
    const reasons=[invalid?'invalid_format':'',item.word.includes(' ')?'multiword':'',item.word.normalize('NFC')!==item.word?'unicode':'',alternatives.length?'folded_collision':''].filter(Boolean);
    if(!reasons.length)continue;
    const candidate={key:sha256(JSON.stringify([item.word,item.records])),word:item.word,tags:[...item.tags].sort(),records:item.records,reason:reasons.join(','),alternatives};
    candidates.push(candidate);
    const matches=reviews.filter(r=>r.key===candidate.key);
    if(matches.length>1)throw Error(`Duplicate review: ${candidate.key}`);
    const review=matches[0];
    if(review && (review.input_sha256!==checksum||review.rules!==RULE_VERSION||!review.reviewer.trim()||!review.reason.trim()))throw Error('Unbound or incomplete human review');
    if(review?.action==='reject')rejected.push(candidate);
    else if(review?.action==='approve'&&!invalid)approved.push(candidate);
    else pending.push(candidate);
  }
  for(const review of reviews)if(!candidates.some(c=>c.key===review.key))throw Error('Unknown review key');
  const blocked=new Set([...pending,...rejected].map(c=>c.word));
  const accepted=[...words.values()].filter(w=>!blocked.has(w.word));
  const corpus=buildEcdictCorpus(csv,accepted.map(w=>w.word),checksum);
  // Missing glosses are unresolved, never silently dropped or published.
  const available=new Set(corpus.dictionary_entries.filter(e=>e.chinese_translation).map(e=>e.lemma));
  const missingGloss=accepted.filter(w=>!known.has(w.word)&&!available.has(w.word)).map(w=>w.word);
  const relationships=accepted.flatMap(w=>[...w.tags].sort().map(book_id=>({book_id,normalized_word:w.word,source:'ECDICT',source_version:ECDICT_VERSION,source_records:w.records})));
  const intersections:Record<string,number>={};
  for(let mask=1;mask<16;mask++) {
    const tags=EXAM_TAGS.filter((_,i)=>(mask&(1<<i))!==0);
    if(tags.length>1)intersections[tags.join('&')]=[...words.values()].filter(w=>tags.every(t=>w.tags.has(t))).length;
  }
  const additions=corpus.dictionary_entries.filter(e=>!known.has(e.lemma));
  const report={source_version:ECDICT_VERSION,input_sha256:checksum,rules:RULE_VERSION,raw_counts:counts,
    unique_counts:Object.fromEntries(EXAM_TAGS.map(t=>[t,[...words.values()].filter(w=>w.tags.has(t)).length])),
    accepted_counts:Object.fromEntries(EXAM_TAGS.map(t=>[t,accepted.filter(w=>w.tags.has(t)).length])),
    union:words.size,existing:[...words.keys()].filter(w=>known.has(w)).length,
    scoped_missing_total:[...words.keys()].filter(w=>!known.has(w)).length,new_dictionary_records:additions.length,
    per_book_dictionary:Object.fromEntries(EXAM_TAGS.map(t=>[t,{existing:[...words.values()].filter(w=>w.tags.has(t)&&known.has(w.word)).length,missing:[...words.values()].filter(w=>w.tags.has(t)&&!known.has(w.word)).length}])),
    deterministic_duplicates:duplicates,intersections,model_calls:0,model_version:null,prompt_version:null,
    model_same_entry:0,model_different_entry:0,model_needs_review:0,human_approved:approved.length,human_rejected:rejected.length,
    pending:pending.length,missing_gloss:missingGloss,publication_ready:pending.length===0&&missingGloss.length===0,
    estimated_payload_bytes:Buffer.byteLength(JSON.stringify({additions,relationships})),
    storage_note:'Serialized payload only; PostgreSQL heap, TOAST and index allocation require isolated import measurement.',
    public_source:'ECDICT MIT; preserve bundled copyright and license',kaoyan:'PRIVATE ONLY: no public redistribution evidence; no ky tags imported'};
  return {report,candidates,approved,rejected,pending,relationships,additions};
}
