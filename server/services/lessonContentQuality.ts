/** Pure text checks shared by offline imports and private cache reads/writes. */
export function assertLessonTextQuality(lesson:object):void{
 const fields=lesson as Record<string,unknown>;
 for(const field of ['ipa','part_of_speech','meaning_zh','example_en','example_zh','note']){
  const raw=fields[field];if(typeof raw!=='string')continue;const value=raw.trim();
  if(value.includes('```'))throw new Error('LESSON_EMBEDDED_MARKDOWN');
  if(/^[{[]/.test(value)){
   let decoded:unknown;try{decoded=JSON.parse(value);}catch{/* Literal punctuation is not an embedded object. */}
   if(decoded&&typeof decoded==='object')throw new Error('LESSON_NESTED_JSON_FIELD');
  }
 }
}
