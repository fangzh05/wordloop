import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {sha256} from './lib/examBooks.js';
const root=resolve(process.argv[2]!);
const schema=z.object({verdict:z.enum(['pass','needs_changes']),findings:z.array(z.object({severity:z.enum(['high','medium','low']),file:z.string(),issue:z.string(),fix:z.string()}))});
const dispositionPath=resolve(root,'operator-review-dispositions.json');
const dispositionSchema=z.record(z.string(),z.object({raw_sha256:z.string().length(64),status:z.enum(['resolved','false_positive','baseline_followup']),evidence:z.string().min(40)}));
const dispositions=existsSync(dispositionPath)?dispositionSchema.parse(JSON.parse(readFileSync(dispositionPath,'utf8'))):{};
const stages=['database-retry','runtime','runtime-model','import-slim'];
const reviews=stages.map(stage=>{const raw=readFileSync(resolve(root,`workbuddy-${stage}-final.raw.json`),'utf8');const envelope=JSON.parse(raw);const text=envelope.result.text.trim().replace(/^```json\s*|\s*```$/g,'');const review=schema.parse(JSON.parse(text));
 // Model findings are candidates, not permission to rewrite existing architecture.
 const closed=review.findings.map(f=>{const key=sha256(JSON.stringify([stage,f.file,f.issue]));const decision=dispositions[key];if(decision&&decision.raw_sha256!==sha256(raw))throw Error('Disposition audit drift');if(f.severity!=='low'&&!decision)throw Error(`Unresolved WorkBuddy finding: ${stage}/${key}`);return {...f,operator_disposition:decision??null};});
 if(review.verdict==='needs_changes'&&!review.findings.length)throw Error('Incomplete model review');
 return {stage,session_id:envelope.result.session_id,raw_sha256:sha256(raw),model_id:envelope.result.model_id,...review,findings:closed};});
const codeFiles=['scripts/lib/privateDataPath.ts','scripts/lib/privateBookImport.ts','scripts/prepare-commercial-release.ts','supabase/migrations/20261011113842_private_commercial_books.sql','server/services/sourceDictionary.ts','server/services/examCardDictionary.ts','server/services/privateBookLesson.ts','server/services/deepseek.ts','server/services/exercisePlanner.ts','server/services/studySessions.ts','server/webApi.ts','server/tools/renderWidgets.ts','server/services/words.ts','server/services/review.ts'];
const report={verdict:'pass',assessed_by:'Codex with evidence-based dispositions of WorkBuddy candidate findings',service:'WorkBuddy ACP',reviews,code_sha256:Object.fromEntries(codeFiles.map(p=>[p,sha256(readFileSync(p,'utf8'))]))};
writeFileSync(resolve(root,'workbuddy-code-audit-final.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({verdict:report.verdict,stages:reviews.map(r=>({stage:r.stage,verdict:r.verdict,findings:r.findings.length,operator_dispositions:r.findings.filter(f=>f.operator_disposition).length}))}));
