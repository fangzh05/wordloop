// Offline only. Production snapshot is read-only; no client, secrets or network.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {privateDataRoot} from './lib/privateDataPath.js';
import {independentExamTags,planExamSourceMapping,type MappingSnapshot} from './lib/examSourceMapping.js';
import {sha256} from './lib/examBooks.js';
import {examSourceMergeSql} from './lib/examSourceMergeSql.js';
const root=privateDataRoot(process.argv[2]),csv=readFileSync(process.argv[3]!,'utf8');
const snapshotText=readFileSync(resolve(root,'five-exam-snapshot.json'),'utf8');
const snapshot=JSON.parse(snapshotText) as MappingSnapshot;
const plan=planExamSourceMapping(snapshot,independentExamTags(csv));
const prepared=examSourceMergeSql(snapshot,plan);
writeFileSync(resolve(root,'five-exam-merge.sql'),prepared.sql);
writeFileSync(resolve(root,'five-exam-rollback.sql'),prepared.rollback);
const report={mode:'dry-run',snapshot_sha256:sha256(snapshotText),batch:prepared.batch,sql_sha256:sha256(prepared.sql),...plan};
writeFileSync(resolve(root,'five-exam-dry-run.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,additions:report.additions.length,contribution:report.contribution},null,2));
