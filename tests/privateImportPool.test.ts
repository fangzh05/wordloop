import {describe,it,expect} from 'vitest';
import {PrivateImportPool} from '../scripts/private-import-pool.js';
describe('bounded private import pool',()=>{
 it('overlaps at most two imports and drains completed work',async()=>{
  const pool=new PrivateImportPool(2);const release:(()=>void)[]=[];let running=0,max=0,finished=0;
  const task=async()=>{running++;max=Math.max(max,running);await new Promise<void>(r=>release.push(r));running--;finished++;};
  await pool.submit(task);await pool.submit(task);
  let submitted=false;const third=pool.submit(task).then(()=>{submitted=true;});
  await Promise.resolve();expect(submitted).toBe(false);expect(max).toBe(2);
  release.shift()!();await third;expect(pool.activeCount).toBeLessThanOrEqual(2);
  while(release.length)release.shift()!();await pool.drain();expect(finished).toBe(3);expect(max).toBe(2);
 });
 it('surfaces failed writes at the drain boundary',async()=>{
  const pool=new PrivateImportPool(1);await pool.submit(async()=>{throw new Error('WRITE_FAILED');});
  await expect(pool.drain()).rejects.toThrow('WRITE_FAILED');
 });
});
