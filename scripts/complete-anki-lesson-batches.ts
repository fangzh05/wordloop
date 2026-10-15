import {readOnlyPlanningDatabase} from './private-lesson-planning.js';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { getDatabase, withUserIdentity } from '../server/db.js';
import { LESSON_GENERATION_PROMPT } from '../server/services/deepseekPrompts.js';
import { safeParseLessonGenerationForPlan, type LessonGeneration } from '../server/services/deepseek.js';
import {getVocabularyItemsByWords} from '../server/services/words.js';
import {planLessonQueue} from '../server/services/exercisePlanner.js';
import {deriveLessonProfile} from '../server/services/lessonProfile.js';
import {formatMeaningByPartOfSpeech} from '../shared/lexicalDisplay.js';
import { formatPartOfSpeech } from '../shared/lexicalDisplay.js';
import {
  lessonCacheHash, lessonGenerationCacheKey, cacheContextWithAnkiMaterial, savePrivateLessonCache, savePrivateLessonCacheBatch, savePrivateLessonCacheFailure,
  LESSON_CACHE_CONTENT_VERSION, LESSON_CACHE_PROMPT_VERSION, ANKI_SOURCE_VERSION,
  PRIVATE_UNION_SOURCE_VERSION, PERSONAL_KAOYAN_SET_ID, type PrivateLessonCacheContext,
} from '../server/services/lessonGenerationCache.js';
import {
  readArgs, requireStagingEnvironment, loadWordsAndMembership, readJsonl, buildPrivateUnionWork,
  buildPlan, parseSenses, outputJsonSchema, buildPrompt, runCodeBuddy, assertOfflineLessonQuality,
  safeReportPath, getCodeBuddyVersion,
} from './import-anki-lesson-cache.js';

type Work = ReturnType<typeof buildPrivateUnionWork>['entries'][number];
type Field = 'ipa'|'part_of_speech'|'meaning_zh'|'collocations'|'derivations'|'example_en'|'example_zh'|'note'|'exercise';
type Entry = {status:string;word_id:string;source_note_id:string;lesson?:LessonGeneration;input_fingerprint?:string;
  retry_count:number;material_status?:string;error_code?:string;updated_at:string;input_tokens?:number;output_tokens?:number};
type Checkpoint = {version:number;source_version:string;source_sha256:string;generation_config:string;user_id:string;entries:Record<string,Entry>};
type Ready = {work:Work;context:PrivateLessonCacheContext;fixed:Partial<LessonGeneration>;missing:Field[];
  materialHash:string|null;sourceVersion:string;key:string;usedAnki:boolean};
const fields:Field[]=['ipa','part_of_speech','meaning_zh','collocations','derivations','example_en','example_zh','note','exercise'];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function atomic(path:string,value:unknown){await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
async function retry<T>(f:()=>PromiseLike<T>):Promise<T>{let last:unknown;for(let i=0;i<3;i++){try{return await f();}catch(e){last=e;if(i<2)await sleep(750*2**i);}}throw last;}
export function prepare(work:Work,userId:string,args:ReturnType<typeof readArgs>):Omit<Ready,'key'|'materialHash'>{
  const senses=parseSenses(work.row.senses),pos=senses.find(s=>s.pos.trim())?.pos??'';
  const plan=buildPlan({wordId:work.row.id,word:work.row.normalized_word,targetSense:work.targetSense,
    partOfSpeech:pos,activityType:args.activityType,profile:args.lessonProfile,errorFocus:args.errorFocus});
  const sensePos=formatPartOfSpeech(senses)??'未标注词性';
  const fixed={...work.base,ipa:work.material.ipa??work.row.ipa_us??'—',part_of_speech:work.material.part_of_speech??sensePos,...(args.activityType==='word_recall'?{exercise:{activity_type:'word_recall' as const,instruction:'根据中文释义写出英文单词。',prompt:recallCue(work.targetSense),multiline:false,accepted_answers:[work.record.normalized_word]}}:{})};
  const context:PrivateLessonCacheContext={userId,wordId:work.row.id,word:work.record.display_word,
    meaningZh:work.meaningZh,partOfSpeech:work.material.part_of_speech??sensePos,
    ...((work.material.ipa??work.row.ipa_us)?{ipa:work.material.ipa??work.row.ipa_us!}:{}),
    lessonProfile:args.lessonProfile,errorFocus:args.errorFocus as PrivateLessonCacheContext['errorFocus'],plan};
  const missing=fields.filter(k=>(k==='exercise'?!fixed.exercise:(k==='collocations'||k==='derivations'?!Array.isArray(fixed[k]):typeof fixed[k]!=='string'||!fixed[k]?.trim())));
  const usedAnki=Object.keys(work.material).some(k=>!['word','source_fields'].includes(k));
  return {work,context,fixed,missing,usedAnki,sourceVersion:usedAnki?ANKI_SOURCE_VERSION:PRIVATE_UNION_SOURCE_VERSION};
}
export function recallCue(sense:string):string{
  // Remove Latin dictionary labels/collocations from the cue only, never from the saved sense.
  const cue=sense.replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/g,'').replace(/[A-Za-z]+(?:[-’'][A-Za-z]+)*/g,'').replace(/\s+/g,' ').trim();
  if(!/\p{Script=Han}/u.test(cue))throw new Error('WORD_RECALL_CUE_UNAVAILABLE');
  return cue;
}
export function mergeMissingFields(base:Partial<LessonGeneration>,generated:Record<string,unknown>,missing:readonly Field[]):unknown{
  if(Object.keys(generated).some(k=>!missing.includes(k as Field)))throw new Error('GENERATED_TRUSTED_FIELD_OVERWRITE');
  return {...base,...generated};
}
export function derivationHeadword(value:string):string|null{return value.match(/^\s*([a-z]+(?:[-'][a-z]+)*)\b/i)?.[1]?.toLowerCase()??null;}

async function main(){
  const args=readArgs(process.argv.slice(2)),dir=resolve(args.privateDataDir);
  safeReportPath('batch-report.json',dir);
  if(!args.materialsJsonl||!args.manifest)throw new Error('EXTRACTED_SOURCE_REQUIRED');
  const value=(flag:string,fallback:number)=>{const i=process.argv.indexOf(flag);const n=i<0?fallback:Number(process.argv[i+1]);if(!Number.isInteger(n)||n<1||n>32)throw new Error('INVALID_BATCH_SIZE');return n;};
  const batchSize=value('--batch-size',8);
  const actualMode=process.argv[process.argv.indexOf('--variant-mode')+1]==='actual';
  const checkpointPath=resolve(dir,actualMode?'exercise-variant.checkpoint.json':'anki-lesson-cache.checkpoint.json');
  const manifest=JSON.parse(await readFile(args.manifest,'utf8')) as {apkg_sha256:string;source_version:string};
  const baseCheckpoint=JSON.parse(await readFile(resolve(dir,'anki-lesson-cache.checkpoint.json'),'utf8')) as Checkpoint;
  const checkpoint=(existsSync(checkpointPath)?JSON.parse(await readFile(checkpointPath,'utf8')):{...baseCheckpoint,generation_config:baseCheckpoint.generation_config+'|actual-plan-exercise-v1',entries:{}}) as Checkpoint;
  const config=[LESSON_CACHE_CONTENT_VERSION,LESSON_CACHE_PROMPT_VERSION,args.codebuddyModel,args.lessonProfile,args.activityType,args.errorFocus??'none',...(actualMode?['actual-plan-exercise-v1']:[])].join('|');
  if(checkpoint.version!==3||checkpoint.generation_config!==config||checkpoint.user_id!==args.userId
    ||checkpoint.source_sha256!==manifest.apkg_sha256||manifest.source_version!==ANKI_SOURCE_VERSION)throw new Error('CHECKPOINT_SOURCE_OR_USER_MISMATCH');
  const records=await readJsonl(args.materialsJsonl);
  requireStagingEnvironment();
  const version=getCodeBuddyVersion(args.codebuddyCommand);
  await mkdir(resolve(dir,'raw-batches'),{recursive:true,mode:0o700});
  const reportPath=safeReportPath(args.report??'batch-report.json',dir)!;
  const stats={private_union_words:0,anki_matched_words:0,without_anki:0,skipped_valid:0,valid:0,needs_review:0,failed:0,
    codebuddy_calls:0,model_retries:0,input_tokens:0,output_tokens:0,all_tokens_available:true,
    credits:0,all_credits_available:true,cost_usd:0,all_cost_available:true,raw_cache_hits:0,derivations_removed:0,
    model:args.codebuddyModel,effort:'low',cli_version:version,batch_size:batchSize,started_at:new Date().toISOString()};
  const report=async()=>{const entries=Object.values(checkpoint.entries);await atomic(reportPath,{...stats,
    total_valid:entries.filter(x=>x.status==='valid').length,total_needs_review:entries.filter(x=>x.status==='needs_review').length,
    total_failed:entries.filter(x=>x.status==='failed').length,content_version:LESSON_CACHE_CONTENT_VERSION,prompt_version:LESSON_CACHE_PROMPT_VERSION,
    batch_envelope_version:'missing-fields-batch-v1',input_tokens:stats.all_tokens_available?stats.input_tokens:'unavailable',
    output_tokens:stats.all_tokens_available?stats.output_tokens:'unavailable',codebuddy_credits:stats.all_credits_available?stats.credits:'unavailable',
    cli_reported_model_cost_usd:stats.all_cost_available?stats.cost_usd:'unavailable',
    actual_cost_usd:'unavailable',updated_at:new Date().toISOString()});};
  let interrupted=false;
  process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
  await withUserIdentity(args.userId,async()=>{
    const db=getDatabase(),lookup=await loadWordsAndMembership(db,args.userId);
    if(!lookup.hasFullUnion||lookup.wordRows.length!==7048)throw new Error('PRIVATE_UNION_MEMBERSHIP_MISMATCH');
    const built=buildPrivateUnionWork(records,lookup.wordRows);
    stats.private_union_words=built.entries.length;stats.anki_matched_words=built.matchedWords;stats.without_anki=built.entries.length-built.matchedWords;
    if(args.dryRun){console.log(JSON.stringify({phase:'dry-run',private_union_words:built.entries.length,anki_matched_words:built.matchedWords,selected_words:args.limit??built.entries.length,database_writes:0,codebuddy_calls:0}));return;}
    const exportRows=[...lookup.wordRows].sort((a,b)=>a.normalized_word.localeCompare(b.normalized_word));
    const exportText=exportRows.map(row=>JSON.stringify(row)).join('\n')+'\n';
    await writeFile(resolve(dir,'private-union-export.jsonl'),exportText,{mode:0o600});
    await atomic(resolve(dir,'private-union-export.manifest.json'),{private_set_id:PERSONAL_KAOYAN_SET_ID,
      rows:exportRows.length,unique_words:new Set(exportRows.map(r=>r.normalized_word)).size,
      senses:exportRows.reduce((n,r)=>n+parseSenses(r.senses).length,0),sha256:createHash('sha256').update(exportText).digest('hex'),
      membership_source:'authorized user word_sources: ougkp union athgc',branch_id:'br-spring-unit-azxctyf3'});
    const ready:Ready[]=[];let missingTeaching=0;
    const actual=new Map<string,PrivateLessonCacheContext>();
    const cached=new Map<string,{id:string;lesson_payload:LessonGeneration}>();
    for(let offset=0;;offset+=500){
      const q=await db.from('lesson_generation_cache').select('id,cache_key,lesson_payload').eq('user_id',args.userId)
        .eq('private_set_id',PERSONAL_KAOYAN_SET_ID).eq('cache_kind','lesson').eq('content_version',LESSON_CACHE_CONTENT_VERSION)
        .eq('prompt_version',LESSON_CACHE_PROMPT_VERSION).eq('is_valid',true).order('created_at',{ascending:true}).range(offset,offset+499);
      if(q.error)throw new Error('PRIVATE_CACHE_PRELOAD_FAILED');
      for(const r of q.data??[])cached.set(r.cache_key,{id:r.id,lesson_payload:r.lesson_payload});
      if((q.data??[]).length<500)break;
    }
    if(actualMode){
      // Use the real read-only hydration and planner; no learner state or plan is persisted.
      const completed=new Set(Object.values(baseCheckpoint.entries).filter(e=>e.status==='valid').map(e=>e.word_id));
      const eligible=built.entries.filter(work=>completed.has(work.row.id));
      const chosen=args.limit?eligible.slice(0,args.limit):eligible;
      for(let offset=0;offset<chosen.length;offset+=100){
        const items=await getVocabularyItemsByWords(chosen.slice(offset,offset+100).map(w=>w.record.normalized_word),db,args.userId);
        const plans=await planLessonQueue(items.map(i=>i.word),[],readOnlyPlanningDatabase(db),args.userId,{vocabulary_items:items});
        for(const item of items){const plan=plans.find(p=>p.word_id===item.word_id)!;
          const profile=deriveLessonProfile({status:item.status,is_relearn:false,error_layers:item.error_layers});
          if(plan.private_source_book_id)continue;
          actual.set(item.word_id!,{userId:args.userId,wordId:item.word_id!,word:item.word,meaningZh:formatMeaningByPartOfSpeech(item.senses)??'',partOfSpeech:formatPartOfSpeech(item.senses)??'词性未标注',...(item.ipa_us?{ipa:item.ipa_us}:{}),lessonProfile:profile.lesson_profile,errorFocus:profile.error_focus,plan});
        }
        console.log(JSON.stringify({phase:'plan-read',words:Math.min(offset+100,chosen.length),selected:chosen.length}));
      }
    }
    for(const work of built.entries){
      let p=prepare(work,args.userId,args),materialHash=p.usedAnki?await lessonCacheHash(work.material):null;
      if(actualMode){
        const originalContext=actual.get(work.row.id);if(!originalContext)continue;
        const context=cacheContextWithAnkiMaterial(originalContext,work.material);
        if(context.plan.target_sense!==p.context.plan.target_sense||context.meaningZh!==p.context.meaningZh||context.partOfSpeech!==p.context.partOfSpeech){missingTeaching++;continue;}
        const source=cached.get((await lessonGenerationCacheKey(p.context,materialHash,p.sourceVersion)).cacheKey);
        if(!source){missingTeaching++;continue;}
        const {exercise:unused,...teaching}=source.lesson_payload;
        const fixed={...teaching,...(context.plan.planned_activity_type==='word_recall'?{exercise:{activity_type:'word_recall' as const,instruction:'根据中文释义写出英文单词。',prompt:recallCue(context.plan.target_sense),multiline:false,accepted_answers:[work.record.normalized_word]}}:{})};
        p={...p,context:{...context,...(work.material.ipa?{ipa:work.material.ipa}:{})},fixed,missing:context.plan.planned_activity_type==='word_recall'?[]:['exercise']};
      }
      const key=(await lessonGenerationCacheKey(p.context,materialHash,p.sourceVersion)).cacheKey;
      const r:Ready={...p,materialHash,key};
      const prior=checkpoint.entries[work.record.normalized_word];
      const saved=cached.get(key);
      if(saved&&(work.record.normalized_word!=='acquaintance'||!saved.lesson_payload.derivations.some(v=>derivationHeadword(v)==='acquaintanceship'))){
        const check=safeParseLessonGenerationForPlan({word:p.context.word,lesson_profile:p.context.lessonProfile,error_focus:p.context.errorFocus,plan:p.context.plan},saved.lesson_payload);
        if(check.success){try{assertOfflineLessonQuality(check.data,p.context.word,p.context.plan.planned_activity_type);checkpoint.entries[work.record.normalized_word]={...prior,status:'valid',word_id:work.row.id,source_note_id:work.record.source_note_id,retry_count:prior?.retry_count??0,lesson:check.data,input_fingerprint:key,error_code:undefined,updated_at:new Date().toISOString()};stats.skipped_valid++;continue;}catch{/*repair below*/}}
      }
      if(work.record.normalized_word==='acquaintance'&&saved){
        const lesson={...saved.lesson_payload,derivations:saved.lesson_payload.derivations.filter(v=>derivationHeadword(v)!=='acquaintanceship')};
        if(lesson.derivations.length!==saved.lesson_payload.derivations.length){
          await savePrivateLessonCache({db,context:p.context,lesson,sourceKind:p.usedAnki?'mixed':'codebuddy_deepseek',generationMethod:'codebuddy_cli',sourceVersion:p.sourceVersion,modelName:args.codebuddyModel,modelEffort:'low',materialPayloadHash:materialHash});
          const old=await db.from('lesson_generation_cache').update({quality_status:'needs_review',is_valid:false,error_code:'SUPERSEDED_AFTER_LANGUAGE_REVIEW',error_summary:'A low-value generated derivation was removed in a newer validated revision.'}).eq('id',saved.id).eq('user_id',args.userId).eq('private_set_id',PERSONAL_KAOYAN_SET_ID);
          if(old.error)throw new Error('REVIEW_STATUS_WRITE_FAILED');
          checkpoint.entries[work.record.normalized_word]={...prior,status:'valid',word_id:work.row.id,source_note_id:work.record.source_note_id,retry_count:prior?.retry_count??0,lesson,input_fingerprint:key,updated_at:new Date().toISOString()};
          stats.derivations_removed++;stats.skipped_valid++;await atomic(checkpointPath,checkpoint);continue;
        }
      }
      ready.push(r);
    }
    // Index every saved batch before regrouping so interruptions never discard paid output.
    const recovered=new Map<string,Record<string,unknown>>();
    for(const name of (await readdir(resolve(dir,'raw-batches'))).sort()){
      if(!name.endsWith('.json'))continue;
      const raw=JSON.parse(await readFile(resolve(dir,'raw-batches',name),'utf8'));
      if(raw.model!==args.codebuddyModel||raw.effort!=='low')continue;
      for(const [key,item] of Object.entries(raw.items??{})){
        const value=raw.response?.result?.[item as string];
        if(value&&typeof value==='object')recovered.set(key,value);
      }
    }
    await atomic(checkpointPath,checkpoint);
    const selected=args.limit?ready.slice(0,args.limit):ready;
    console.log(JSON.stringify({phase:'ready',...stats,pending:ready.length,selected:selected.length,variant_mode:actualMode?'actual':'base',missing_teaching:missingTeaching,database_writes:args.dryRun?0:'validated-only'}));
    let staged:{r:Ready;entry:Entry;input:Parameters<typeof savePrivateLessonCache>[0]}[]|null=null;
    const persist=async(r:Ready,lesson:LessonGeneration,tokens?:{inputTokens?:number;outputTokens?:number})=>{
      const word=r.work.record.normalized_word,prior=checkpoint.entries[word];
      const entry:Entry={...prior,status:'generated_pending_import',word_id:r.work.row.id,source_note_id:r.work.record.source_note_id,
        retry_count:prior?.retry_count??0,input_fingerprint:r.key,lesson,updated_at:new Date().toISOString()};
      checkpoint.entries[word]=entry;await atomic(checkpointPath,checkpoint);
      const input:Parameters<typeof savePrivateLessonCache>[0]={db,context:r.context,lesson,sourceKind:r.usedAnki?'mixed':'codebuddy_deepseek',generationMethod:'codebuddy_cli',
        sourceVersion:r.sourceVersion,modelName:args.codebuddyModel,modelEffort:'low',materialPayloadHash:r.materialHash,
        codebuddyRequestId:r.key,retryCount:entry.retry_count,
        // Batch totals cannot be attributed to individual words; null is intentional.
      };
      if(staged){staged.push({r,entry,input});return;}
      await retry(()=>savePrivateLessonCache(input));
      entry.status='valid';entry.error_code=undefined;stats.valid++;await atomic(checkpointPath,checkpoint);
    };
    const queue:Ready[]=[];
    for(const r of selected){
      if(actualMode&&!r.missing.length){await persist(r,r.fixed as LessonGeneration);continue;}
      const prior=checkpoint.entries[r.work.record.normalized_word];
      if(prior?.lesson&&prior.input_fingerprint===r.key){const parsed=safeParseLessonGenerationForPlan({word:r.context.word,lesson_profile:r.context.lessonProfile,error_focus:r.context.errorFocus,plan:r.context.plan},prior.lesson);
        if(parsed.success){try{assertOfflineLessonQuality(parsed.data,r.context.word,r.context.plan.planned_activity_type);await persist(r,parsed.data);continue;}catch{/* regenerate invalid payload */}}}
      queue.push(r);
    }
    const attempts=new Map<string,number>();
    while(queue.length&&!interrupted&&!existsSync(resolve(dir,'STOP_AFTER_BATCH'))){
      const recovering=queue.some(r=>recovered.has(r.key));
      const batch=queue.filter(r=>recovered.has(r.key)===recovering).slice(0,batchSize);
      for(const r of batch)queue.splice(queue.indexOf(r),1);
      const defs:Record<string,unknown>={},byFields=new Map<string,string>();
      const schemas=Object.fromEntries(batch.map(r=>{const signature=r.context.plan.planned_activity_type+':'+r.missing.join(',');let name=byFields.get(signature);if(!name){name='s'+byFields.size;byFields.set(signature,name);defs[name]=JSON.parse(outputJsonSchema(r.missing,r.context.plan.planned_activity_type));}return [r.work.row.id,{$ref:'#/$defs/'+name}];}));
      const schema=JSON.stringify({type:'object',additionalProperties:false,$defs:defs,properties:schemas,required:batch.map(r=>r.work.row.id)});
      const prompt='Retry feedback: '+JSON.stringify(batch.map(r=>({word_id:r.work.row.id,error:checkpoint.entries[r.work.record.normalized_word]?.error_code??null})))+'\n'+LESSON_GENERATION_PROMPT+'\n这是独立词条的小批次。共享规则对每个词分别生效。只补缺失字段，不得改写 existing_valid_fields。每个搭配和派生包含英文及中文；无可靠常用派生可返回空数组。外层 JSON 必须按批次 Schema 用 word_id 为键，每个值只包含该词 required_missing_fields；不要混用词义或覆盖已有字段。派生词只保留最常用且可靠的形式，宁缺毋滥。\n'+batch.map(r=>JSON.stringify({word_id:r.work.row.id,word:r.work.record.display_word,target_sense:r.context.plan.target_sense,
        existing_valid_fields:r.fixed,anki_source_fields:r.work.material.source_fields,required_missing_fields:r.missing,
        lesson_profile:r.context.lessonProfile,planned_activity_type:r.context.plan.planned_activity_type,error_focus:r.context.errorFocus,
        skill_goal:r.context.plan.skill_goal,skill_ids:r.context.plan.skill_ids,hint_level:r.context.plan.hint_level})).join('\n');
      const task=await lessonCacheHash({prompt,schema,model:args.codebuddyModel,effort:'low'}),rawPath=resolve(dir,'raw-batches',task+'.json');
      let response:Awaited<ReturnType<typeof runCodeBuddy>>;
      try{
        if(batch.every(r=>recovered.has(r.key))){response={result:Object.fromEntries(batch.map(r=>[r.work.row.id,recovered.get(r.key)!]))};stats.raw_cache_hits++;}
        else if(existsSync(rawPath)){response=JSON.parse(await readFile(rawPath,'utf8')).response;stats.raw_cache_hits++;}
        else{
          stats.codebuddy_calls++;
          response=await runCodeBuddy({command:args.codebuddyCommand,model:args.codebuddyModel,prompt,jsonSchema:schema,timeoutMs:Math.max(args.timeoutMs,300000)});
          await atomic(rawPath,{task_id:task,model:args.codebuddyModel,effort:'low',channel:'codebuddy_cli',items:Object.fromEntries(batch.map(r=>[r.key,r.work.row.id])),response,created_at:new Date().toISOString()});
          if(response.inputTokens!==undefined&&response.outputTokens!==undefined){stats.input_tokens+=response.inputTokens;stats.output_tokens+=response.outputTokens;}else stats.all_tokens_available=false;
          if(response.codebuddyCredits!==undefined)stats.credits+=response.codebuddyCredits;else stats.all_credits_available=false;
          if(response.modelCostUsd!==undefined)stats.cost_usd+=response.modelCostUsd;else stats.all_cost_available=false;
          if((response.inputTokens??0)>150000||(response.outputTokens??0)>32000)throw new Error('CODEBUDDY_TOKEN_OUTLIER');
        }
        for(const r of batch){const item=response.result[r.work.row.id];if(item&&typeof item==='object')recovered.set(r.key,item as Record<string,unknown>);}
        const derivativeValues=batch.flatMap(r=>r.missing.includes('derivations')?((response.result[r.work.row.id] as Record<string,unknown>)?.derivations as string[]??[]):[]);
        const heads=[...new Set(derivativeValues.filter(x=>typeof x==='string').map(derivationHeadword).filter((x):x is string=>!!x))];
        const lexical=new Set<string>();
        if(heads.length){const q=await db.from('words').select('normalized_word').in('normalized_word',heads);if(q.error)throw new Error('DERIVATION_REFERENCE_READ_FAILED');for(const x of q.data??[])lexical.add(x.normalized_word);}
        staged=[];
        for(const r of batch){
          try{
            const generated=response.result[r.work.row.id];if(!generated||typeof generated!=='object'||Array.isArray(generated))throw new Error('MISSING_BATCH_ITEM');
            const partial={...generated as Record<string,unknown>};
            if(r.missing.includes('derivations')&&Array.isArray(partial.derivations)){
              const before=partial.derivations.length;const kept=partial.derivations.filter(v=>typeof v==='string'&&lexical.has(derivationHeadword(v)??''));partial.derivations=kept;stats.derivations_removed+=before-kept.length;
            }
            const parsed=safeParseLessonGenerationForPlan({word:r.context.word,lesson_profile:r.context.lessonProfile,error_focus:r.context.errorFocus,plan:r.context.plan},mergeMissingFields(r.fixed,partial,r.missing));
            if(!parsed.success)throw new Error('LESSON_SCHEMA_INVALID');assertOfflineLessonQuality(parsed.data,r.context.word,r.context.plan.planned_activity_type);
            await persist(r,parsed.data);
          }catch(e){if(!checkpoint.entries[r.work.record.normalized_word]?.lesson)recovered.delete(r.key);await fail(r,e);}
        }
      if(staged.length){
          const pending=staged;staged=null;
          try{await retry(()=>savePrivateLessonCacheBatch(pending.map(x=>x.input)));
            for(const x of pending){x.entry.status='valid';x.entry.error_code=undefined;stats.valid++;}
            await atomic(checkpointPath,checkpoint);
          }catch{
            // A single row failure must not block the remaining validated rows.
            for(const x of pending){try{await retry(()=>savePrivateLessonCache(x.input));x.entry.status='valid';x.entry.error_code=undefined;stats.valid++;}catch(e){await fail(x.r,e);}}
            await atomic(checkpointPath,checkpoint);
          }
        }
        staged=null;
      }catch(e){
        staged=null;
        if(e instanceof Error&&['CODEBUDDY_TOKEN_OUTLIER','CODEBUDDY_COMMAND_TOO_LONG','CODEBUDDY_QUOTA','CODEBUDDY_AUTH','CODEBUDDY_RATE_LIMIT'].includes(e.message)){await report();throw e;}
        stats.all_tokens_available=false;stats.all_credits_available=false;stats.all_cost_available=false;
        for(const r of batch)await fail(r,e);
        await sleep(Math.min(1000*2**Math.min(...batch.map(r=>attempts.get(r.key)??0)),8000));
      }
      await report();console.log(JSON.stringify({phase:'progress',valid:stats.valid,skipped:stats.skipped_valid,failed:stats.failed,queue:queue.length,calls:stats.codebuddy_calls,retries:stats.model_retries,elapsed_seconds:Math.round((Date.now()-Date.parse(stats.started_at))/1000)}));
    }
    async function fail(r:Ready,e:unknown){
      const n=(attempts.get(r.key)??0)+1;attempts.set(r.key,n);
      const word=r.work.record.normalized_word,prior=checkpoint.entries[word];
      const code=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'CODEBUDDY_EXIT';
      checkpoint.entries[word]={...prior,status:prior?.lesson?'generated_pending_import':'failed',word_id:r.work.row.id,source_note_id:r.work.record.source_note_id,retry_count:(prior?.retry_count??0)+1,error_code:code,updated_at:new Date().toISOString()};
      await atomic(checkpointPath,checkpoint);
      if(prior?.lesson){stats.failed++;return;}
      if(n<=args.maxRetries){stats.model_retries++;queue.push(r);}else{
        stats.failed++;
        if(!prior?.lesson)await savePrivateLessonCacheFailure({db,context:r.context,materialPayloadHash:r.materialHash,sourceVersion:r.sourceVersion,missingFields:r.missing,retryCount:checkpoint.entries[word].retry_count,errorCode:code}).catch(()=>undefined);
      }
    }
  });
  await report();console.log(JSON.stringify({phase:interrupted?'interrupted':'finished',...stats,report:basename(reportPath)}));
}

if(process.argv[1]?.replaceAll('\\','/').endsWith('/complete-anki-lesson-batches.ts'))main().catch(e=>{console.error(JSON.stringify({status:'failed',code:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'BATCH_FAILED'}));process.exitCode=1;});
