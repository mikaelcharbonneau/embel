import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createSharedPoolController,createSharedExecutionCapacity,type SharedPoolDiagnostic } from "../../worker/shared-pool/controller";
import { createSharedPoolBackoff } from "../../worker/shared-pool/backoff";
import type { SharedLaneEngine,SharedExecution } from "../../worker/shared-pool/contracts";
import type { SharedPoolSlot } from "../../worker/shared-pool/configuration";
import type { SharedSlotPool } from "../../worker/shared-pool/database";
import type { SharedQueuePort } from "../../worker/shared-pool/queue";
import { sharedConfiguration,sharedSecrets,sharedLease,sharedInstance } from "./shared-pool-fixture";
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function harness(options:{holdNaming?:boolean;holdLogoStartup?:boolean;readinessFailure?:boolean;generationMismatch?:boolean;releaseDenied?:boolean;pending?:boolean;fatalNaming?:boolean;fatalStrategy?:boolean;
 logoQualificationFailures?:number;logoClaim?:"standby"|"held"|"error";outboxFailure?:boolean;defaultDiagnostics?:boolean;throwDiagnostics?:boolean;pendingNamingCount?:number}={}){
 const config=sharedConfiguration(),stop=new AbortController(),events:string[]=[],pools=new Map<string,SharedSlotPool>(),engines=new Map<string,SharedLaneEngine>();
 const diagnostics:SharedPoolDiagnostic[]=[],qualifications:Record<string,number>={},recoveredNaming:string[]=[];let outboxPolls=0;
 const renewals:Record<string,number>={},qualified:string[]=[],claims:Record<string,number>={},releaseFunctions:Array<()=>void>=[],startupReleases:Array<()=>void>=[];
 let active=0,maximum=0;
 const createPool=(_c:unknown,slot:SharedPoolSlot):SharedSlotPool=>{
  const pool:SharedSlotPool={qualify:vi.fn(async()=>{events.push(`qualify:${slot.lane}`);qualifications[slot.lane]=(qualifications[slot.lane]??0)+1;
   if(slot.lane==="logo"&&qualifications.logo!<=(options.logoQualificationFailures??0))throw Error("Synthetic secret password and SQL must not appear in diagnostics");}),close:vi.fn(async()=>{events.push(`pool_close:${slot.lane}`);}),
   query:vi.fn(async(sql:string,args:unknown[]=[])=>{
    if(sql.includes("claim_shared_worker_slot")){claims[slot.lane]=(claims[slot.lane]??0)+1;
     if(slot.lane==="logo"&&options.logoClaim==="standby")return{rows:[{lease:null}]};
     if(slot.lane==="logo"&&options.logoClaim==="held")throw Object.assign(Error("shared_slot_held"),{code:"40001"});
     if(slot.lane==="logo"&&options.logoClaim==="error")throw Error("Synthetic secret password and SQL must not appear in diagnostics");
     return{rows:[{lease:sharedLease(config,slot.lane,String(args[1]),claims[slot.lane])}]};}
    if(sql.includes("renew_shared_worker_slot")){renewals[slot.lane]=(renewals[slot.lane]??0)+1;const lease=JSON.parse(String(args[0]));return{rows:[{lease:{...lease,expiresAt:new Date(Date.now()+45_000).toISOString(),...(options.generationMismatch&&slot.lane==="strategy"?{generation:lease.generation+1}:{})}}]};}
    if(sql.includes("read_shared_worker_execution_page")){
     const old:SharedExecution={version:1,executionId:"77777777-7777-4777-8777-777777777777",executionToken:"88888888-8888-4888-8888-888888888888",slotId:slot.slotId,instanceId:"99999999-9999-4999-8999-999999999999",generation:1,
      lane:slot.lane,ownerId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",projectId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",jobId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",leaseToken:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",operation:slot.lane==="naming"?"naming.generate":"strategy.reformulate",policyIdentity:"e".repeat(64),deploymentId:config.target.deploymentId};
     const count=slot.lane==="naming"?options.pendingNamingCount??1:1;
     const pending=options.pending?Array.from({length:count},(_,index)=>({execution:{...old,executionId:`77777777-7777-4777-8777-${String(index+1).padStart(12,"0")}`},job:{immutable:"old-issued-input"},mode:"observe"})):[];
     const remaining=pending.filter(row=>args[1]===null||row.execution.executionId>String(args[1])),items=remaining.slice(0,Number(args[2]));
     return{rows:[{page:{version:1,items,nextCursor:remaining.length>items.length?items.at(-1)!.execution.executionId:null}}]};
    }
    if(sql.includes("list_shared_strategy_dispatches")){outboxPolls++;if(options.outboxFailure)throw Error("Synthetic secret outbox payload");return{rows:[]};}
    if(sql.includes("fence_shared_worker_slot")){events.push(`fence:${slot.lane}`);return{rows:[{fenced:true}]};}
    if(sql.includes("release_shared_worker_slot")){events.push(`release:${slot.lane}`);return{rows:[{released:!options.releaseDenied}]};}
    throw Error("Unexpected inert SQL");
   })};pools.set(slot.slotId,pool);return pool;
 };
 const createEngine=vi.fn(async({slot,lease}:{slot:SharedPoolSlot;lease:()=>unknown}):Promise<SharedLaneEngine>=>{
  expect(lease()).toBeTruthy();events.push(`engine:${slot.lane}`);
  if(options.holdLogoStartup&&slot.lane==="logo")await new Promise<void>(resolve=>startupReleases.push(resolve));
  const engine:SharedLaneEngine={run:vi.fn(async(message?:unknown)=>{events.push(`run:${slot.lane}`);active++;maximum=Math.max(maximum,active);
   try{if(options.fatalNaming&&slot.lane==="naming"||options.fatalStrategy&&slot.lane==="strategy")throw Error(`shared_${slot.lane}_drain_unconfirmed`);
    if(options.holdNaming&&slot.lane==="naming")await new Promise<void>(resolve=>releaseFunctions.push(resolve));
    if(slot.lane!=="strategy")expect(message).toBeUndefined();return{disposition:"ack" as const,state:slot.lane==="strategy"?"succeeded":"idle"};}finally{active--;}}),
   recover:vi.fn(async pending=>{expect(pending).toHaveLength(1);events.push(`observe:${slot.lane}`);if(slot.lane==="naming")recoveredNaming.push(pending[0]!.execution.executionId);return{disposition:"retry" as const,state:"observation_required"};}),
   ...(slot.lane==="logo"?{renewReadiness:vi.fn(async()=>{events.push("ready_refresh:logo");if(options.readinessFailure)throw Error("Synthetic readiness acknowledgement lost");})}:{}),
   close:vi.fn(async()=>{events.push(`engine_close:${slot.lane}`);if(options.fatalNaming&&slot.lane==="naming"||options.fatalStrategy&&slot.lane==="strategy")throw Error(`shared_${slot.lane}_drain_unconfirmed`);})};engines.set(slot.lane,engine);return engine;
 });
 const queue:SharedQueuePort={receive:vi.fn(async()=>{await new Promise<void>(resolve=>{if(stop.signal.aborted)resolve();else stop.signal.addEventListener("abort",()=>resolve(),{once:true});});return{ok:false as const,reason:"empty" as const};}),send:vi.fn(async()=>({messageId:"msg_inert"}))};
 const controller=createSharedPoolController(config,sharedSecrets(config),{createPool,createEngine,queue,instanceId:sharedInstance,random:()=>1,onQualified:lane=>qualified.push(lane),
  ...(!options.defaultDiagnostics?{onDiagnostic:(event:SharedPoolDiagnostic)=>{diagnostics.push(event);if(options.throwDiagnostics)throw Error("Synthetic diagnostic sink unavailable");}}:{})});
 const running=controller.run(stop.signal);void running.catch(()=>{});
 return{config,controller,stop,running,events,pools,engines,qualified,claims,renewals,qualifications,diagnostics,releaseFunctions,startupReleases,recoveredNaming,get maximum(){return maximum;},get outboxPolls(){return outboxPolls;},createEngine};
}
describe("fixed shared slot lifecycle (inert ports; SQL authority tested separately)",()=>{
 it("constructs only configured slot resources, composes all three lanes and drains actual work before lease release",async()=>{
  const f=harness();await vi.waitFor(()=>expect(f.qualified).toHaveLength(3));expect(f.createEngine).toHaveBeenCalledTimes(3);expect(f.pools.size).toBe(3);
  expect(await f.controller.deliverStrategy({immutable:"inert descriptor"})).toEqual({disposition:"ack",state:"succeeded"});
  f.stop.abort();await f.running;await f.controller.close();expect(f.maximum).toBeLessThanOrEqual(3);
  for(const lane of ["strategy","naming","logo"]){expect(f.events.indexOf(`engine_close:${lane}`)).toBeLessThan(f.events.indexOf(`release:${lane}`));}
  expect(f.events.filter(v=>v.startsWith("release:"))).toHaveLength(3);
 });
 it("routes historical issued work only through observation, never as a new engine input",async()=>{
  const f=harness({pending:true});await vi.waitFor(()=>expect(f.qualified).toHaveLength(3));
  for(const lane of ["strategy","naming","logo"]){expect(f.engines.get(lane)!.recover).toHaveBeenCalled();
   for(const call of vi.mocked(f.engines.get(lane)!.run).mock.calls)expect(call[0]).toBeUndefined();}
  f.stop.abort();await f.running;await f.controller.close();
 });
 it("reaches every Naming execution even when earlier recoveries remain unresolved across page boundaries",async()=>{
  vi.useFakeTimers();const f=harness({pending:true,pendingNamingCount:30});
  await vi.advanceTimersByTimeAsync(2900);
  expect(new Set(f.recoveredNaming.slice(0,30)).size).toBe(30);
  expect(f.recoveredNaming[30]).toBe(f.recoveredNaming[0]);
  const namingPool=f.pools.get(f.config.slots.find(slot=>slot.lane==="naming")!.slotId)!;
  expect(vi.mocked(namingPool.query).mock.calls.filter(([sql])=>sql.includes("read_shared_worker_execution_page")).every(([,args])=>args?.[2]===1)).toBe(true);
  for(const lane of ["strategy","logo"]){const pool=f.pools.get(f.config.slots.find(slot=>slot.lane===lane)!.slotId)!;
   expect(vi.mocked(pool.query).mock.calls.filter(([sql])=>sql.includes("read_shared_worker_execution_page")).every(([,args])=>args?.[2]===25)).toBe(true);}
  f.stop.abort();await vi.advanceTimersByTimeAsync(0);await f.running;await f.controller.close();
 });
 it("retains local capacity and refuses a successful drain while a noncooperative engine is still executing",async()=>{
  const f=harness({holdNaming:true});await vi.waitFor(()=>expect(f.releaseFunctions).toHaveLength(1));f.stop.abort();
  const close=f.controller.close();await expect(close).rejects.toThrow("runtime");
  expect(f.events).not.toContain("release:naming");expect(f.events).not.toContain("engine_close:naming");
  f.releaseFunctions.forEach(fn=>fn());await f.running;expect(f.events).toContain("release:naming");
 });
 it("never turns a refused SQL release into a stopped proof",async()=>{
  const f=harness({releaseDenied:true});await vi.waitFor(()=>expect(f.qualified).toHaveLength(3));f.stop.abort();await expect(f.running).rejects.toThrow("runtime");await expect(f.controller.close()).rejects.toThrow("runtime");
 });
 it("rejects a renewal that changes generation instead of adopting fresh authority silently",async()=>{
  vi.useFakeTimers();const f=harness({generationMismatch:true});await vi.advanceTimersByTimeAsync(0);expect(f.qualified).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(10_001);expect(f.events).toContain("engine_close:strategy");expect(f.renewals.strategy).toBe(1);
  f.stop.abort();await vi.advanceTimersByTimeAsync(0);await f.running;await f.controller.close();
 });
 it("renews readiness only after startup qualification completes, while preserving the slot lease during startup",async()=>{
  vi.useFakeTimers();const f=harness({holdLogoStartup:true});await vi.advanceTimersByTimeAsync(0);
  expect(f.qualified).toHaveLength(2);await vi.advanceTimersByTimeAsync(10001);
  expect(f.renewals.logo).toBe(1);expect(f.events).not.toContain("ready_refresh:logo");
  f.startupReleases[0]!();await vi.advanceTimersByTimeAsync(0);expect(f.qualified).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(10000);expect(f.events.filter(event=>event==="ready_refresh:logo")).toHaveLength(1);
  f.stop.abort();await vi.advanceTimersByTimeAsync(0);await f.running;await f.controller.close();
 });
 it("withdraws a worker whose readiness refresh is unconfirmed rather than keeping it advertised",async()=>{
  vi.useFakeTimers();const f=harness({readinessFailure:true});await vi.advanceTimersByTimeAsync(0);expect(f.qualified).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(10001);
  expect(f.events).toContain("fence:logo");expect(f.controller.status().slots.find(slot=>slot.lane==="logo")!.state).not.toBe("qualified");
  f.stop.abort();await vi.advanceTimersByTimeAsync(0);await f.running;await f.controller.close();
 });
 it("fences a fatal Naming journal failure instead of renewing a qualified-but-stopping slot forever",async()=>{
  const f=harness({fatalNaming:true});await vi.waitFor(()=>expect(f.events).toContain("fence:naming"));
  expect(f.controller.status().slots.find(s=>s.lane==="naming")!.state).not.toBe("qualified");expect(f.events).not.toContain("release:naming");
  f.stop.abort();await expect(f.running).rejects.toThrow("runtime");await expect(f.controller.close()).rejects.toThrow("runtime");
  expect(f.renewals.naming??0).toBe(0);
 });
 it("retires Strategy on an unexpected delivery failure rather than letting the queue loop hide an unhealthy engine",async()=>{
  const f=harness({fatalStrategy:true});await vi.waitFor(()=>expect(f.qualified).toHaveLength(3));
  await expect(f.controller.deliverStrategy({immutable:"inert descriptor"})).rejects.toThrow("drain_unconfirmed");
  expect(f.events).toContain("fence:strategy");expect(f.controller.status().slots.find(s=>s.lane==="strategy")!.state).not.toBe("qualified");
  f.stop.abort();await expect(f.running).rejects.toThrow("runtime");await expect(f.controller.close()).rejects.toThrow("runtime");
 });
});
describe("shared slot outage backoff",()=>{
 it("bounds failed qualification traffic while healthy lanes keep polling and renewing",async()=>{
  vi.useFakeTimers();const f=harness({logoQualificationFailures:Infinity});await vi.advanceTimersByTimeAsync(0);
  expect(f.qualifications.logo).toBe(1);expect(f.qualified).toEqual(["strategy","naming"]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.qualifications.logo).toBe(6);expect(f.claims.logo).toBeUndefined();expect(f.engines.has("logo")).toBe(false);
  expect(f.qualifications.strategy).toBe(1);expect(f.renewals.strategy).toBe(6);expect(f.renewals.naming).toBe(6);
  expect(f.engines.get("naming")!.run).toHaveBeenCalledTimes(601);
  expect(f.diagnostics.map(event=>event.retryAfterMs)).toEqual([1000,2000,4000,8000,16000,30000]);
  expect(f.diagnostics.every(event=>event.code==="qualification_failed"&&event.lane==="logo")).toBe(true);
  const stoppedAt=Date.now();f.stop.abort();await f.running;await f.controller.close();expect(Date.now()).toBe(stoppedAt);
  expect(f.events.filter(event=>event.startsWith("pool_close:"))).toHaveLength(3);
 });
 it.each(["standby","held","error"] as const)("backs off %s claims before repeating authority qualification",async logoClaim=>{
  vi.useFakeTimers();const f=harness({logoClaim});await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(999);expect(f.claims.logo).toBe(1);
  await vi.advanceTimersByTimeAsync(1);expect(f.claims.logo).toBe(2);
  await vi.advanceTimersByTimeAsync(1999);expect(f.claims.logo).toBe(2);
  await vi.advanceTimersByTimeAsync(1);expect(f.claims.logo).toBe(3);expect(f.qualifications.logo).toBe(3);
  expect(f.engines.has("logo")).toBe(false);expect(f.events).not.toContain("release:logo");
  expect(f.diagnostics.map(event=>event.code)).toEqual(Array(3).fill(logoClaim==="error"?"claim_failed":"slot_busy"));
  f.stop.abort();await f.running;await f.controller.close();
 });
 it("keeps increasing delays when short-lived ownership repeatedly loses renewal",async()=>{
  vi.useFakeTimers();const f=harness({readinessFailure:true});await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10_000);expect(f.claims.logo).toBe(1);
  expect(f.diagnostics.at(-1)).toMatchObject({code:"renewal_failed",attempt:1,retryAfterMs:1000});
  await vi.advanceTimersByTimeAsync(1000);expect(f.claims.logo).toBe(2);
  await vi.advanceTimersByTimeAsync(10_000);expect(f.claims.logo).toBe(2);
  expect(f.diagnostics.at(-1)).toMatchObject({code:"renewal_failed",attempt:2,retryAfterMs:2000});
  await vi.advanceTimersByTimeAsync(1999);expect(f.claims.logo).toBe(2);
  await vi.advanceTimersByTimeAsync(1);expect(f.claims.logo).toBe(3);expect(f.renewals.strategy).toBe(2);
  f.stop.abort();await f.running;await f.controller.close();
 });
 it("resets accumulated failure delay after a full healthy ownership window",async()=>{
  vi.useFakeTimers();const options={logoQualificationFailures:2,readinessFailure:false},f=harness(options);
  await vi.advanceTimersByTimeAsync(3000);expect(f.claims.logo).toBe(1);expect(f.diagnostics.map(event=>event.attempt)).toEqual([1,2]);
  await vi.advanceTimersByTimeAsync(45_000);options.readinessFailure=true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.diagnostics.at(-1)).toMatchObject({code:"renewal_failed",attempt:1,retryAfterMs:1000});
  await vi.advanceTimersByTimeAsync(1000);expect(f.claims.logo).toBe(2);
  f.stop.abort();await f.running;await f.controller.close();
 });
 it("backs off failed outbox scans without slowing renewal or healthy queue deliveries",async()=>{
  vi.useFakeTimers();const options={outboxFailure:true},f=harness(options);await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(15_000);expect(f.outboxPolls).toBe(5);expect(f.renewals.strategy).toBe(1);
  expect(f.diagnostics.map(event=>event.retryAfterMs)).toEqual([1000,2000,4000,8000,16000]);
  expect(f.diagnostics.every(event=>event.code==="strategy_poll_failed")).toBe(true);
  expect(await f.controller.deliverStrategy({immutable:"inert descriptor"})).toEqual({disposition:"ack",state:"succeeded"});
  options.outboxFailure=false;await vi.advanceTimersByTimeAsync(16_000);expect(f.outboxPolls).toBe(6);
  await vi.advanceTimersByTimeAsync(100);expect(f.outboxPolls).toBe(7);expect(f.renewals.strategy).toBe(3);
  f.stop.abort();await f.running;await f.controller.close();
 });
 it("writes only structured fixed codes and IDs when no custom diagnostic sink exists",async()=>{
  vi.useFakeTimers();const write=vi.spyOn(process.stderr,"write").mockReturnValue(true),f=harness({logoQualificationFailures:1,defaultDiagnostics:true});
  await vi.advanceTimersByTimeAsync(0);expect(write).toHaveBeenCalledTimes(1);
  const line=String(write.mock.calls[0]![0]);expect(line.endsWith("\n")).toBe(true);
  expect(JSON.parse(line)).toEqual({event:"shared_worker_pool_diagnostic",instanceId:sharedInstance,lane:"logo",slotId:f.config.slots[2]!.slotId,code:"qualification_failed",attempt:1,retryAfterMs:1000});
  expect(line).not.toMatch(/secret|password|SQL/u);
  f.stop.abort();await f.running;await f.controller.close();
 });
 it("does not let broken diagnostics interrupt recovery",async()=>{
  vi.useFakeTimers();const f=harness({logoQualificationFailures:1,throwDiagnostics:true});await vi.advanceTimersByTimeAsync(1000);
  expect(f.qualifications.logo).toBe(2);expect(f.qualified).toContain("logo");
  f.stop.abort();await f.running;await f.controller.close();
 });
});
describe("bounded shared pool retry jitter",()=>{
 it("spreads attempts within a positive range and caps sustained outage delays",()=>{
  const early=createSharedPoolBackoff(100,()=>0),late=createSharedPoolBackoff(100,()=>1);
  expect(early.next()).toEqual({attempt:1,retryAfterMs:500});expect(late.next()).toEqual({attempt:1,retryAfterMs:1000});
  for(let i=0;i<40;i++){expect(early.next().retryAfterMs).toBeGreaterThan(0);expect(late.next().retryAfterMs).toBeLessThanOrEqual(30_000);}
  expect(early.next()).toEqual({attempt:32,retryAfterMs:15_000});expect(late.next()).toEqual({attempt:32,retryAfterMs:30_000});
  early.reset();expect(early.next()).toEqual({attempt:1,retryAfterMs:500});
 });
});
describe("bounded local execution semaphore",()=>{
 it("enforces a fixed ceiling, FIFO fairness and idempotent release across lanes",async()=>{
  const gate=createSharedExecutionCapacity(1),a=new AbortController(),b=new AbortController(),c=new AbortController(),release=await gate.acquire(a.signal),order:string[]=[];
  const second=gate.acquire(b.signal).then(fn=>{order.push("b");return fn;}),third=gate.acquire(c.signal).then(fn=>{order.push("c");return fn;});
  expect(gate.active).toBe(1);expect(gate.waiting).toBe(2);release();release();const releaseB=await second;expect(order).toEqual(["b"]);expect(gate.active).toBe(1);releaseB();const releaseC=await third;expect(order).toEqual(["b","c"]);releaseC();expect(gate.active).toBe(0);
 });
 it("cancels a waiting turn without consuming or freeing another lane's capacity",async()=>{
  const gate=createSharedExecutionCapacity(1),stop=new AbortController(),release=await gate.acquire(new AbortController().signal),waiting=gate.acquire(stop.signal);stop.abort();await expect(waiting).rejects.toThrow("runtime");expect(gate.active).toBe(1);expect(gate.waiting).toBe(0);release();expect(gate.active).toBe(0);
 });
});
