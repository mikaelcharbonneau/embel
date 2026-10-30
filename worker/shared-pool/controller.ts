import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sharedPendingPageSchema,sharedSlotLeaseSchema,type SharedSlotLease,type SharedLaneEngine,type SharedDeliveryResult } from "./contracts";
import type { SharedPoolConfiguration,SharedPoolSlot } from "./configuration";
import type { SharedPoolSecrets,SharedSlotSecret } from "./secrets";
import { createSharedSlotPool,type SharedSlotPool } from "./database";
import { createSharedStrategyQueue,runSharedStrategyQueue,type SharedQueuePort } from "./queue";
import { publishSharedStrategyOutboxOnce } from "./publication";
import { createSharedPoolBackoff } from "./backoff";

const unavailable=()=>Error("shared_pool_runtime_unavailable");
export type SharedEngineFactory=(options:{configuration:SharedPoolConfiguration;slot:SharedPoolSlot;secret:SharedSlotSecret;
 provider:SharedPoolSecrets["providers"]["strategy"];textProvider?:NonNullable<SharedPoolSecrets["providers"]["logoText"]>;database:SharedSlotPool;lease:()=>SharedSlotLease|null;signal:AbortSignal})=>Promise<SharedLaneEngine>;
/** FIFO local capacity supplements the database's authoritative finite slots
 * and owner bound. Waiting never holds a database transaction or admits work. */
export function createSharedExecutionCapacity(maximum:number){
 if(!Number.isInteger(maximum)||maximum<1||maximum>32)throw unavailable();let active=0;
 type Waiter={signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:Error)=>void;abort:()=>void};const waiting:Waiter[]=[];
 function promote(){while(active<maximum&&waiting.length){const next=waiting.shift()!;next.signal.removeEventListener("abort",next.abort);
  if(next.signal.aborted){next.reject(unavailable());continue;}active++;let released=false;
  next.resolve(()=>{if(released)return;released=true;active--;promote();});}}
 return{get active(){return active;},get waiting(){return waiting.length;},acquire(signal:AbortSignal):Promise<()=>void>{
  if(signal.aborted)return Promise.reject(unavailable());return new Promise((resolve,reject)=>{
   const item:Waiter={signal,resolve,reject,abort:()=>{const i=waiting.indexOf(item);if(i>=0)waiting.splice(i,1);reject(unavailable());}};
   waiting.push(item);signal.addEventListener("abort",item.abort,{once:true});promote();});
 }};
}
export function sharedPoolPause(ms:number,signal:AbortSignal){if(signal.aborted)return Promise.resolve();
 return new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener("abort",done);resolve();};const timer=setTimeout(done,ms);signal.addEventListener("abort",done,{once:true});});}
type SharedPoolDiagnosticCode="qualification_failed"|"slot_busy"|"claim_failed"|"renewal_failed"|"engine_start_failed"|"observation_failed"|"execution_failed"|"strategy_poll_failed"|"fence_unconfirmed"|"drain_unconfirmed";
export type SharedPoolDiagnostic={event:"shared_worker_pool_diagnostic";instanceId:string;lane:SharedPoolSlot["lane"];slotId:string;code:SharedPoolDiagnosticCode;attempt?:number;retryAfterMs?:number};
export type SharedPoolControllerDependencies={createPool?:typeof createSharedSlotPool;createEngine:SharedEngineFactory;queue?:SharedQueuePort;instanceId?:string;now?:()=>number;random?:()=>number;
 onQualified?:(lane:string,slotId:string)=>void;onDiagnostic?:(event:SharedPoolDiagnostic)=>void};
type SlotState={configuration:SharedPoolSlot;secret:SharedSlotSecret;pool:SharedSlotPool;lease:SharedSlotLease|null;engine:SharedLaneEngine|null;
 state:"standby"|"qualified"|"draining"|"unavailable";busy:boolean;signal:AbortSignal;operation:Promise<SharedDeliveryResult>|null;withdraw:()=>Promise<void>};
/** One process, a fixed number of actual restricted slot pools/engines, and no
 * per-customer map, password, child process, provider retry or invented drain. */
export function createSharedPoolController(config:SharedPoolConfiguration,secrets:SharedPoolSecrets,dependencies:SharedPoolControllerDependencies){
 const instanceId=z.uuid().parse(dependencies.instanceId??randomUUID()),now=dependencies.now??Date.now,lifetime=new AbortController(),capacity=createSharedExecutionCapacity(config.capacity.maxConcurrentExecutions);
 const states:SlotState[]=config.slots.map(slot=>{const secret=secrets.slots[slot.slotId];if(!secret)throw unavailable();
  return{configuration:slot,secret,pool:(dependencies.createPool??createSharedSlotPool)(config,slot,secret),lease:null,engine:null,state:"standby",busy:false,signal:lifetime.signal,operation:null,withdraw:async()=>{}};});
 let running:Promise<void>|undefined,closing:Promise<void>|undefined,queue:SharedQueuePort|undefined,closed=false,failed=false;
 function diagnose(slot:SharedPoolSlot,code:SharedPoolDiagnosticCode,retry?:{attempt:number;retryAfterMs:number}){
  // Only fixed codes and validated configuration IDs cross this boundary. Never
  // include caught errors, SQL, provider payloads or credentials in diagnostics.
  const event:SharedPoolDiagnostic={event:"shared_worker_pool_diagnostic",instanceId,lane:slot.lane,slotId:slot.slotId,code,...retry};
  try{if(dependencies.onDiagnostic)dependencies.onDiagnostic(event);else process.stderr.write(`${JSON.stringify(event)}\n`);}catch{ /* Diagnostics do not alter authority. */ }
 }
 function checkedLease(raw:unknown,state:SlotState,previous?:SharedSlotLease):SharedSlotLease{
  const lease=sharedSlotLeaseSchema.parse(raw),s=state.configuration;
  if(lease.slotId!==s.slotId||lease.instanceId!==instanceId||lease.lane!==s.lane||lease.roleName!==s.roleName||lease.roleOid!==s.roleOid||Date.parse(lease.expiresAt)<=now()+1000
   ||(previous&&(lease.generation!==previous.generation||lease.leaseToken!==previous.leaseToken)))throw unavailable();return lease;
 }
 const available=(state:SlotState)=>state.state==="qualified"&&!state.busy&&!state.signal.aborted&&state.lease!==null&&Date.parse(state.lease.expiresAt)>now()+1000;
 async function execute(state:SlotState,message?:unknown,signal:AbortSignal=state.signal):Promise<SharedDeliveryResult>{
  if(!available(state)||!state.engine)return{disposition:"retry",state:"slot_unavailable"};state.busy=true;
  const engine=state.engine,combined=AbortSignal.any([signal,state.signal,lifetime.signal]);
  const run=(async()=>{const release=await capacity.acquire(combined);try{
   combined.throwIfAborted();const result=await engine.run(message,combined);
   if(result.disposition==="retry"&&result.state==="stopping"&&!combined.aborted){await state.withdraw();throw unavailable();}
   return result;
  }catch(error){
   if(!combined.aborted||error instanceof Error&&/^shared_(strategy|naming|logo)_drain_unconfirmed$/u.test(error.message))await state.withdraw();
   throw error;
  }finally{release();}})();
  state.operation=run;
  try{return await run;}finally{state.operation=null;state.busy=false;}
 }
 async function slotLoop(state:SlotState){
  const spec=state.configuration,backoff=createSharedPoolBackoff(config.capacity.idlePollMs,dependencies.random);
  while(!lifetime.signal.aborted){
   const owner=new AbortController(),signal=AbortSignal.any([lifetime.signal,owner.signal]);state.signal=signal;let renew:Promise<void>|undefined,fence:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined,engineClosed=false,cursor:string|null=null;
   let phase:SharedPoolDiagnosticCode="qualification_failed",retryCode:SharedPoolDiagnosticCode|undefined,qualifiedAt:number|undefined;
   const resetAfterStableOwnership=()=>{if(qualifiedAt!==undefined&&now()-qualifiedAt>=config.capacity.leaseSeconds*1000)backoff.reset();};
   state.withdraw=async()=>{
    state.state="draining";owner.abort();clearInterval(timer);const lease=state.lease;if(!lease)return;
    await (fence??=(async()=>{try{
     const result=await state.pool.query("SELECT public.fence_shared_worker_slot($1::jsonb) fenced",[JSON.stringify(lease)]);
     if(result.rows.length!==1||result.rows[0]?.fenced!==true)throw unavailable();
    }catch{diagnose(spec,"fence_unconfirmed"); /* Stopped renewals retain the SQL expiry boundary. */ }})());
   };
   const observePage=async()=>{
    if(state.busy)return;state.busy=true;
    try{
    const pending=await state.pool.query("SELECT public.read_shared_worker_execution_page($1::jsonb,$2::uuid,$3) page",[JSON.stringify(state.lease),cursor,25]);
    if(pending.rows.length!==1)throw unavailable();const page=sharedPendingPageSchema.parse(pending.rows[0]?.page);
    if(page.items.some(value=>value.execution.slotId!==spec.slotId||value.execution.lane!==spec.lane)||page.nextCursor!==null
     &&(!page.items.length||page.nextCursor!==page.items.at(-1)!.execution.executionId||cursor!==null&&page.nextCursor<=cursor))throw unavailable();
    // Old issued uncertainty never enters run()/create or a process-wide owner
    // map. At most one bounded page is retained for scoped observation recovery.
    if(page.items.length&&state.engine?.recover){const release=await capacity.acquire(signal);try{await state.engine.recover(page.items,signal);}finally{release();}}
    cursor=page.nextCursor;
    }finally{state.busy=false;}
   };
   try{
    await state.pool.qualify();signal.throwIfAborted();
    phase="claim_failed";
    const claim=await state.pool.query("SELECT public.claim_shared_worker_slot($1::uuid,$2::uuid,$3,$4) lease",[spec.slotId,instanceId,config.target.deploymentId,config.capacity.leaseSeconds]);
    if(claim.rows.length!==1)throw unavailable();
    if(claim.rows[0]?.lease===null){retryCode="slot_busy";throw unavailable();}
    state.lease=checkedLease(claim.rows[0]?.lease,state);
    timer=setInterval(()=>{if(renew||signal.aborted)return;
     renew=(async()=>{const before=state.lease;if(!before)throw unavailable();
      const result=await state.pool.query("SELECT public.renew_shared_worker_slot($1::jsonb,$2) lease",[JSON.stringify(before),config.capacity.leaseSeconds]);
      if(result.rows.length!==1)throw unavailable();state.lease=checkedLease(result.rows[0]?.lease,state,before);
      if(state.state==="qualified")await state.engine?.renewReadiness?.();
     })().catch(()=>{retryCode="renewal_failed";return state.withdraw();}).finally(()=>{renew=undefined;});},config.capacity.renewalMs);timer.unref();
    phase="engine_start_failed";
    state.engine=await dependencies.createEngine({configuration:config,slot:spec,secret:state.secret,provider:secrets.providers[spec.lane],
     ...(spec.lane==="logo"&&spec.textProvider?{textProvider:secrets.providers.logoText}:{}),database:state.pool,lease:()=>state.lease,signal});
    signal.throwIfAborted();
    phase="observation_failed";
    await observePage();
    signal.throwIfAborted();state.state="qualified";qualifiedAt=now();try{dependencies.onQualified?.(spec.lane,spec.slotId);}catch{ /* Diagnostics never grant or revoke authority. */ }
    if(spec.lane==="strategy"){
     const outboxBackoff=createSharedPoolBackoff(config.capacity.idlePollMs,dependencies.random);
     while(!signal.aborted){
      let pause=config.capacity.idlePollMs,succeeded=false;
      try{if(!state.busy)await observePage();if(!queue)throw unavailable();await publishSharedStrategyOutboxOnce({database:state.pool,lease:()=>state.lease,queue,configuration:config.queue},signal);succeeded=true;}
      catch{if(!signal.aborted){const retry=outboxBackoff.next();pause=retry.retryAfterMs;diagnose(spec,"strategy_poll_failed",retry);}}
      // A successful poll recovers this independent outbox retry schedule.
      // Lease renewal and queue deliveries never wait for its delay.
      if(succeeded)outboxBackoff.reset();
      await sharedPoolPause(pause,signal);
     }
    }else while(!signal.aborted){
     phase="observation_failed";
     await observePage();
     phase="execution_failed";
     const result=await execute(state,undefined,signal);
     if(result.disposition==="retry"||["idle","not_found","busy","unavailable"].includes(result.state))await sharedPoolPause(config.capacity.idlePollMs,signal);
    }
   }catch(error){
    if(!lifetime.signal.aborted){
     const held=phase==="claim_failed"&&error instanceof Error&&error.message==="shared_slot_held"&&"code" in error&&error.code==="40001";
     retryCode??=held?"slot_busy":phase;
    }
    state.state="unavailable";await state.withdraw();
   }
   finally{
    state.state="draining";owner.abort();clearInterval(timer);await renew?.catch(()=>{});
    try{
     await state.operation?.catch(()=>{});
     if(state.engine){await state.engine.close();engineClosed=true;}
     if(state.lease&&engineClosed){
      // SQL independently decides whether local execution authority can be
      // released. A false/unconfirmed result is never translated to stopped.
      const release=await state.pool.query("SELECT public.release_shared_worker_slot($1::jsonb) released",[JSON.stringify(state.lease)]);
      if(release.rows.length!==1||release.rows[0]?.released!==true)throw unavailable();
     }
    }catch{diagnose(spec,"drain_unconfirmed");failed=true;lifetime.abort();}
    resetAfterStableOwnership();
    state.lease=null;state.engine=null;state.busy=false;state.state=failed?"unavailable":"standby";
   }
   if(!lifetime.signal.aborted){const retry=backoff.next();diagnose(spec,retryCode??"execution_failed",retry);await sharedPoolPause(retry.retryAfterMs,lifetime.signal);}
  }
 }
 const controller={instanceId,
  status(){return{instanceId,active:capacity.active,waiting:capacity.waiting,slots:states.map(s=>({slotId:s.configuration.slotId,lane:s.configuration.lane,state:s.state,busy:s.busy,generation:s.lease?.generation??null}))};},
  async deliverStrategy(message:unknown,signal:AbortSignal=lifetime.signal):Promise<SharedDeliveryResult>{
   if(closed||lifetime.signal.aborted)return{disposition:"retry",state:"stopping"};const state=states.find(s=>s.configuration.lane==="strategy"&&available(s));
   return state?execute(state,message,signal):{disposition:"retry",state:"slot_unavailable"};
  },
  run(signal:AbortSignal):Promise<void>{
   if(running)return running;if(closed)return Promise.reject(unavailable());
   const abort=()=>lifetime.abort();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)lifetime.abort();
   queue=dependencies.queue??createSharedStrategyQueue(config.queue);
   running=(async()=>{try{
    await Promise.all([...states.map(slotLoop),runSharedStrategyQueue({configuration:config.queue,queue:queue!,available:()=>states.some(s=>s.configuration.lane==="strategy"&&available(s)),
     deliver:(message,deliverySignal)=>controller.deliverStrategy(message,deliverySignal)},lifetime.signal)]);
    if(failed)throw unavailable();
   }finally{signal.removeEventListener("abort",abort);}})();return running;
  },
  close():Promise<void>{
   if(closing)return closing;closed=true;lifetime.abort();
   closing=(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{
    const drain=(async()=>{await Promise.all(states.map(s=>s.withdraw()));await running;})();
    await Promise.race([drain,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),config.capacity.drainTimeoutMs);})]);
    await Promise.all(states.map(s=>s.pool.close()));if(failed)throw unavailable();
   }finally{clearTimeout(timer);}})();return closing;
  },
 };return controller;
}
