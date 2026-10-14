import type {LessonExercisePlan} from '../../shared/toolContracts.js';
import type {LessonGeneration} from './deepseek.js';
import {normalizeWord} from './wordNormalization.js';
// Existing planner, deterministic grading and BKT evidence; no external model call.
export function privateBookLesson(word:string,plan:LessonExercisePlan,pos:string,ipa:string):LessonGeneration {
 if(plan.planned_activity_type!=='word_recall')throw Error('PRIVATE_SOURCE_FROZEN_PLAN_REQUIRES_REVIEW');
 if(plan.private_source_word!==normalizeWord(word))throw Error('PRIVATE_SOURCE_FROZEN_WORD_MISMATCH');
 return {ipa:ipa||'—',part_of_speech:pos,meaning_zh:plan.target_sense,collocations:[],derivations:[],example_en:'',example_zh:'',
  note:'当前练习采用所选词书的释义。',exercise:{activity_type:'word_recall',instruction:'根据中文释义写出本词书中的英文词条。',prompt:plan.target_sense,multiline:false,accepted_answers:[word]}};
}
