import type {SupabaseClient} from '@supabase/supabase-js';
const mutations=new Set(['insert','upsert','update','delete']);
/** Offline planning may read learner state, but must never record runtime audits. */
export function readOnlyPlanningDatabase(db:SupabaseClient):SupabaseClient{
 const wrap=(query:object):object=>new Proxy(query,{get(target,key){
  if(mutations.has(String(key)))return ()=>{throw new Error('OFFLINE_PLANNER_WRITE_BLOCKED');};
  const value=Reflect.get(target,key,target);
  if(typeof value!=='function')return value;
  if(key==='then')return value.bind(target);
  return (...args:unknown[])=>{const result=Reflect.apply(value,target,args);return result&&typeof result==='object'&&'then' in result?wrap(result):result;};
 }});
 return new Proxy(db,{get(target,key){
  if(key==='from')return (table:string)=>wrap(target.from(table));
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}

