/** Monotonic active-time collector. A visible page is not proof of attention. */
export class ActiveStudyClock {
  private last: number;
  private interaction: number;
  private total: number;
  private visible=true;
  private waiting=false;
  get isWaiting(){return this.waiting;}
  constructor(now:number,initialMs=0) {this.last=now;this.interaction=now;this.total=Math.max(0,Math.min(600000,initialMs));}
  tick(now:number) {
    const end=Math.min(now,this.interaction+30000);
    if(this.visible&&!this.waiting) this.total=Math.min(600000,this.total+Math.max(0,end-this.last));
    this.last=now;return Math.floor(this.total);
  }
  activity(now:number){this.tick(now);this.interaction=now;}
  visibility(visible:boolean,now:number){this.tick(now);this.visible=visible;if(visible)this.interaction=now;}
  wait(waiting:boolean,now:number){this.tick(now);this.waiting=waiting;if(!waiting)this.interaction=now;}
  splitAt(boundary:number){
    const elapsedMs=this.tick(boundary);
    const next=new ActiveStudyClock(boundary);
    next.visible=this.visible;next.waiting=this.waiting;next.interaction=this.interaction;
    return {elapsedMs,next};
  }
}
export function localStudyDay(timeZone:string,now=new Date()):string {
  return new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
}
export function localStudyDayStart(timeZone:string,nowEpoch=Date.now()):number {
  const today=localStudyDay(timeZone,new Date(nowEpoch));
  let low=nowEpoch-36*60*60*1000,high=nowEpoch;
  for(let i=0;i<32;i++){
    const middle=Math.floor((low+high)/2);
    if(localStudyDay(timeZone,new Date(middle))===today)high=middle;else low=middle;
  }
  return high;
}
