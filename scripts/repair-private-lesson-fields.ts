import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {lessonExercisePlanSchema} from '../shared/toolContracts.js';
import {safeParseLessonGenerationForPlan} from '../server/services/deepseek.js';
import {lessonCacheHash,lessonGenerationCacheKey,savePrivateLessonCache,PERSONAL_KAOYAN_SET_ID,LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION} from '../server/services/lessonGenerationCache.js';
import {readArgs,requireStagingEnvironment,loadWordsAndMembership,readJsonl,buildPrivateUnionWork,runCodeBuddy,outputJsonSchema,assertOfflineLessonQuality,safeReportPath} from './import-anki-lesson-cache.js';
import {prepare} from './complete-anki-lesson-batches.js';

const MODEL='deepseek-v4.1-flash',VERSION='private-generated-field-repair-v2';
const specification=z.object({word:z.string().trim().min(1),field:z.enum(['note','example_en','example_zh','collocations','derivations']),reason:z.string().trim().min(2).max(1000)}).strict();
type Repair=z.infer<typeof specification>;
type Task={status:'pending'|'completed'|'failed';spec:string;source_id:string;word:string;field:Repair['field'];payload_hash:string;cache_key:string;revised_ids:string[];error_code?:string;updated_at:string};
type Checkpoint={version:string;user_id:string;private_set_id:string;model:string;entries:Record<string,Task>};
async function atomic(path:string,value:unknown){await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
const code=(e:unknown)=>e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'FIELD_REPAIR_FAILED';
const permitted=(row:any)=>(row.is_valid===true&&row.quality_status==='valid')||(row.quality_status==='needs_review'&&/^LANGUAGE_REVIEW(?:_|$)/.test(row.error_code??''));
function expand(value:unknown):Repair[]{
 if(!Array.isArray(value))throw Error('REPAIRS_ARRAY_REQUIRED');
 return value.flatMap((item:any)=>Array.isArray(item.issues)?item.issues.map((issue:any)=>specification.parse({word:item.word,field:issue.field,reason:issue.reason??issue.reason_zh})):[specification.parse({word:item.word,field:item.field,reason:item.reason??item.reason_zh})]);
}
async function main(){
 const argv=process.argv.slice(2),args=readArgs(argv);requireStagingEnvironment();if(args.codebuddyModel!==MODEL)throw Error('REPAIR_REQUIRES_DEEPSEEK_FLASH_LOW');
 const dir=resolve(args.privateDataDir);safeReportPath('repair-report.json',dir);
 const rawDir=resolve(dir,'field-repairs');await mkdir(rawDir,{recursive:true,mode:0o700});
 const cpPath=resolve(rawDir,'repair-v2.checkpoint.json');
 const cp:Checkpoint=existsSync(cpPath)?JSON.parse(await readFile(cpPath,'utf8')):{version:VERSION,user_id:args.userId,private_set_id:PERSONAL_KAOYAN_SET_ID,model:MODEL,entries:{}};
 if(cp.version!==VERSION||cp.user_id!==args.userId||cp.private_set_id!==PERSONAL_KAOYAN_SET_ID||cp.model!==MODEL)throw Error('REPAIR_CHECKPOINT_SCOPE_MISMATCH');
 if(existsSync(cpPath)&&!args.resume)throw Error('REPAIR_CHECKPOINT_REQUIRES_RESUME');
 const repairIndex=argv.indexOf('--repairs');
 const fixes=repairIndex>=0?expand(JSON.parse(await readFile(safeReportPath(argv[repairIndex+1]!,dir)!,'utf8'))):expand([
  {word:'bolster',field:'example_zh',reason:'first-year teachers means teachers in their first year of teaching, not teachers of grade one. Correct only the Chinese translation while preserving the English sentence.'},
  {word:'boil',field:'note',reason:'The generated note incorrectly defines noun boil as boiling point. Explain the noun as boiling or a skin swelling as appropriate; the temperature boiling point is not noun boil. Do not alter the saved dictionary meaning.'},
 ]);
 const stats={selected:0,completed:0,failed:0,skipped_completed:0,calls:0,revised_rows:0,input_tokens:0,output_tokens:0,all_tokens:true,credits:0,all_credits:true,reported_cost:0,all_reported_cost:true};
 const reportPath=safeReportPath(args.report??'repair-report.json',dir)!;
 const report=()=>atomic(reportPath,{version:VERSION,model:MODEL,effort:'low',...stats,input_tokens:stats.all_tokens?stats.input_tokens:'unavailable',output_tokens:stats.all_tokens?stats.output_tokens:'unavailable',codebuddy_credits:stats.all_credits?stats.credits:'unavailable',cli_reported_model_cost_usd:stats.all_reported_cost?stats.reported_cost:'unavailable',actual_cost_usd:'unavailable',updated_at:new Date().toISOString()});
 await withUserIdentity(args.userId,async()=>{
  const db=getDatabase(),lookup=await loadWordsAndMembership(db,args.userId);if(!lookup.hasFullUnion||lookup.wordRows.length!==7048)throw Error('PRIVATE_UNION_MEMBERSHIP_MISMATCH');
  if(!args.materialsJsonl)throw Error('EXTRACTED_SOURCE_REQUIRED');const work=buildPrivateUnionWork(await readJsonl(args.materialsJsonl),lookup.wordRows);
  for(const fix of fixes){if(args.limit&&stats.selected>=args.limit)break;
   const spec=await lessonCacheHash({user_id:args.userId,private_set_id:PERSONAL_KAOYAN_SET_ID,word:fix.word.toLowerCase(),field:fix.field,reason:fix.reason,model:MODEL,prompt:VERSION,content:LESSON_CACHE_CONTENT_VERSION});
   const prior=Object.entries(cp.entries).find(([,entry])=>entry.spec===spec);
   if(prior?.[1].status==='completed'){stats.skipped_completed++;continue;}stats.selected++;
   let taskId=prior?.[0],task=prior?.[1];
   try{
    const w=work.entries.find(x=>x.record.normalized_word===fix.word.toLowerCase());if(!w)throw Error('WORD_NOT_FOUND');
    if(w.material[fix.field]!==undefined)throw Error('ANKI_VALID_FIELD_REPAIR_FORBIDDEN');
    const p=prepare(w,args.userId,{...args,lessonProfile:'quick_recall',activityType:'word_recall',errorFocus:null}),materialHash=p.usedAnki?await lessonCacheHash(w.material):null;
    const q=await db.from('lesson_generation_cache').select('*').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('word_id',w.row.id).eq('cache_kind','lesson').eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('source_version',p.sourceVersion).order('created_at',{ascending:false});if(q.error)throw Error('REPAIR_CACHE_READ_FAILED');
    const rows=q.data??[],sourceKey=(await lessonGenerationCacheKey(p.context,materialHash,p.sourceVersion)).cacheKey;
    // A pending task resumes the original input even after an interrupted insert.
    const source=task?.source_id?rows.find(r=>r.id===task!.source_id):rows.find(r=>r.cache_key===sourceKey&&permitted(r));
    if(!source||source.cache_key!==sourceKey)throw Error('QUICK_SOURCE_NOT_FOUND');
    if(!permitted(source)&&!(task?.source_id===source.id&&source.error_code==='SUPERSEDED_AFTER_LANGUAGE_REVIEW'))throw Error('SOURCE_REVIEW_REASON_NOT_PERMITTED');
    if(await lessonCacheHash(source.lesson_payload)!==source.payload_hash)throw Error('REPAIR_PAYLOAD_HASH_MISMATCH');
    const oldValue=source.lesson_payload[fix.field];
    if(task&&!task.source_id){if(taskId)delete cp.entries[taskId];task=undefined;taskId=undefined;}
    taskId??=await lessonCacheHash({spec,user_id:args.userId,private_set_id:PERSONAL_KAOYAN_SET_ID,cache_key:sourceKey,payload_hash:source.payload_hash,model:MODEL,prompt_version:LESSON_CACHE_PROMPT_VERSION,repair_prompt:VERSION,review_reason:fix.reason});
    const rawPath=resolve(rawDir,taskId+'.json');
    task??={status:'pending',spec,source_id:source.id,word:fix.word,field:fix.field,payload_hash:source.payload_hash,cache_key:sourceKey,revised_ids:[],updated_at:new Date().toISOString()};
    if(args.dryRun){console.log(JSON.stringify({word:fix.word,field:fix.field,status:'dry-run',model_calls:0,database_writes:0}));continue;}
    cp.entries[taskId]=task;await atomic(cpPath,cp);
    // The two original repairs already ran before the v2 task ledger existed.
    const legacyPath=resolve(rawDir,'repair-final-audit.json');
    if(repairIndex<0&&!prior&&existsSync(legacyPath)&&JSON.parse(await readFile(legacyPath,'utf8')).repairs?.some((r:any)=>r.word===fix.word&&r.field===fix.field&&r.content_revisions>0)){
     assertOfflineLessonQuality(source.lesson_payload,p.context.word,p.context.plan.planned_activity_type);
     task.status='completed';task.updated_at=new Date().toISOString();await atomic(cpPath,cp);stats.skipped_completed++;continue;
    }
    let response:Awaited<ReturnType<typeof runCodeBuddy>>;
    if(existsSync(rawPath)){const raw=JSON.parse(await readFile(rawPath,'utf8'));if(raw.task_id!==taskId||raw.model!==MODEL||raw.effort!=='low')throw Error('REPAIR_RAW_SCOPE_MISMATCH');response=raw.response;}
    else {stats.calls++;response=await runCodeBuddy({command:args.codebuddyCommand,model:MODEL,jsonSchema:outputJsonSchema([fix.field],p.context.plan.planned_activity_type),timeoutMs:Math.max(args.timeoutMs,300000),prompt:JSON.stringify({task:'Correct only the named invalid AI-generated field in a private WordLoop lesson. Return schema JSON only; simplified Chinese. Do not output or overwrite other fields. Preserve all Anki fields. No invented pronunciations or derivations. Do not change the source dictionary.',word:fix.word,target_sense:p.context.plan.target_sense,field:fix.field,review_reason:fix.reason,existing_valid_fields:source.lesson_payload,required_missing_fields:[fix.field]})});await atomic(rawPath,{task_id:taskId,user_id:args.userId,private_set_id:PERSONAL_KAOYAN_SET_ID,model:MODEL,effort:'low',channel:'codebuddy_cli',response,created_at:new Date().toISOString()});
     if(response.inputTokens!==undefined&&response.outputTokens!==undefined){stats.input_tokens+=response.inputTokens;stats.output_tokens+=response.outputTokens;}else stats.all_tokens=false;if(response.codebuddyCredits!==undefined)stats.credits+=response.codebuddyCredits;else stats.all_credits=false;if(response.modelCostUsd!==undefined)stats.reported_cost+=response.modelCostUsd;else stats.all_reported_cost=false;
    }
    if((response.inputTokens??0)>150000||(response.outputTokens??0)>32000)throw Error('CODEBUDDY_TOKEN_OUTLIER');
    if(Object.keys(response.result).length!==1||!Object.hasOwn(response.result,fix.field))throw Error('INVALID_REPAIR_FIELDS');
    let corrected=response.result[fix.field];
    // CodeBuddy can wrap a field repair once more (as a JSON object or as a
    // one-item array containing that JSON string). Unwrap only these exact
    // shapes; ordinary arrays and prose remain untouched.
    const unwrapNested=(value:unknown):unknown=>{
      if(typeof value==='string'){
        try{return unwrapNested(JSON.parse(value));}catch{return value;}
      }
      if(Array.isArray(value)&&value.length===1&&typeof value[0]==='string'){
        const unwrapped=unwrapNested(value[0]);
        return unwrapped===value[0]?value:unwrapped;
      }
      if(value&&typeof value==='object'&&!Array.isArray(value)){
        const object=value as Record<string,unknown>;
        if(Object.hasOwn(object,fix.field))return object[fix.field];
        if(object.field===fix.field&&Object.hasOwn(object,'value'))return object.value;
      }
      return value;
    };
    corrected=unwrapNested(corrected);
    if(JSON.stringify(corrected)===JSON.stringify(oldValue))throw Error('REPAIR_UNCHANGED_FIELD');
    for(const row of rows){if(task.revised_ids.includes(row.id)||(!permitted(row)&&!(row.id===source.id&&row.error_code==='SUPERSEDED_AFTER_LANGUAGE_REVIEW'))||JSON.stringify(row.lesson_payload[fix.field])!==JSON.stringify(oldValue))continue;
     const plan=lessonExercisePlanSchema.parse({...p.context.plan,...row.plan_context,plan_id:crypto.randomUUID(),exercise_id:crypto.randomUUID()}),context={...p.context,lessonProfile:row.lesson_profile,errorFocus:row.error_focus,plan};
     if((await lessonGenerationCacheKey(context,materialHash,p.sourceVersion)).cacheKey!==row.cache_key)throw Error('REPAIR_VARIANT_KEY_MISMATCH');
     const parsed=safeParseLessonGenerationForPlan({word:context.word,lesson_profile:context.lessonProfile,error_focus:context.errorFocus,plan},{...row.lesson_payload,[fix.field]:corrected});if(!parsed.success)throw Error('REPAIR_PLAN_VALIDATION_FAILED');assertOfflineLessonQuality(parsed.data,context.word,plan.planned_activity_type);
     await savePrivateLessonCache({db,context,lesson:parsed.data,sourceKind:p.usedAnki?'mixed':'codebuddy_deepseek',generationMethod:'codebuddy_cli',sourceVersion:p.sourceVersion,modelName:MODEL,modelEffort:'low',materialPayloadHash:materialHash,codebuddyRequestId:taskId});
     const old=await db.from('lesson_generation_cache').update({is_valid:false,quality_status:'needs_review',error_code:'SUPERSEDED_AFTER_LANGUAGE_REVIEW',error_summary:'A generated field was corrected through CodeBuddy DeepSeek low; prior payload retained.'}).eq('id',row.id).eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID);if(old.error)throw Error('REPAIR_OLD_REVISION_STATUS_FAILED');task.revised_ids.push(row.id);stats.revised_rows++;await atomic(cpPath,cp);
    }
    task.status='completed';delete task.error_code;task.updated_at=new Date().toISOString();await atomic(cpPath,cp);stats.completed++;
   }catch(e){stats.failed++;if(!args.dryRun){taskId??=await lessonCacheHash({spec,phase:'preflight'});task??={status:'failed',spec,source_id:'',word:fix.word,field:fix.field,payload_hash:'unavailable',cache_key:'unavailable',revised_ids:[],updated_at:new Date().toISOString()};task.status='failed';task.error_code=code(e);task.updated_at=new Date().toISOString();cp.entries[taskId]=task;await atomic(cpPath,cp);}console.error(JSON.stringify({word:fix.word,field:fix.field,status:'failed',code:code(e)}));await report();if(['CODEBUDDY_AUTH','CODEBUDDY_QUOTA','CODEBUDDY_RATE_LIMIT','CODEBUDDY_TOKEN_OUTLIER','CODEBUDDY_COMMAND_TOO_LONG'].includes(code(e))){await writeFile(resolve(dir,'STOP_AFTER_BATCH'),JSON.stringify({code:code(e),source:'field-repair',at:new Date().toISOString()}),{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});throw e;}}
   await report();
  }
 });await report();console.log(JSON.stringify({phase:'finished',...stats}));
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',code:code(e)}));process.exitCode=1;});
