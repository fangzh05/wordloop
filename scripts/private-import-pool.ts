/** Bounded asynchronous imports; model generation remains single-process. */
export class PrivateImportPool {
 private readonly active=new Set<Promise<void>>();private failure:unknown;
 constructor(readonly concurrency=2){if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw new Error('INVALID_IMPORT_CONCURRENCY');}
 get activeCount(){return this.active.size;}
 assertHealthy():void{if(this.failure)throw this.failure;}
 async submit(task:()=>Promise<void>):Promise<void>{
  if(this.failure)throw this.failure;
  while(this.active.size>=this.concurrency){await Promise.race(this.active);if(this.failure)throw this.failure;}
  let pending:Promise<void>;
  pending=Promise.resolve().then(task).catch(e=>{this.failure??=e;}).finally(()=>{this.active.delete(pending);});
  this.active.add(pending);
 }
 async drain():Promise<void>{await Promise.all([...this.active]);if(this.failure)throw this.failure;}
}
