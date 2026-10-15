import {describe,it,expect} from 'vitest';
import {readOnlyPlanningDatabase} from '../scripts/private-lesson-planning.js';

describe('offline planning database',()=>{
 it('retains reads and blocks all query mutations before they reach the database',async()=>{
  let writes=0;
  const query={select(){return this;},eq(){return this;},then(done:(x:unknown)=>unknown){return Promise.resolve({data:[{id:1}],error:null}).then(done);},upsert(){writes++;}};
  const db={from:()=>query} as never;
  const readonly=readOnlyPlanningDatabase(db);
  expect(await readonly.from('example').select('id').eq('user_id','user')).toMatchObject({data:[{id:1}]});
  expect(()=>readonly.from('tutor_shadow_decisions').upsert({})).toThrow('OFFLINE_PLANNER_WRITE_BLOCKED');
  expect(writes).toBe(0);
 });
});
