import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {findCachedLesson,LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION,PERSONAL_KAOYAN_SET_ID} from '../server/services/lessonGenerationCache.js';
import {readArgs,requireStagingEnvironment,loadWordsAndMembership,readJsonl,buildPrivateUnionWork} from './import-anki-lesson-cache.js';
import {prepare} from './complete-anki-lesson-batches.js';

// Reads staging cache only; never creates sessions or invokes a model.
async function main(){
 const args=readArgs(process.argv.slice(2));requireStagingEnvironment();
 if(!args.materialsJsonl)throw new Error('EXTRACTED_SOURCE_REQUIRED');
 const records=await readJsonl(args.materialsJsonl);
 await withUserIdentity(args.userId,async()=>{
  const db=getDatabase(),lookup=await loadWordsAndMembership(db,args.userId);
  const work=buildPrivateUnionWork(records,lookup.wordRows);
  const valid=new Set<string>();
  for(let offset=0;;offset+=500){
   const q=await db.from('lesson_generation_cache').select('word_id').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID)
    .eq('content_version',LESSON_CACHE_CONTENT_VERSION).eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('cache_kind','lesson').eq('is_valid',true).order('word_id').range(offset,offset+499);
   if(q.error)throw new Error('CACHE_READ_FAILED');for(const row of q.data??[])valid.add(row.word_id);if((q.data??[]).length<500)break;
  }
  const candidates=work.entries.filter(e=>valid.has(e.row.id));
  const sample=candidates.filter((_,i)=>i%Math.max(1,Math.floor(candidates.length/(args.limit??20)))===0).slice(0,args.limit??20);
  let hits=0,crossSessionHits=0,mismatchHits=0;
  for(const row of sample){
   const {context}=prepare(row,args.userId,args);
   if((await findCachedLesson(db,context)).lesson)hits++;
   const next={...context,plan:{...context.plan,plan_id:crypto.randomUUID(),exercise_id:crypto.randomUUID()}};
   if((await findCachedLesson(db,next)).lesson)crossSessionHits++;
   if((await findCachedLesson(db,{...context,errorFocus:'spelling',plan:{...context.plan,error_focus:'spelling'}})).lesson)mismatchHits++;
  }
  const report={private_union_words:work.entries.length,valid_word_coverage:valid.size,sampled:sample.length,hits,cross_session_hits:crossSessionHits,mismatched_condition_hits:mismatchHits,
   sampled_hit_rate:sample.length?hits/sample.length:null,ai_requests:0,session_writes:0,branch_id:process.env.WORDLOOP_STAGING_NEON_BRANCH_ID,checked_at:new Date().toISOString()};
  await writeFile(resolve(args.privateDataDir,'cache-hit-check.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
 });
}
main().catch(()=>{console.error('PRIVATE_CACHE_CHECK_FAILED');process.exitCode=1;});
