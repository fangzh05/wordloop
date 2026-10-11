import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {buildExamBooks,sha256,type Review} from './lib/examBooks.js';
import {csvRecords} from './lib/ecdictCorpus.js';
const [csvPath,existingPath,out,reviewPath]=process.argv.slice(2);
if(!csvPath||!existingPath||!out)throw Error('Usage: build-exam-books CSV EXISTING_LEMMAS_JSON OUTPUT_DIR [HUMAN_REVIEWS_JSON]');
const csv=readFileSync(csvPath,'utf8'),existing=JSON.parse(readFileSync(existingPath,'utf8')) as string[];
let reviews:Review[]=[];
if(reviewPath){const text=readFileSync(reviewPath,'utf8');if(reviewPath.endsWith('.csv')){const records=csvRecords(text);const header=records.next().value as string[];reviews=[...records].map(row=>Object.fromEntries(header.map((k,i)=>[k,row[i]??'']))).filter(row=>row.action).map(row=>{if(!['approve','reject'].includes(row.action!))throw Error('Invalid human review action');return {key:row.key!,input_sha256:row.input_sha256!,rules:row.rules!,action:row.action as Review['action'],reviewer:row.reviewer!,reason:row.reason!};});}else reviews=JSON.parse(text);}
const result=buildExamBooks(csv,existing,reviews);
mkdirSync(out,{recursive:true});
const files:Record<string,string>={
 'dedupe-candidates.jsonl':result.candidates.map(x=>JSON.stringify(x)).join('\n'),
 'dedupe-model-review.jsonl':'',
 'dedupe-human-review.csv':'key,input_sha256,rules,word,tags,source_records,candidate_reason,action,reviewer,reason\n'+result.pending.map(x=>[x.key,result.report.input_sha256,result.report.rules,x.word,x.tags.join(' '),x.records.join(' '),x.reason,'','',''].map(v=>'"'+v.replace(/"/g,'""')+'"').join(',')).join('\n'),
 'dedupe-approved.jsonl':result.approved.map(x=>JSON.stringify(x)).join('\n'),
 'dedupe-rejected.jsonl':result.rejected.map(x=>JSON.stringify(x)).join('\n'),
 'human-decisions.json':JSON.stringify(reviews,null,2),
 'report.json':JSON.stringify(result.report,null,2),
 'dedupe-report.md':'# Exam books dry run\n\n```json\n'+JSON.stringify(result.report,null,2)+'\n```\n\nModel unavailable: native app automation is disabled in this session. All uncertain items remain in the human queue. No model decision is an import approval.\n',
};
// Draft artifacts exist for inspection, but a final manifest is gated by review.
files['draft-corpus.json']=JSON.stringify({dictionary_entries:result.additions,relationships:result.relationships});
if(result.report.publication_ready)files['final-corpus.json']=files['draft-corpus.json']!;
for(const [name,value]of Object.entries(files))writeFileSync(`${out}/${name}`,value);
writeFileSync(`${out}/manifest.json`,JSON.stringify({input_sha256:sha256(csv),existing_snapshot_sha256:sha256(JSON.stringify(existing)),publication_ready:result.report.publication_ready,files:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,sha256(v)]))},null,2));
console.log(JSON.stringify(result.report,null,2));
