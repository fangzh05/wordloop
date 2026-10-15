import { ActiveStudyClock, localStudyDay, localStudyDayStart } from "./activeStudyClock.js";
export interface TimeContext { session_id: string; phase: string; index: number; retry: number; stage: "answer" | "feedback" | "explanation"; scope: "review" | "pretest" | "lesson" | "consolidation"; consolidation?: boolean; consolidation_status?: "pending" | "exercise" | "feedback"; phase_started_at: string; local_date: string; timezone: string }
export type Observation = Omit<TimeContext, "timezone" | "scope" | "consolidation" | "consolidation_status"> & { active_ms: number; finalize: boolean; rollover?: boolean };
/** Web collector. Storage is a recovery checkpoint,
 * never authentication or evidence of a correct answer. */
export class LearningTimeTracker {
  private clock: ActiveStudyClock;
  private key: string;
  private finished = false;
  private pendingFlush: Promise<boolean> | null = null;
  get isFinished() { return this.finished; }
  constructor(private context: TimeContext, private sendObservation: (v: Observation) => Promise<unknown>, private now = () => performance.now()) {
    this.key = this.storageKey();
    let initial = 0;
    try { initial = Number(sessionStorage.getItem(this.key) ?? 0) || 0; } catch { /* optional */ }
    this.clock = new ActiveStudyClock(now(), initial);
    this.clock.visibility(typeof document === "undefined" || document.visibilityState === "visible", now());
    this.recoverPreviousDay();
  }
  private storageKey() { return `wordloop-time-v2:${this.context.session_id}:${this.context.phase}:${this.context.index}:${this.context.retry}:${this.context.stage}:${this.context.phase_started_at}:${this.context.local_date}`; }
  private sendToServer(context: TimeContext, active_ms: number, finalize: boolean, rollover = false) {
    const { timezone: _timezone, scope: _scope, consolidation: _consolidation, consolidation_status: _consolidationStatus, ...wire } = context;
    return this.sendObservation({ ...wire, active_ms, finalize, ...(rollover ? { rollover: true } : {}) });
  }
  private recoverPreviousDay() {
    try {
      const prefix=`wordloop-time-v2:${this.context.session_id}:`;
      const previousDate=new Date(`${this.context.local_date}T00:00:00Z`);previousDate.setUTCDate(previousDate.getUTCDate()-1);
      const yesterday=previousDate.toISOString().slice(0,10);
      const keys:string[]=[];
      for(let index=0;index<sessionStorage.length;index++){const key=sessionStorage.key(index);if(key?.startsWith(prefix)&&key.endsWith(`:${yesterday}`))keys.push(key);}
      for(const key of keys){
        const match=/^wordloop-time-v2:([^:]+):([^:]+):(\d+):(\d+):(answer|feedback|explanation):(.+):(\d{4}-\d{2}-\d{2})$/.exec(key);
        if(!match)continue;
        const activeMs=Math.max(0,Number(sessionStorage.getItem(key))||0);
        const context:TimeContext={session_id:match[1]!,phase:match[2]!,index:Number(match[3]),retry:Number(match[4]),stage:match[5] as TimeContext["stage"],scope:this.context.scope,phase_started_at:match[6]!,local_date:match[7]!,timezone:this.context.timezone};
        void this.sendToServer(context,activeMs,true,true).then(result=>{
          if(!(typeof result==="object"&&result!==null&&"recorded" in result&&result.recorded===false))try{sessionStorage.removeItem(key);}catch{/* optional */}
        }).catch(()=>undefined);
      }
    }catch{/* optional */}
  }
  private reconcileLocalDay() {
    const wallNow=Date.now(),monoNow=this.now(),day=localStudyDay(this.context.timezone,new Date(wallNow));
    if(day===this.context.local_date)return;
    const previous=this.context,previousKey=this.key;
    const boundaryMono=monoNow-(wallNow-localStudyDayStart(previous.timezone,wallNow));
    const split=this.clock.splitAt(boundaryMono);
    const previousMs=split.elapsedMs;
    try{sessionStorage.setItem(previousKey,String(previousMs));}catch{/* optional */}
    this.context={...previous,local_date:day};this.key=this.storageKey();this.clock=split.next;
    const currentMs=this.clock.tick(monoNow);
    try{sessionStorage.setItem(this.key,String(currentMs));}catch{/* optional */}
    void this.sendToServer(previous,previousMs,true,true).then(result=>{
      if(!(typeof result==="object"&&result!==null&&"recorded" in result&&result.recorded===false))try{sessionStorage.removeItem(previousKey);}catch{/* optional */}
    }).catch(()=>undefined);
    void this.sendToServer(this.context,currentMs,false).catch(()=>undefined);
  }
  activity() { this.reconcileLocalDay(); this.clock.activity(this.now()); }
  visible(value: boolean) { this.reconcileLocalDay(); this.clock.visibility(value, this.now()); }
  wait(value: boolean) { this.reconcileLocalDay(); this.clock.wait(value, this.now()); }
  private async flushInternal(finalize: boolean): Promise<boolean> {
    if (this.finished) return true;
    this.reconcileLocalDay();
    const active_ms = this.clock.tick(this.now());
    try { sessionStorage.setItem(this.key, String(active_ms)); } catch { /* optional */ }
    const wasWaiting = this.clock.isWaiting;
    this.clock.wait(true, this.now());
    let sent = false;
    try {
      const result = await this.sendToServer(this.context, active_ms, finalize);
      sent = !(typeof result === "object" && result !== null && "recorded" in result && result.recorded === false);
    } catch { /* learning must continue */ }
    this.clock.wait(wasWaiting, this.now());
    if (finalize && sent) this.finished = true;
    if(finalize&&sent)try{sessionStorage.removeItem(this.key);}catch{/* optional */}
    return sent;
  }

  async flush(finalize = false): Promise<boolean> {
    // A response can replace the current page while the final telemetry
    // request is still in flight. Reuse that request so the effect cleanup
    // cannot send a duplicate observation. If a non-final checkpoint is in
    // flight and a final flush arrives, finalize once the checkpoint settles.
    const pending = this.pendingFlush;
    if (pending) {
      const recorded = await pending;
      return finalize && !this.finished ? this.flush(true) : recorded;
    }
    const current = this.flushInternal(finalize);
    const tracked = current.finally(() => {
      if (this.pendingFlush === tracked) this.pendingFlush = null;
    });
    this.pendingFlush = tracked;
    return tracked;
  }
}
