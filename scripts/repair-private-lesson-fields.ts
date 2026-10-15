import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {lessonExercisePlanSchema} from '../shared/toolContracts.js';
import {safeParseLessonGenerationForPlan} from '../server/services/deepseek.js';
import {lessonCacheHash,lessonGenerationCacheKey,savePrivateLessonCache,PERSONAL_KAOYAN_SET_ID,LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION} from '../server/services/lessonGenerationCache.js';
import {readArgs,requireStagingEnvironment,loadWordsAndMembership,readJsonl,buildPrivateUnionWork,runCodeBuddy,outputJsonSchema,assertOfflineLessonQuality} from './import-anki-lesson-cache.js';
import {prepare} from './complete-anki-lesson-batches.js';

async function atomic(path:string,value:unknown){await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
async function main(){
 const args=readArgs(process.argv.slice(2));requireStagingEnvironment();
 const dir=resolve(args.privateDataDir),rawDir=resolve(dir,'field-repairs');await mkdir(rawDir,{recursive:true,mode:0o700});
 const fixes=[{word:'bolster',field:'example_zh' as const,reason:'first-year teachers means teachers in their first year of teaching, not teachers of grade one. Correct only the Chinese translation while preserving the English sentence.'},{word:'boil',field:'note' as const,reason:'The generated note incorrectly defines noun boil as boiling point. Explain the noun as boiling or a skin swelling as appropriate; the temperature boiling point is not noun boil. Do not alter the saved dictionary meaning.'}];
 const audit:{word:string;revised:number;calls:number;input_tokens:number|null;output_tokens:number|null}[]=[];
 await withUserIdentity(args.userId,async()=>{
  const db=getDatabase(),lookup=await loadWordsAndMembership(db,args.userId);
  if(!lookup.hasFullUnion||lookup.wordRows.length!==7048)throw Error('PRIVATE_UNION_MEMBERSHIP_MISMATCH');
  if(!args.materialsJsonl)throw Error('EXTRACTED_SOURCE_REQUIRED');
  const work=buildPrivateUnionWork(await readJsonl(args.materialsJsonl),lookup.wordRows);
  for(const fix of fixes){
   const w=work.entries.find(x=>x.record.normalized_word===fix.word);if(!w)throw Error('WORD_NOT_FOUND');
   if(w.material[fix.field])throw Error('ANKI_VALID_FIELD_REPAIR_FORBIDDEN');
   const p=prepare(w,args.userId,args),materialHash=p.usedAnki?await lessonCacheHash(w.material):null;
   const q=await db.from('lesson_generation_cache').select('*').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('word_id',w.row.id).eq('cache_kind','lesson').eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('source_version',p.sourceVersion).eq('is_valid',true);
   if(q.error)throw Error('REPAIR_CACHE_READ_FAILED');
   const sourceKey=(await lessonGenerationCacheKey(p.context,materialHash,p.sourceVersion)).cacheKey;
   const rows=q.data??[],source=rows.find(r=>r.cache_key===sourceKey);if(!source)throw Error('QUICK_SOURCE_NOT_FOUND');
   const oldValue=source.lesson_payload[fix.field];
   const existingAudit=resolve(rawDir,'repair-audit.json');
   if(fix.word==='bolster'&&existsSync(existingAudit)&&JSON.parse(await readFile(existingAudit,'utf8')).results?.some((x:{word:string;revised:number})=>x.word===fix.word&&x.revised>0)&&!oldValue.includes('一年级')){console.log(JSON.stringify({word:fix.word,status:'already_repaired'}));continue;}
   const task=await lessonCacheHash({word:fix.word,field:fix.field,oldValue,reason:fix.reason,content_version:LESSON_CACHE_CONTENT_VERSION,prompt_version:LESSON_CACHE_PROMPT_VERSION,model:args.codebuddyModel,effort:'low'});
   const rawPath=resolve(rawDir,task+'.json');let response:Awaited<ReturnType<typeof runCodeBuddy>>,calls=0;
   let unwrapped:Record<string,unknown>|null=null;try{const nested=JSON.parse(oldValue);if(nested&&typeof nested[fix.field]==='string')unwrapped={[fix.field]:nested[fix.field]};}catch{/* ordinary prose */}
   if(unwrapped){response={result:unwrapped};await atomic(rawPath,{task_id:task,model:args.codebuddyModel,effort:'low',channel:'codebuddy_cli',repair_method:'unwrapped_existing_generated_json_string',response,created_at:new Date().toISOString()});}
   else if(existsSync(rawPath)){response=JSON.parse(await readFile(rawPath,'utf8')).response;}
   else {calls++;response=await runCodeBuddy({command:args.codebuddyCommand,model:args.codebuddyModel,jsonSchema:outputJsonSchema([fix.field],p.context.plan.planned_activity_type),timeoutMs:args.timeoutMs,prompt:JSON.stringify({task:'Repair only the named invalid generated field in private WordLoop lesson. Return schema JSON only; simplified Chinese. Do not output other fields.',word:fix.word,field:fix.field,reason:fix.reason,existing_valid_fields:source.lesson_payload,required_missing_fields:[fix.field]})});await atomic(rawPath,{task_id:task,model:args.codebuddyModel,effort:'low',channel:'codebuddy_cli',response,created_at:new Date().toISOString()});}
   if(Object.keys(response.result).length!==1||typeof response.result[fix.field]!=='string')throw Error('INVALID_REPAIR_FIELDS');
   try{const nested=JSON.parse(response.result[fix.field] as string);if(nested&&typeof nested[fix.field]==='string')response.result[fix.field]=nested[fix.field];}catch{/* ordinary prose */}
   const revised=[];
   for(const row of rows){
    if(row.lesson_payload[fix.field]!==oldValue)continue;
    const plan=lessonExercisePlanSchema.parse({...p.context.plan,...row.plan_context,plan_id:crypto.randomUUID(),exercise_id:crypto.randomUUID()});
    const context={...p.context,lessonProfile:row.lesson_profile,errorFocus:row.error_focus,plan};
    const key=(await lessonGenerationCacheKey(context,materialHash,p.sourceVersion)).cacheKey;if(key!==row.cache_key)throw Error('REPAIR_VARIANT_KEY_MISMATCH');
    const next={...row.lesson_payload,[fix.field]:response.result[fix.field]};
    const parsed=safeParseLessonGenerationForPlan({word:context.word,lesson_profile:context.lessonProfile,error_focus:context.errorFocus,plan},next);if(!parsed.success)throw Error('REPAIR_PLAN_VALIDATION_FAILED');
    assertOfflineLessonQuality(parsed.data,context.word,plan.planned_activity_type);
    await savePrivateLessonCache({db,context,lesson:parsed.data,sourceKind:p.usedAnki?'mixed':'codebuddy_deepseek',generationMethod:'codebuddy_cli',sourceVersion:p.sourceVersion,modelName:args.codebuddyModel,modelEffort:'low',materialPayloadHash:materialHash,codebuddyRequestId:task});
    const old=await db.from('lesson_generation_cache').update({is_valid:false,quality_status:'needs_review',error_code:'SUPERSEDED_AFTER_LANGUAGE_REVIEW',error_summary:'A generated field was corrected through CodeBuddy DeepSeek low; prior payload retained.'}).eq('id',row.id).eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID);
    if(old.error)throw Error('REPAIR_OLD_REVISION_STATUS_FAILED');revised.push(row.id);
   }
   audit.push({word:fix.word,revised:revised.length,calls,input_tokens:response.inputTokens??null,output_tokens:response.outputTokens??null});
   await atomic(resolve(rawDir,'repair-audit.json'),{model:args.codebuddyModel,effort:'low',branch_id:process.env.WORDLOOP_STAGING_NEON_BRANCH_ID,results:audit,actual_cost:'unavailable'});
   console.log(JSON.stringify({word:fix.word,revised:revised.length,calls,input_tokens:response.inputTokens??'unavailable',output_tokens:response.outputTokens??'unavailable'}));
  }
 });
}
main().catch(e=>{console.error(JSON.stringify({status:'failed',code:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'FIELD_REPAIR_FAILED'}));process.exitCode=1;});
