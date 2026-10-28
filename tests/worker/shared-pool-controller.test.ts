import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createSharedPoolController,createSharedExecutionCapacity } from "../../worker/shared-pool/controller";
import type { SharedLaneEngine,SharedExecution } from "../../worker/shared-pool/contracts";
import type { SharedPoolSlot } from "../../worker/shared-pool/configuration";
import type { SharedSlotPool } from "../../worker/shared-pool/database";
import type { SharedQueuePort } from "../../worker/shared-pool/queue";
import { sharedConfiguration,sharedSecrets,sharedLease,sharedInstance } from "./shared-pool-fixture";
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function harness(options:{holdNaming?:boolean;holdLogoStartup?:boolean;readinessFailure?:boolean;generationMismatch?:boolean;releaseDenied?:boolean;pending?:boolean;fatalNaming?:boolean;fatalStrategy?:boolean}={}){
 const config=sharedConfiguration(),stop=new AbortController(),events:string[]=[],pools=new Map<string,SharedSlotPool>(),engines=new Map<string,SharedLaneEngine>();
 const renewals:Record<string,number>={},qualified:string[]=[],claims:Record<string,number>={},releaseFunctions:Array<()=>void>=[],startupReleases:Array<()=>void>=[];
 let active=0,maximum=0;
 const createPool=(_c:unknown,slot:SharedPoolSlot):SharedSlotPool=>{
  const pool:SharedSlotPool={qualify:vi.fn(async()=>{events.push(`qualify:${slot.lane}`);}),close:vi.fn(async()=>{events.push(`pool_close:${slot.lane}`);}),
   query:vi.fn(async(sql:string,args:unknown[]=[])=>{
    if(sql.includes("claim_shared_worker_slot")){claims[slot.lane]=(claims[slot.lane]??0)+1;return{rows:[{lease:sharedLease(config,slot.lane,String(args[1]),claims[slot.lane])}]};}
    if(sql.includes("renew_shared_worker_slot")){renewals[slot.lane]=(renewals[slot.lane]??0)+1;const lease=JSON.parse(String(args[0]));return{rows:[{lease:{...lease,expiresAt:new Date(Date.now()+45_000).toISOString(),...(options.generationMismatch&&slot.lane==="strategy"?{generation:lease.generation+1}:{})}}]};}
    if(sql.includes("read_shared_worker_execution_page")){
     const old:SharedExecution={version:1,executionId:"77777777-7777-4777-8777-777777777777",executionToken:"88888888-8888-4888-8888-888888888888",slotId:slot.slotId,instanceId:"99999999-9999-4999-8999-999999999999",generation:1,
      lane:slot.lane,ownerId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",projectId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",jobId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",leaseToken:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",operation:slot.lane==="naming"?"naming.generate":"strategy.reformulate",policyIdentity:"e".repeat(64),deploymentId:config.target.deploymentId};
     return{rows:[{page:{version:1,items:options.pending?[{execution:old,job:{immutable:"old-issued-input"},mode:"observe"}]:[],nextCursor:null}}]};
    }
    if(sql.includes("list_shared_strategy_dispatches"))return{rows:[]};
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
   recover:vi.fn(async pending=>{expect(pending).toHaveLength(1);events.push(`observe:${slot.lane}`);return{disposition:"retry" as const,state:"observation_required"};}),
   ...(slot.lane==="logo"?{renewReadiness:vi.fn(async()=>{events.push("ready_refresh:logo");if(options.readinessFailure)throw Error("Synthetic readiness acknowledgement lost");})}:{}),
   close:vi.fn(async()=>{events.push(`engine_close:${slot.lane}`);if(options.fatalNaming&&slot.lane==="naming"||options.fatalStrategy&&slot.lane==="strategy")throw Error(`shared_${slot.lane}_drain_unconfirmed`);})};engines.set(slot.lane,engine);return engine;
 });
 const queue:SharedQueuePort={receive:vi.fn(async()=>{await new Promise<void>(resolve=>{if(stop.signal.aborted)resolve();else stop.signal.addEventListener("abort",()=>resolve(),{once:true});});return{ok:false as const,reason:"empty" as const};}),send:vi.fn(async()=>({messageId:"msg_inert"}))};
 const controller=createSharedPoolController(config,sharedSecrets(config),{createPool,createEngine,queue,instanceId:sharedInstance,onQualified:lane=>qualified.push(lane)});
 const running=controller.run(stop.signal);void running.catch(()=>{});
 return{config,controller,stop,running,events,pools,engines,qualified,claims,renewals,releaseFunctions,startupReleases,get maximum(){return maximum;},createEngine};
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
