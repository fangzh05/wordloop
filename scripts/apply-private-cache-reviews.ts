import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {lessonGenerationSchema,safeParseLessonGenerationForPlan} from '../server/services/deepseek.js';
import {readArgs,requireStagingEnvironment,loadWordsAndMembership,readJsonl,buildPrivateUnionWork} from './import-anki-lesson-cache.js';
import {prepare} from './complete-anki-lesson-batches.js';
import {savePrivateLessonCache,lessonGenerationCacheKey,lessonCacheHash,ANKI_SOURCE_VERSION,PERSONAL_KAOYAN_SET_ID} from '../server/services/lessonGenerationCache.js';
// Removes only explicitly reviewed generated array items. Existing source material is immutable.
async function main(){
 const args=readArgs(process.argv.slice(2));requireStagingEnvironment();
 const index=process.argv.indexOf('--corrections');if(index<0||!args.materialsJsonl)throw new Error('REVIEW_INPUT_REQUIRED');
 const corrections=JSON.parse(await readFile(process.argv[index+1]!,'utf8')) as {word:string;field:'collocations'|'derivations';remove:string[]}[];
 const records=await readJsonl(args.materialsJsonl);
 await withUserIdentity(args.userId,async()=>{
  const db=getDatabase(),lookup=await loadWordsAndMembership(db,args.userId),built=buildPrivateUnionWork(records,lookup.wordRows);
  let revised=0;
  for(const c of corrections){
   if(!['collocations','derivations'].includes(c.field)||!c.remove.every(x=>typeof x==='string'))throw new Error('INVALID_REVIEW');
   const work=built.entries.find(e=>e.record.normalized_word===c.word);if(!work)throw new Error('REVIEW_WORD_OUTSIDE_UNION');
   if(work.material[c.field]?.length)throw new Error('REVIEW_MUST_NOT_REMOVE_ANKI_FIELDS');
   const p=prepare(work,args.userId,args),hash=p.usedAnki?await lessonCacheHash(work.material):null;
   const key=(await lessonGenerationCacheKey(p.context,hash,p.sourceVersion)).cacheKey;
   const q=await db.from('lesson_generation_cache').select('id,lesson_payload').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('cache_key',key).eq('is_valid',true).order('created_at',{ascending:false}).limit(1).maybeSingle();
   if(q.error||!q.data)throw new Error('REVIEW_CACHE_READ_FAILED');
   const old=lessonGenerationSchema.parse(q.data.lesson_payload);
   const lesson={...old,[c.field]:old[c.field].filter(x=>!c.remove.some(r=>x.toLowerCase().includes(r.toLowerCase())))};
   if(lesson[c.field].length===old[c.field].length)continue;
   const checked=safeParseLessonGenerationForPlan({word:p.context.word,lesson_profile:args.lessonProfile,error_focus:p.context.errorFocus,plan:p.context.plan},lesson);
   if(!checked.success)throw new Error('REVIEW_REVISION_INVALID');
   await savePrivateLessonCache({db,context:p.context,lesson:checked.data,sourceKind:p.usedAnki?'mixed':'codebuddy_deepseek',generationMethod:'codebuddy_cli',sourceVersion:p.sourceVersion,modelName:args.codebuddyModel,modelEffort:'low',materialPayloadHash:hash});
   const updated=await db.from('lesson_generation_cache').update({is_valid:false,quality_status:'needs_review',error_code:'SUPERSEDED_AFTER_LANGUAGE_REVIEW',error_summary:'A reviewed low-value generated item was removed in a newer validated revision.'}).eq('id',q.data.id).eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID);
   if(updated.error)throw new Error('REVIEW_STATUS_WRITE_FAILED');revised++;
  }
  console.log(JSON.stringify({reviewed:corrections.length,revised,ai_requests:0,learning_writes:0}));
 });
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'REVIEW_FAILED');process.exitCode=1;});
