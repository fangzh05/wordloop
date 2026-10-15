import {readFile,writeFile,rename,mkdir,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {lessonCacheHash,lessonGenerationCacheKey,PERSONAL_KAOYAN_SET_ID,LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION} from '../server/services/lessonGenerationCache.js';
import {readArgs,requireStagingEnvironment,loadWordsAndMembership,readJsonl,buildPrivateUnionWork,runCodeBuddy,safeReportPath} from './import-anki-lesson-cache.js';
import {prepare} from './complete-anki-lesson-batches.js';

const MODEL='deepseek-v4.1-flash',REVIEW_VERSION='private-language-review-v1';
const fields=['note','example_en','example_zh','collocations','derivations'] as const;
const issueSchema=z.object({field:z.enum(fields),reason_zh:z.string().trim().min(2).max(300)}).strict();
const reviewSchema=z.object({issues:z.array(issueSchema).max(10),status:z.enum(['pass','needs_review'])}).strict().superRefine((x,c)=>{
 if((x.status==='pass')!==(x.issues.length===0))c.addIssue({code:'custom',message:'Review status must agree with issues.'});
});
type Review=z.infer<typeof reviewSchema>;
type Entry={status:'pending'|'pass'|'needs_review'|'failed';word_id:string;cache_key:string;payload_hash:string;review?:Review;error_code?:string;applied?:boolean;attempt_count?:number;updated_at:string};
type Checkpoint={review_version:string;model:string;effort:'low';user_id:string;private_set_id:string;entries:Record<string,Entry>};
async function atomic(path:string,value:unknown){await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
const errorCode=(e:unknown)=>e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'LANGUAGE_REVIEW_FAILED';
async function main(){
 const argv=process.argv.slice(2),args=readArgs(argv);requireStagingEnvironment();
 if(args.codebuddyModel!==MODEL)throw Error('REVIEW_REQUIRES_DEEPSEEK_FLASH_LOW');
 const batchIndex=argv.indexOf('--batch-size'),batchSize=batchIndex<0?32:Number(argv[batchIndex+1]);
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>32)throw Error('INVALID_REVIEW_BATCH_SIZE');
 const applyIndex=argv.indexOf('--apply'),applyValue=applyIndex<0?'no':argv[applyIndex+1]??'';
 if(!['yes','no'].includes(applyValue))throw Error('INVALID_APPLY_MODE');const apply=applyValue==='yes';
 const applyOnlyIndex=argv.indexOf('--apply-only'),applyOnly=applyOnlyIndex>=0&&argv[applyOnlyIndex+1]==='yes';
 if(applyOnly&&!apply)throw Error('APPLY_ONLY_REQUIRES_APPLY');
 if(apply&&args.dryRun)throw Error('DRY_RUN_CANNOT_APPLY');
 if(!args.materialsJsonl)throw Error('EXTRACTED_SOURCE_REQUIRED');
 const dir=resolve(args.privateDataDir);safeReportPath('language-review-report.json',dir);
 const rawDir=resolve(dir,'language-review-raw');await mkdir(rawDir,{recursive:true,mode:0o700});
 const cpPath=resolve(dir,'language-review.checkpoint.json'),reportPath=safeReportPath(args.report??'language-review-report.json',dir)!;
 const cp:Checkpoint=existsSync(cpPath)?JSON.parse(await readFile(cpPath,'utf8')):{review_version:REVIEW_VERSION,model:MODEL,effort:'low',user_id:args.userId,private_set_id:PERSONAL_KAOYAN_SET_ID,entries:{}};
 if(cp.review_version!==REVIEW_VERSION||cp.model!==MODEL||cp.effort!=='low'||cp.user_id!==args.userId||cp.private_set_id!==PERSONAL_KAOYAN_SET_ID)throw Error('REVIEW_CHECKPOINT_SCOPE_MISMATCH');
 if(existsSync(cpPath)&&!args.resume)throw Error('REVIEW_CHECKPOINT_REQUIRES_RESUME');
 const stats={calls:0,model_retries:0,raw_hits:0,reviewed:0,failed:0,marked_rows:0,input_tokens:0,output_tokens:0,all_tokens:true,credits:0,all_credits:true,cli_reported_cost_usd:0,all_reported_cost:true,selected:0,batch_size:batchSize};
 const report=async()=>{const entries=Object.values(cp.entries);await atomic(reportPath,{review_version:REVIEW_VERSION,model:MODEL,effort:'low',private_set_id:PERSONAL_KAOYAN_SET_ID,apply,...stats,input_tokens:stats.all_tokens?stats.input_tokens:'unavailable',output_tokens:stats.all_tokens?stats.output_tokens:'unavailable',codebuddy_credits:stats.all_credits?stats.credits:'unavailable',cli_reported_model_cost_usd:stats.all_reported_cost?stats.cli_reported_cost_usd:'unavailable',actual_cost_usd:'unavailable',total_pass:entries.filter(e=>e.status==='pass').length,total_needs_review:entries.filter(e=>e.status==='needs_review').length,total_failed:entries.filter(e=>e.status==='failed').length,updated_at:new Date().toISOString()});};
 const recovered=new Map<string,unknown>();
 for(const name of await readdir(rawDir)){if(!name.endsWith('.json'))continue;try{const raw=JSON.parse(await readFile(resolve(rawDir,name),'utf8'));if(raw.model!==MODEL||raw.review_version!==REVIEW_VERSION||raw.user_id!==args.userId||raw.private_set_id!==PERSONAL_KAOYAN_SET_ID)continue;for(const [fingerprint,id] of Object.entries(raw.items??{})){const parsed=reviewSchema.safeParse(raw.response?.result?.[id as string]);if(parsed.success)recovered.set(fingerprint,parsed.data);}}catch{/* invalid raw is preserved for audit, never used as a retry result */}}
 let interrupted=false;process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
 await withUserIdentity(args.userId,async()=>{
  const db=getDatabase(),lookup=await loadWordsAndMembership(db,args.userId);if(!lookup.hasFullUnion||lookup.wordRows.length!==7048)throw Error('PRIVATE_UNION_MEMBERSHIP_MISMATCH');
  const work=buildPrivateUnionWork(await readJsonl(args.materialsJsonl!),lookup.wordRows);
  const rows:any[]=[];
  for(let offset=0;;offset+=500){const q=await db.from('lesson_generation_cache').select('*').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('cache_kind','lesson').eq('lesson_profile','quick_recall').eq('planned_activity_type','word_recall').eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('quality_status','valid').eq('is_valid',true).order('created_at',{ascending:true}).order('id',{ascending:true}).range(offset,offset+499);if(q.error)throw Error('REVIEW_CACHE_READ_FAILED');rows.push(...(q.data??[]));if((q.data??[]).length<500)break;}
  const byKey=new Map(rows.map(row=>[row.cache_key,row]));
  const selected:{row:any;fingerprint:string;word:string}[]=[];
  for(const w of work.entries){const p=prepare(w,args.userId,{...args,lessonProfile:'quick_recall',activityType:'word_recall',errorFocus:null}),hash=p.usedAnki?await lessonCacheHash(w.material):null,key=(await lessonGenerationCacheKey(p.context,hash,p.sourceVersion)).cacheKey,row=byKey.get(key);if(!row)continue;
   if(await lessonCacheHash(row.lesson_payload)!==row.payload_hash)throw Error('REVIEW_PAYLOAD_HASH_MISMATCH');
   const fingerprint=await lessonCacheHash({user_id:args.userId,private_set_id:PERSONAL_KAOYAN_SET_ID,word_id:w.row.id,cache_key:key,payload_hash:row.payload_hash,review_version:REVIEW_VERSION,model:MODEL,effort:'low'});
   const prior=cp.entries[fingerprint];if(applyOnly&&!prior?.review)continue;if(prior?.status==='failed'&&!args.retryFailed)continue;if(prior?.status==='pass'||(prior?.status==='needs_review'&&(!apply||prior.applied)))continue;
   selected.push({row,fingerprint,word:w.record.display_word});if(args.limit&&selected.length>=args.limit)break;
  }
  // An interrupted apply may have marked the source before a later variant failed.
  // Resume from that exact reviewed payload, never from a newly generated revision.
  if(apply){for(const [fingerprint,entry] of Object.entries(cp.entries)){
   if(args.limit&&selected.length>=args.limit)break;
   if(!entry.review||entry.review.status!=='needs_review'||entry.applied||selected.some(i=>i.fingerprint===fingerprint)||(entry.status==='failed'&&!args.retryFailed))continue;
   const w=work.entries.find(i=>i.row.id===entry.word_id);if(!w)continue;
   const p=prepare(w,args.userId,{...args,lessonProfile:'quick_recall',activityType:'word_recall',errorFocus:null}),materialHash=p.usedAnki?await lessonCacheHash(w.material):null;
   if((await lessonGenerationCacheKey(p.context,materialHash,p.sourceVersion)).cacheKey!==entry.cache_key)continue;
   const q=await db.from('lesson_generation_cache').select('*').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('word_id',entry.word_id).eq('cache_kind','lesson').eq('cache_key',entry.cache_key).eq('payload_hash',entry.payload_hash).eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('quality_status','needs_review').eq('error_code','LANGUAGE_REVIEW_FLAGGED').limit(1).maybeSingle();
   if(q.error)throw Error('REVIEW_APPLY_RECOVERY_READ_FAILED');
   if(q.data&&await lessonCacheHash(q.data.lesson_payload)===entry.payload_hash)selected.push({row:q.data,fingerprint,word:w.record.display_word});
  }}
  stats.selected=selected.length;if(args.dryRun){console.log(JSON.stringify({phase:'dry-run',selected:selected.length,model_calls:0,database_writes:0}));await report();return;}
  const consume=async(item:typeof selected[number],value:unknown,infrastructureError?:string)=>{try{
   if(infrastructureError)throw Error(infrastructureError);
   const parsedReview=reviewSchema.safeParse(value);if(!parsedReview.success)throw Error('REVIEW_SCHEMA_INVALID');
   const result=parsedReview.data;let applied=false;
   if(apply&&result.status==='needs_review'){
    const variants=await db.from('lesson_generation_cache').select('id,lesson_payload').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('word_id',item.row.word_id).eq('cache_kind','lesson').eq('target_sense',item.row.target_sense).eq('source_version',item.row.source_version).eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('is_valid',true);if(variants.error)throw Error('REVIEW_VARIANT_READ_FAILED');
    for(const variant of variants.data??[]){if(!result.issues.some(issue=>JSON.stringify(variant.lesson_payload[issue.field])===JSON.stringify(item.row.lesson_payload[issue.field])))continue;
     const mark=await db.from('lesson_generation_cache').update({is_valid:false,quality_status:'needs_review',error_code:'LANGUAGE_REVIEW_FLAGGED',error_summary:'Offline CodeBuddy DeepSeek low flagged generated teaching fields; see private review checkpoint.',updated_at:new Date().toISOString()}).eq('id',variant.id).eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('is_valid',true);if(mark.error)throw Error('REVIEW_STATUS_WRITE_FAILED');stats.marked_rows++;
    }applied=true;
   }
   cp.entries[item.fingerprint]={status:result.status,word_id:item.row.word_id,cache_key:item.row.cache_key,payload_hash:item.row.payload_hash,review:result,applied,attempt_count:cp.entries[item.fingerprint]?.attempt_count??0,updated_at:new Date().toISOString()};stats.reviewed++;
  }catch(e){const parsed=reviewSchema.safeParse(value);cp.entries[item.fingerprint]={status:'failed',word_id:item.row.word_id,cache_key:item.row.cache_key,payload_hash:item.row.payload_hash,...(parsed.success?{review:parsed.data}:{}),attempt_count:cp.entries[item.fingerprint]?.attempt_count??0,error_code:errorCode(e),updated_at:new Date().toISOString()};stats.failed++;}await atomic(cpPath,cp);return cp.entries[item.fingerprint]!.status!=='failed';};
  const consumeSaved=async(item:typeof selected[number],value:Review)=>{for(let n=0;n<=args.maxRetries&&!interrupted&&!existsSync(resolve(dir,'STOP_AFTER_BATCH'));n++){if(await consume(item,value))return;await new Promise(r=>setTimeout(r,Math.min(750*2**n,4000)));}};
  const queue:typeof selected=[];
  for(const item of selected){const prior=cp.entries[item.fingerprint];if(prior?.review){await consumeSaved(item,prior.review);continue;}if(recovered.has(item.fingerprint)){const parsed=reviewSchema.safeParse(recovered.get(item.fingerprint));if(parsed.success){await consumeSaved(item,parsed.data);stats.raw_hits++;continue;}recovered.delete(item.fingerprint);}queue.push(item);}
  const runAttempts=new Map<string,number>();
  while(queue.length&&!interrupted&&!existsSync(resolve(dir,'STOP_AFTER_BATCH'))){const batch=queue.splice(0,batchSize);
   const itemSchema={type:'object',additionalProperties:false,required:['issues','status'],properties:{status:{type:'string',enum:['pass','needs_review']},issues:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['field','reason_zh'],properties:{field:{type:'string',enum:[...fields]},reason_zh:{type:'string',minLength:2,maxLength:300}}}}}};
   const schema=JSON.stringify({type:'object',additionalProperties:false,$defs:{item:itemSchema},properties:Object.fromEntries(batch.map(i=>[i.row.word_id,{$ref:'#/$defs/item'}])),required:batch.map(i=>i.row.word_id)});
   const feedback=batch.map(i=>({word_id:i.row.word_id,error:cp.entries[i.fingerprint]?.error_code??null,attempt:(cp.entries[i.fingerprint]?.attempt_count??0)+1}));
   const prompt='重试格式反馈：'+JSON.stringify(feedback)+'\n你是WordLoop私有英语教学资料的语言质量审校员。仅输出符合Schema的JSON，不改写教学内容。按word_id逐条审核拼写字母数量、发音说明、词性、派生关系、中文核心义与英中例句语义一致性、搭配自然性。仅报告确定且具体的错误；不确定的争议不报错，不因通常15–25词的软性长度建议标错，不机械要求每义都有例句。原字典义项供参照不得要求改写源词典。字段无错误则status=pass且issues=[]，有确定错误则needs_review并列字段及简体中文短原因。禁止额外字段、Markdown及前言。\n'+batch.map(i=>JSON.stringify({word_id:i.row.word_id,word:i.word,target_sense:i.row.target_sense,...Object.fromEntries(fields.map(f=>[f,i.row.lesson_payload[f]]))})).join('\n');
   try{for(const item of batch){runAttempts.set(item.fingerprint,(runAttempts.get(item.fingerprint)??0)+1);const prior=cp.entries[item.fingerprint];cp.entries[item.fingerprint]={status:'pending',word_id:item.row.word_id,cache_key:item.row.cache_key,payload_hash:item.row.payload_hash,attempt_count:(prior?.attempt_count??0)+1,updated_at:new Date().toISOString()};}await atomic(cpPath,cp);
    stats.calls++;const response=await runCodeBuddy({command:args.codebuddyCommand,model:MODEL,prompt,jsonSchema:schema,timeoutMs:Math.max(args.timeoutMs,300000)});
    const task=await lessonCacheHash({fingerprints:batch.map(i=>i.fingerprint),schema,prompt,review_version:REVIEW_VERSION});await atomic(resolve(rawDir,task+'.json'),{review_version:REVIEW_VERSION,user_id:args.userId,private_set_id:PERSONAL_KAOYAN_SET_ID,model:MODEL,effort:'low',channel:'codebuddy_cli',items:Object.fromEntries(batch.map(i=>[i.fingerprint,i.row.word_id])),response,created_at:new Date().toISOString()});
    if(response.inputTokens!==undefined&&response.outputTokens!==undefined){stats.input_tokens+=response.inputTokens;stats.output_tokens+=response.outputTokens;}else stats.all_tokens=false;
    if(response.codebuddyCredits!==undefined)stats.credits+=response.codebuddyCredits;else stats.all_credits=false;
    if(response.modelCostUsd!==undefined)stats.cli_reported_cost_usd+=response.modelCostUsd;else stats.all_reported_cost=false;
    if((response.inputTokens??0)>150000||(response.outputTokens??0)>32000)throw Error('CODEBUDDY_TOKEN_OUTLIER');
    for(const item of batch){const parsed=reviewSchema.safeParse(response.result[item.row.word_id]);if(parsed.success){recovered.set(item.fingerprint,parsed.data);await consumeSaved(item,parsed.data);}else{recovered.delete(item.fingerprint);await consume(item,response.result[item.row.word_id]);}}
   }catch(e){stats.all_tokens=false;stats.all_credits=false;stats.all_reported_cost=false;for(const item of batch){if(['pass','needs_review'].includes(cp.entries[item.fingerprint]?.status??''))continue;await consume(item,undefined,errorCode(e));}await report();if(['CODEBUDDY_AUTH','CODEBUDDY_QUOTA','CODEBUDDY_RATE_LIMIT','CODEBUDDY_TOKEN_OUTLIER','CODEBUDDY_COMMAND_TOO_LONG'].includes(errorCode(e))){await writeFile(resolve(dir,'STOP_AFTER_BATCH'),JSON.stringify({code:errorCode(e),source:'language-review',at:new Date().toISOString()}),{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});throw e;}}
   const again=batch.filter(item=>cp.entries[item.fingerprint]?.status==='failed'&&!cp.entries[item.fingerprint]?.review&&(runAttempts.get(item.fingerprint)??0)<=args.maxRetries);
   if(again.length){stats.model_retries+=again.length;queue.push(...again);const attempt=Math.max(...again.map(i=>runAttempts.get(i.fingerprint)??1));await new Promise(r=>setTimeout(r,Math.min(1000*2**(attempt-1),8000)));}
   await report();console.log(JSON.stringify({phase:'review-progress',reviewed:stats.reviewed,failed:stats.failed,calls:stats.calls,marked_rows:stats.marked_rows}));
  }
 });await report();console.log(JSON.stringify({phase:interrupted||existsSync(resolve(dir,'STOP_AFTER_BATCH'))?'interrupted':'finished',...stats}));
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',code:errorCode(e)}));process.exitCode=1;});
