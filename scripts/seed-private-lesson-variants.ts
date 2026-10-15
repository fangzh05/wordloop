import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {safeParseLessonGenerationForPlan,type LessonGeneration} from '../server/services/deepseek.js';
import {lessonCacheHash,lessonGenerationCacheKey,savePrivateLessonCacheBatch,PERSONAL_KAOYAN_SET_ID,LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION} from '../server/services/lessonGenerationCache.js';
import {readArgs,requireStagingEnvironment,loadWordsAndMembership,readJsonl,buildPrivateUnionWork} from './import-anki-lesson-cache.js';
import {prepare} from './complete-anki-lesson-batches.js';
// Reuse complete teaching fields; construct and validate a separate deterministic recall variant.
// This never changes the runtime planner or treats an old exercise as a matching new plan.
async function main(){
 const args=readArgs(process.argv.slice(2));requireStagingEnvironment();
 if(!args.materialsJsonl)throw new Error('EXTRACTED_SOURCE_REQUIRED');
 const records=await readJsonl(args.materialsJsonl);
 await withUserIdentity(args.userId,async()=>{
  const db=getDatabase(),lookup=await loadWordsAndMembership(db,args.userId),built=buildPrivateUnionWork(records,lookup.wordRows);
  const existing=new Map<string,{cache_key:string;lesson_payload:LessonGeneration;source_kind:'mixed'|'codebuddy_deepseek';source_version:string}>();
  const known=new Set<string>();
  for(let offset=0;;offset+=500){
   const q=await db.from('lesson_generation_cache').select('word_id,cache_key,lesson_profile,lesson_payload,source_kind,source_version').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID)
    .eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('cache_kind','lesson').eq('is_valid',true).order('created_at',{ascending:true}).range(offset,offset+499);
   if(q.error)throw new Error('CACHE_READ_FAILED');
   for(const row of q.data??[]){known.add(row.cache_key);if(row.lesson_profile==='quick_recall'&&['mixed','codebuddy_deepseek'].includes(row.source_kind))existing.set(row.word_id,row);}
   if((q.data??[]).length<500)break;
  }
  let selected=0,validated=0,skipped=0,failed=0;let pending:Parameters<typeof savePrivateLessonCacheBatch>[0]=[];
  for(const work of built.entries){
   const source=existing.get(work.row.id);if(!source)continue;
   const quick=prepare(work,args.userId,{...args,lessonProfile:'quick_recall',activityType:'word_recall',errorFocus:null});
   const hash=quick.usedAnki?await lessonCacheHash(work.material):null;
   if(source.cache_key!==(await lessonGenerationCacheKey(quick.context,hash,quick.sourceVersion)).cacheKey)continue;
   const p=prepare(work,args.userId,{...args,lessonProfile:'reinforce',activityType:'word_recall',errorFocus:null});
   const key=(await lessonGenerationCacheKey(p.context,hash,p.sourceVersion)).cacheKey;
   if(known.has(key)){skipped++;continue;}if(args.limit&&selected>=args.limit)break;selected++;
   const parsed=safeParseLessonGenerationForPlan({word:p.context.word,lesson_profile:'reinforce',error_focus:null,plan:p.context.plan},{...source.lesson_payload,exercise:p.fixed.exercise});
   if(!parsed.success){failed++;continue;}validated++;
   if(!args.dryRun)pending.push({db,context:p.context,lesson:parsed.data,sourceKind:source.source_kind,generationMethod:'codebuddy_cli',sourceVersion:source.source_version,modelName:args.codebuddyModel,modelEffort:'low',materialPayloadHash:hash,codebuddyRequestId:'deterministic-recall-variant:'+key});
   if(pending.length===32){await savePrivateLessonCacheBatch(pending);pending=[];}
  }
  if(pending.length)await savePrivateLessonCacheBatch(pending);
  const report={source_teaching_words:existing.size,selected,validated,skipped_existing:skipped,failed,ai_requests:0,session_writes:0,database_writes:args.dryRun?0:validated,profile:'reinforce',activity:'word_recall',checked_at:new Date().toISOString()};
  await writeFile(resolve(args.privateDataDir,'recall-variant-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
 });
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'VARIANT_FAILED');process.exitCode=1;});
