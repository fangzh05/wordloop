// CLI only; no WorkBuddy MCP, no original commercial text, no model mutations.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {privateDataRoot} from './lib/privateDataPath.js';
import {candidateReview,reviewResult} from './lib/deepExamImport.js';
import {sha256} from './lib/examBooks.js';
const root=privateDataRoot(process.argv[2]),cli=process.argv[3];if(!cli||!existsSync(cli))throw Error('Installed CodeBuddy entrypoint argument required');
const entrypoint:string=cli;
export function modelJson(raw:string){
 const envelope=z.array(z.record(z.string(),z.unknown())).parse(JSON.parse(raw));
 const r=envelope.find(x=>x.type==='result');if(!r||r.is_error||typeof r.result!=='string')throw Error('CodeBuddy failed');
 const text=r.result.replace(/^```json\s*/,'').replace(/\s*```$/,'');return JSON.parse(text);
}
async function request(prompt:string,kind:'candidate'|'code',allowed:string[]=[]){
 const key=sha256(prompt),rawPath=resolve(root,`codebuddy-${kind}-${key}.raw.json`);
 if(!existsSync(rawPath)){
  let last:unknown;
  for(let attempt=0;attempt<3;attempt++){
   try{const raw=await new Promise<string>((yes,no)=>{
    const child=spawn(process.execPath,[entrypoint,'-p','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--output-format','json'],{cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='';const timer=setTimeout(()=>{child.kill();no(Error('CodeBuddy CLI timeout'));},240000);
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',no);child.on('close',code=>{clearTimeout(timer);code===0?yes(out):no(Error(`CodeBuddy exit ${code}: ${err.slice(0,500)}`));});child.stdin.end(prompt);
   });modelJson(raw);writeFileSync(rawPath,raw);break;}catch(e){last=e;writeFileSync(resolve(root,`codebuddy-${kind}-${key}-error-${attempt}.txt`),String(e));if(attempt===2)throw last;}
  }
 }
 const parsed=modelJson(readFileSync(rawPath,'utf8'));
 const validated=kind==='candidate'?candidateReview.parse(parsed):reviewResult.parse(parsed);
 if('records' in validated&&(validated.records.length!==allowed.length||new Set(validated.records.map(r=>r.word)).size!==allowed.length||validated.records.some(r=>!allowed.includes(r.word))))throw Error('Model changed candidate identities or omitted rows');
 writeFileSync(resolve(root,`codebuddy-${kind}-${key}.validated.json`),JSON.stringify({prompt_sha256:key,suggestions_only:true,original_definitions_sent:false,...validated},null,2));
 return validated;
}
const queue=z.array(z.object({word:z.string(),source:z.string(),reason:z.string()})).parse(JSON.parse(readFileSync(resolve(root,'review-queue.json'),'utf8')));
// Bounded diagnostic samples; every unreviewed record stays held. No confidence-based promotion.
const sample=[...new Map(queue.filter(q=>q.reason!=='derived_source_requires_relevance_review').map(q=>[q.word,q])).values()].slice(0,60);
await request('审核雅思/托福候选词头，不查阅外部工具。没有释义或商业原文。不要自动更改身份，只给建议。派生词独立保留，词形变化只关联；明确拼写错误reject，不确定hold，词头真实且合理retain。返回严格JSON {"records":[{"word":"输入原词","decision":"retain|hold|reject","reason":"说明"}]}，逐条覆盖。候选：'+JSON.stringify(sample),'candidate',sample.map(s=>s.word));
const files=['scripts/lib/deepExamImport.ts','scripts/lib/deepExamSql.ts','scripts/lib/privateBookImport.ts','scripts/replay-deep-exam-import.ts','supabase/migrations/20261012030000_deep_exam_internal_sources.sql'];
await request('只审计下面代码，不调用工具。仅本地隔离测试，不发布；商业原文隔离、服务端独立权限，布尔私人使用声明并不代表出版授权，testOnly=false始终抛错，不发放生产entitlement。目录名称不能作为商业意图证据。已有exam_book_words的PRIMARY KEY(book_id,normalized_word)已安装且实测，唯一词头不可能重复。旧sql属性保留兼容测试，新的transaction_sql有事务，实际replay用参数绑定和每书事务。KyleBing两个仓库固定注册为同源，未有ECdict证据词头须不同来源家族佐证；同仓库重复书籍不算独立。找可验证漏洞，不提假设已有保护不存在的问题，输出严格JSON {"verdict":"pass|needs_changes","findings":[{"risk":"具体代码风险","recommendation":"修复"}]}。\n'+files.map(f=>f+'\n'+readFileSync(f,'utf8')).join('\n'),'code');
console.log('CodeBuddy CLI audit saved; model suggestions did not change the import plan.');
