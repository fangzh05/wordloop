// Offline only. No Supabase client or deployment capability.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {privateDataRoot} from './lib/privateDataPath.js';
import {prepareDeepImport,type DeepBook,type DeepSnapshot} from './lib/deepExamImport.js';
import {deepExamSql} from './lib/deepExamSql.js';
const root=privateDataRoot(process.argv[2]);
const draft=JSON.parse(readFileSync(resolve(root,'private-staging.json'),'utf8')) as {books:Record<string,DeepBook>};
const snapshot=JSON.parse(readFileSync(resolve(root,'live-snapshot.json'),'utf8')) as DeepSnapshot;
const legacy=JSON.parse(readFileSync(resolve(root,'../five-exam-snapshot.json'),'utf8'));
const plan=prepareDeepImport(draft.books,snapshot,legacy.sources);
const sql=deepExamSql(snapshot,plan);
writeFileSync(resolve(root,'merge.sql'),sql.sql);
writeFileSync(resolve(root,'rollback.sql'),sql.rollback);
writeFileSync(resolve(root,'private-plan.json'),JSON.stringify(plan));
const {accepted,additions,held,...report}=plan;
writeFileSync(resolve(root,'dry-run.json'),JSON.stringify({...report,held_records:held.length,mode:'offline dry-run against read-only production snapshot',production_writes:0},null,2));
writeFileSync(resolve(root,'review-queue.json'),JSON.stringify(held,null,2));
console.log(JSON.stringify({metrics:plan.metrics,unique_new_global_words:plan.unique_new_global_words,held_records:held.length}));
