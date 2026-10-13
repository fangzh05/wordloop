import { expect, it, vi } from "vitest";
import { LearningTimeTracker } from "../web/src/learningTimeTracker.js";
import { ActiveStudyClock, localStudyDayStart } from "../web/src/activeStudyClock.js";
import type { Observation } from "../web/src/learningTimeTracker.js";
it("uses monotonic active time, caps unattended time, and excludes network waits", async () => {
  let now = 0; const send = vi.fn(async (_observation: Observation) => undefined);
  const tracker = new LearningTimeTracker({ session_id: "00000000-0000-4000-8000-000000000001", phase: "lesson_exercise", index: 0, retry: 0, stage: "answer", scope: "lesson", phase_started_at: new Date(Date.now()-60000).toISOString(), local_date: new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()), timezone: "Asia/Shanghai" }, send, () => now);
  now = 45_000; await tracker.flush(); expect(send.mock.calls.at(-1)?.[0].active_ms).toBeLessThanOrEqual(30_000);
  tracker.wait(true); now += 90_000; tracker.wait(false); await tracker.flush(true);
  expect(send.mock.calls.at(-1)?.[0].active_ms).toBeLessThanOrEqual(30_000);
  await tracker.flush(true); expect(send).toHaveBeenCalledTimes(2);
});
it("pauses while hidden and finalizes once", async () => {
  let now = 0; const send = vi.fn(async (_observation: Observation) => undefined);
  const tracker = new LearningTimeTracker({ session_id: "00000000-0000-4000-8000-000000000002", phase: "lesson_exercise", index: 0, retry: 0, stage: "answer", scope: "lesson", phase_started_at: new Date(Date.now()-60000).toISOString(), local_date: new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()), timezone: "Asia/Shanghai" }, send, () => now);
  tracker.visible(false); now = 60_000; tracker.visible(true); await tracker.flush(true);
  expect(send.mock.calls[0]?.[0].active_ms).toBe(0);
  await tracker.flush(true); expect(send).toHaveBeenCalledTimes(1);
});
it("splits active time at the learner's local midnight", async()=>{
  const prior=Date.parse("2026-10-13T15:59:50.000Z"),wall=vi.spyOn(Date,"now").mockReturnValue(prior);
  let now=0;const send=vi.fn(async(_observation:Observation)=>({recorded:true}));
  const tracker=new LearningTimeTracker({session_id:"00000000-0000-4000-8000-000000000003",phase:"lesson_exercise",index:0,retry:0,stage:"answer",scope:"lesson",phase_started_at:new Date(prior-60_000).toISOString(),local_date:"2026-10-13",timezone:"Asia/Shanghai"},send,()=>now);
  expect(localStudyDayStart("Asia/Shanghai",prior+20_000)).toBe(prior+10_000);
  now=20_000;wall.mockReturnValue(prior+20_000);tracker.activity();
  await Promise.resolve();await Promise.resolve();
  const previous=send.mock.calls.find(call=>call[0].rollover===true)?.[0];
  const current=send.mock.calls.find(call=>call[0].local_date==="2026-10-14"&&call[0].finalize===false)?.[0];
  expect(previous?.active_ms).toBe(10_000);expect(previous?.local_date).toBe("2026-10-13");
  expect(current?.active_ms).toBe(10_000);expect(current?.local_date).toBe("2026-10-14");
  wall.mockRestore();
});
