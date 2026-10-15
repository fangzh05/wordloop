import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {lessonExercisePlanSchema} from '../shared/toolContracts.js';
import {safeParseLessonGenerationForPlan} from '../server/services/deepseek.js';
import {LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION,PERSONAL_KAOYAN_SET_ID} from '../server/services/lessonGenerationCache.js';
import {readArgs,requireStagingEnvironment,assertOfflineLessonQuality} from './import-anki-lesson-cache.js';
async function main(){
 const args=readArgs(process.argv.slice(2));requireStagingEnvironment();
 const apply=process.argv[process.argv.indexOf('--apply')+1]==='yes';
 await withUserIdentity(args.userId,async()=>{
  const db=getDatabase(),cutoff=new Date().toISOString();let examined=0;const bad:{id:string;word_id:string;code:string}[]=[];
  // Snapshot IDs before any status update so pagination cannot skip rows.
  for(let offset=0;;offset+=500){
   const q=await db.from('lesson_generation_cache').select('id,word_id,lesson_profile,error_focus,plan_context,lesson_payload,word:words!inner(normalized_word)').eq('user_id',args.userId)
    .eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('cache_kind','lesson').eq('is_valid',true).lte('created_at',cutoff).order('id').range(offset,offset+499);
   if(q.error)throw new Error('AUDIT_CACHE_READ_FAILED');
   for(const row of q.data??[]){examined++;try{
    const plan=lessonExercisePlanSchema.parse({...row.plan_context,plan_id:crypto.randomUUID(),exercise_id:crypto.randomUUID(),estimated_seconds:20,selection_reason:'Offline validation of saved plan context.'});
    const word=(Array.isArray(row.word)?row.word[0]:row.word)?.normalized_word;
    const parsed=safeParseLessonGenerationForPlan({word,lesson_profile:row.lesson_profile,error_focus:row.error_focus,plan},row.lesson_payload);
    if(!parsed.success)throw new Error('LESSON_SCHEMA_INVALID');assertOfflineLessonQuality(parsed.data,word,plan.planned_activity_type);
   }catch(e){bad.push({id:row.id,word_id:row.word_id,code:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'LESSON_SCHEMA_INVALID'});}}
   if((q.data??[]).length<500)break;
  }
  if(apply)for(const row of bad){const q=await db.from('lesson_generation_cache').update({quality_status:'needs_review',is_valid:false,error_code:row.code,error_summary:'Offline validation rejected this historical revision; its payload is preserved.'}).eq('id',row.id).eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID);if(q.error)throw new Error('AUDIT_STATUS_WRITE_FAILED');}
  const errors:Record<string,number>={};for(const row of bad)errors[row.code]=(errors[row.code]??0)+1;
  const report={examined_rows:examined,rejected_revisions:bad.length,affected_words:new Set(bad.map(r=>r.word_id)).size,errors,applied:apply,ai_requests:0,learning_writes:0,checked_at:new Date().toISOString()};
  await writeFile(resolve(args.privateDataDir,'cache-quality-audit.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
 });
}
main().catch(()=>{console.error('PRIVATE_CACHE_AUDIT_FAILED');process.exitCode=1;});
