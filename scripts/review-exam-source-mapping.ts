import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {privateDataRoot} from './lib/privateDataPath.js';
import {sha256} from './lib/examBooks.js';
const root=privateDataRoot(process.argv[2]);
const schema=z.object({verdict:z.enum(['pass','needs_changes']),findings:z.array(z.object({severity:z.enum(['high','medium','low']),file:z.string(),issue:z.string(),fix:z.string()}))});
if(process.argv.includes('--validate')){
 const raw=readFileSync(resolve(root,'five-exam-workbuddy-model.json'),'utf8');
 const review=schema.parse(JSON.parse(raw));
 writeFileSync(resolve(root,'five-exam-workbuddy-validated.json'),JSON.stringify({service:'WorkBuddy MCP',model_output_sha256:sha256(raw),...review},null,2));
 console.log(JSON.stringify({verdict:review.verdict,findings:review.findings.length}));
 process.exit(0);
}
const files=['supabase/migrations/20261012020000_exam_source_mapping.sql','scripts/lib/examSourceMapping.ts','scripts/lib/examSourceMergeSql.ts','server/services/sourceDictionary.ts','server/services/examCardDictionary.ts','tests/examSourceMapping.test.ts'];
const code=Object.fromEntries(files.map(f=>[f,readFileSync(f,'utf8')]));
const prompt='Independent WorkBuddy audit of a correction: ONLY five public learning targets; prior commercial IDs are INTERNAL sources. Existing source data remains untouched; no production writes or deployment authorized this round. Review source entitlements independently of hidden source availability, expiry/revocation, metadata leaks, private original text isolation, idempotent incremental memberships, and legacy Kaoyan/private FSRS continuity. No commercial originals or learner data are provided. Model findings are proposals, never automatic database changes. General IELTS word recall uses Zhenjing priority, Wang Lu alternatives preserved; no unsupported semantic quality claims. CET4/Kaoyan additions require pinned independent exact ECDICT tags. Return ONLY JSON {"verdict":"pass"|"needs_changes","findings":[{"severity":"high"|"medium"|"low","file":"...","issue":"...","fix":"..."}]}.\n'+Object.entries(code).map(([f,s])=>'FILE '+f+'\n'+s).join('\n');
writeFileSync(resolve(root,'five-exam-workbuddy.prompt.txt'),prompt);
writeFileSync(resolve(root,'five-exam-workbuddy-request.json'),JSON.stringify({prompt_sha256:sha256(prompt),code_sha256:Object.fromEntries(Object.entries(code).map(([k,v])=>[k,sha256(v)]))},null,2));
console.log('Prepared code-only prompt for current WorkBuddy MCP. Save its structured output as five-exam-workbuddy-model.json; validate with --validate. Model findings never authorize writes.');
