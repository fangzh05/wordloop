// Offline extraction from the official OEWN 2025 LMF download. This deliberately
// imports a reviewed allowlist, never infers relationships from string prefixes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const xml = readFileSync(process.argv[2] ?? '.qa/oewn-2025.xml', 'utf8');
const decode = s => s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const attr = (s, a) => decode(s.match(new RegExp(`${a}="([^"]*)"`))?.[1] ?? '');
const entries = [...xml.matchAll(/<LexicalEntry\b[^>]*>[\s\S]*?<\/LexicalEntry>/g)].map(m => m[0]);
const source = { source:'OEWN', source_version:'2025', license:'CC-BY-4.0 + Princeton-WordNet', provenance:{url:'https://en-word.net/static/english-wordnet-2025.xml.gz', sha256_xml:createHash('sha256').update(xml).digest('hex')} };
const spec = [
  ['persuade','v','persuade',.9,.9],['persuasion','n','persuade',.9,.9],['persuasive','a','persuade',.85,.8],['persuasively','r','persuade',.65,.65],
  ['convince','v','convince',.85,.8],['dissuade','v','dissuade',.7,.7],
  ['reconcile','v','reconcile',.85,.95],['reconciliation','n','reconcile',.88,.9],['reconcilable','a','reconcile',.62,.7],
  ['economy','n','economy',.95,.95],['economic','a','economy',.95,.95],['economical','a','economy',.85,.9],['economics','n','economy',.8,.85],
  ['act','v','act',.95,.8],['action','n','act',.95,.9],['active','a','act',.9,.85],['actively','r','act',.7,.7],['activity','n','act',.85,.85],
  ['activate','v','act',.75,.75],['activation','n','act',.65,.65],['actor','n','act',.85,.8],
];
const lexemes=[], senses=[], forms=[], relations=[];
const entryById=new Map(), senseOwner=new Map();
for(const entry of entries) {
  const e={lemma:attr(entry.match(/<Lemma\b[^>]*>/)?.[0]??'', 'writtenForm'),pos:attr(entry.match(/<Lemma\b[^>]*>/)?.[0]??'','partOfSpeech'),entry};
  entryById.set(`en:${e.lemma}:${e.pos}`,e);
  for(const m of entry.matchAll(/<Sense\b[^>]*>/g)) senseOwner.set(attr(m[0],'id'),`en:${e.lemma}:${e.pos}`);
}
const synsetDefinitions=new Map([...xml.matchAll(/<Synset\b[^>]*>[\s\S]*?<\/Synset>/g)].map(m=>[attr(m[0],'id'),decode(m[0].match(/<Definition[^>]*>([\s\S]*?)<\/Definition>/)?.[1]??'')]));
for(const [lemma,pos,family_key,utility_score,exam_relevance] of spec) {
  const id=`en:${lemma}:${pos}`, entry=entryById.get(id);
  if(!entry) throw new Error(`Missing official lexeme ${id}`);
  lexemes.push({lexeme_id:id,lemma,language:'en',part_of_speech:pos,frequency_band:null,utility_score,exam_relevance,family_key});
  for(const m of [...entry.entry.matchAll(/<Sense\b[^>]*>/g)].slice(0,2)) {
    const synset_id=attr(m[0],'synset');
    senses.push({sense_id:attr(m[0],'id'),lexeme_id:id,definition:synsetDefinitions.get(synset_id)??'',synset_id,register:null,...source});
  }
  forms.push({form_id:`${id}:lemma`,lexeme_id:id,surface_form:lemma,form_type:'lemma',pronunciation:decode(entry.entry.match(/<Pronunciation[^>]*variety="US"[^>]*>([^<]*)/)?.[1]??'')||null,...source});
}
const pair=(a,ap,b,bp,morphology,transparency=.9,interference_risk=.2,type='DERIVATION')=>{
  const aId=`en:${a}:${ap}`, bId=`en:${b}:${bp}`;
  const evidence=[];
  for(const [id,other] of [[aId,bId],[bId,aId]]) {
    const entry=entryById.get(id).entry;
    for(const s of entry.matchAll(/<Sense\b[^>]*>([\s\S]*?)<\/Sense>/g)) for(const r of s[1].matchAll(/<SenseRelation\b[^>]*\/>/g)) {
      const raw_type=attr(r[0],'relType'), target=attr(r[0],'target');
      if(senseOwner.get(target)===other && (raw_type==='derivation'||raw_type==='pertainym'||raw_type==='antonym')) evidence.push({source_sense_id:attr(s[0],'id'),target_sense_id:target,raw_type});
    }
  }
  if(!evidence.length) throw new Error(`No OEWN evidence for reviewed pair ${a}/${b}`);
  relations.push({relation_id:`${aId}>${bId}:${type}:OEWN`,source_id:aId,target_id:bId,relation_type:type,direction:'forward',...source,provenance:{...source.provenance,evidence,normalization:'explicit reviewed morphology allowlist v1; source pertainym is not generally derivation'},confidence:.95,transparency,interference_risk,morphology});
};
pair('persuade','v','persuasion','n','persuade → persuasion：-sion 构成名词；词干拼写改变。');
pair('persuade','v','persuasive','a','persuade → persuasive：-sive 构成形容词；词干拼写改变。');
pair('persuasive','a','persuasively','r','persuasive + -ly → persuasively：形容词变为副词。');
pair('persuade','v','dissuade','v',null,0,0,'CONTRAST');
pair('reconcile','v','reconciliation','n','reconcile → reconciliation：-ation 构成名词，注意词干变化。');
pair('economy','n','economic','a','economy → economic：形容词常表示经济方面的。',.8,.8);
pair('economy','n','economical','a','economy → economical：形容词常表示节约的。',.75,.9);
pair('economics','n','economic','a','economics / economic：学科名词与形容词，须结合词性和语境。',.7,.9);
pair('act','v','action','n','act → action：-ion 构成名词。',.9,.3);
pair('act','v','actor','n','act + -or → actor：表示做这个动作的人。',.9,.25);
pair('active','a','actively','r','active + -ly → actively：形容词变为副词。');
pair('active','a','activity','n','active → activity：-ity 构成名词。',.85,.6);
pair('activate','v','activation','n','activate → activation：-ation 构成名词。',.9,.7);
// Explicit, pinned Wiktionary enrichment. No inferred missing OEWN edges.
const wiki=(a,b,url,version,morphology,transparency,risk)=>relations.push({relation_id:`${a}>${b}:DERIVATION:Wiktionary`,source_id:a,target_id:b,relation_type:'DERIVATION',direction:'forward',source:'Wiktionary',source_version:version,license:'CC-BY-SA-4.0',provenance:{url,section:'English etymology',normalization:'explicit morphology, reviewed allowlist v1'},confidence:.9,transparency,interference_risk:risk,morphology});
wiki('en:reconcile:v','en:reconcilable:a','https://en.wiktionary.org/w/index.php?title=reconcilable&oldid=91698837','91698837','reconcile + -able → reconcilable：可以调和的；去掉词尾 e。',.95,.25);
// Remaining act branches are added only after fixed-version etymology verification.
wiki('en:act:v','en:active:a','https://en.wiktionary.org/w/index.php?title=active&oldid=92768449','92768449','act + -ive → active：表层形态分析；历史上经法语借入，不把它解释成直接在现代英语中造词。',.85,.4);
wiki('en:active:a','en:activate:v','https://en.wiktionary.org/w/index.php?title=activate&oldid=92355748','92355748','active + -ate → activate：使活跃、使启动。',.85,.55);
wiki('en:economic:a','en:economical:a','https://en.wiktionary.org/w/index.php?title=economical&oldid=92744007','92744007','economic + -al → economical：现代用法中 economic 指经济方面，economical 指节约、实惠。',.8,.9);
const morphemes=[['sion','-sion','suffix','动作或结果的名词'],['ation','-ation','suffix','动作或结果的名词'],['ly','-ly','suffix','方式副词'],['able','-able','suffix','可以……的'],['or','-or','suffix','做某事的人'],['ity','-ity','suffix','状态或性质的名词']].map(([morpheme_id,surface,type,meaning])=>({morpheme_id,surface,type,meaning}));
mkdirSync('server/data',{recursive:true});
writeFileSync('server/data/familySeed.json',JSON.stringify({lexemes,senses,forms,morphemes,relations},null,2)+'\n');
console.log({lexemes:lexemes.length,relations:relations.length});
