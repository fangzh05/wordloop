import {readOnlyPlanningDatabase} from './private-lesson-planning.js';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {getDatabase,withUserIdentity} from '../server/db.js';
import {findCachedLesson,LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION,PERSONAL_KAOYAN_SET_ID} from '../server/services/lessonGenerationCache.js';
import {readArgs,requireStagingEnvironment,loadWordsAndMembership,readJsonl,buildPrivateUnionWork} from './import-anki-lesson-cache.js';
import {getVocabularyItemsByWords} from '../server/services/words.js';
import {planLessonQueue} from '../server/services/exercisePlanner.js';
import {deriveLessonProfile} from '../server/services/lessonProfile.js';
import {formatMeaningByPartOfSpeech,formatPartOfSpeech} from '../shared/lexicalDisplay.js';
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
  const actualItems=await getVocabularyItemsByWords(sample.map(e=>e.record.normalized_word),db,args.userId);
  const actualPlans=await planLessonQueue(actualItems.map(i=>i.word),[],readOnlyPlanningDatabase(db),args.userId,{vocabulary_items:actualItems});
  let actualHits=0,privateSourcePlans=0;const actualActivities:Record<string,number>={},actualProfiles:Record<string,number>={};
  for(const item of actualItems){
   const plan=actualPlans.find(p=>p.word_id===item.word_id)!;
   const profile=deriveLessonProfile({status:item.status,is_relearn:false,error_layers:item.error_layers});
   actualActivities[plan.planned_activity_type]=(actualActivities[plan.planned_activity_type]??0)+1;
   actualProfiles[profile.lesson_profile]=(actualProfiles[profile.lesson_profile]??0)+1;
   if(plan.private_source_book_id)privateSourcePlans++;
   const found=await findCachedLesson(db,{userId:args.userId,wordId:item.word_id!,word:item.word,
    meaningZh:formatMeaningByPartOfSpeech(item.senses)??'',partOfSpeech:formatPartOfSpeech(item.senses)??'词性未标注',
    ...(item.ipa_us?{ipa:item.ipa_us}:{}),lessonProfile:profile.lesson_profile,errorFocus:profile.error_focus,plan});
   if(found.lesson)actualHits++;
  }
  const wrongSet=await db.from('lesson_generation_cache').select('id').eq('user_id',args.userId).eq('private_set_id','non-member-private-test-set').limit(1);
  if(wrongSet.error)throw new Error('WRONG_SET_CHECK_FAILED');
  const otherUserRows=await withUserIdentity('00000000-0000-4000-8000-000000000002',async()=>{
   const other=getDatabase();
   const q=await other.from('lesson_generation_cache').select('id').eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID).limit(1);
   if(q.error)throw new Error('OTHER_IDENTITY_CHECK_FAILED');return (q.data??[]).length;
  });
  const report={actual_planner_sampled:actualItems.length,actual_planner_hits:actualHits,actual_planner_profiles:actualProfiles,actual_planner_activities:actualActivities,private_source_plans:privateSourcePlans,other_user_visible_rows:otherUserRows,other_set_visible_rows:(wrongSet.data??[]).length,private_union_words:work.entries.length,valid_word_coverage:valid.size,sampled:sample.length,hits,cross_session_hits:crossSessionHits,mismatched_condition_hits:mismatchHits,
   sampled_hit_rate:sample.length?hits/sample.length:null,ai_requests:0,session_writes:0,branch_id:process.env.WORDLOOP_STAGING_NEON_BRANCH_ID,checked_at:new Date().toISOString()};
  await writeFile(resolve(args.privateDataDir,'cache-hit-check.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
 });
}
main().catch(()=>{console.error('PRIVATE_CACHE_CHECK_FAILED');process.exitCode=1;});
