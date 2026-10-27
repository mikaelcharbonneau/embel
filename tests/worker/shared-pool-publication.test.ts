import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { PollingQueueClient } from "@vercel/queue";
import { publishSharedStrategyOutboxOnce } from "../../worker/shared-pool/publication";
import { sharedConfiguration,sharedLease } from "./shared-pool-fixture";
const config=sharedConfiguration();
const descriptor={version:1,jobId:"77777777-7777-4777-8777-777777777777",operation:"strategy.reformulate",policyIdentity:"a".repeat(64),dispatchIdentity:"b".repeat(64),deploymentId:config.target.deploymentId,
 state:"queued",retryable:true,publicationGeneration:0,publishedMessageId:null,publishedAt:null};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
function harness(options:{acceptedOnly?:boolean;recordFails?:boolean}={}){
 const calls:Array<{method:string;headers:Headers;body:unknown}>=[];
 vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const url=new URL(input instanceof Request?input.url:input);expect(url.origin).toBe("https://broker.invalid");expect(url.pathname).toBe(`/api/v3/topic/${config.queue.topic}`);
  const headers=new Headers(init?.headers);expect(headers.get("Vqs-Deployment-Id")).toBe(config.target.deploymentId);calls.push({method:init?.method??"GET",headers,body:init?.body});
  return options.acceptedOnly?new Response(null,{status:202}):Response.json({messageId:"msg_actual_inert_broker"});}));
 const queue=new PollingQueueClient({region:"iad1",deploymentId:config.target.deploymentId,token:"synthetic-publisher-token",resolveBaseUrl:()=>new URL("https://broker.invalid"),telemetry:{isEnabled:false}});
 const writes:unknown[][]=[];let published=false;
 const database={async query(sql:string,values:unknown[]=[]){if(sql.includes("list_shared_strategy_dispatches"))return{rows:published?[]:[{dispatch:descriptor}]};
  expect(sql).toContain("shared_strategy_worker_action");writes.push(values);if(options.recordFails)throw Error("inert lost journal ACK");published=true;return{rows:[{envelope:{execution:null,result:true}}]};}};
 return{calls,writes,database,queue};
}
describe("same-project shared Strategy transactional outbox",()=>{
 it("uses actual SDK send and records only the actual broker ID with frozen publication generation",async()=>{
  const f=harness();expect(await publishSharedStrategyOutboxOnce({...f,lease:()=>sharedLease(config),configuration:config.queue},new AbortController().signal)).toBe(1);
  expect(f.calls).toHaveLength(1);expect(f.calls[0]!.headers.get("Vqs-Idempotency-Key")).toBe(descriptor.dispatchIdentity);
  expect(JSON.parse(String(f.writes[0]![2]))).toEqual({message:{version:1,jobId:descriptor.jobId,policyIdentity:descriptor.policyIdentity,deploymentId:descriptor.deploymentId,dispatchIdentity:descriptor.dispatchIdentity},values:[0,"msg_actual_inert_broker"]});
  expect(await publishSharedStrategyOutboxOnce({...f,lease:()=>sharedLease(config),configuration:config.queue},new AbortController().signal)).toBe(0);expect(f.calls).toHaveLength(1);
 });
 it("leaves an accepted send with null ID in the outbox",async()=>{
  const f=harness({acceptedOnly:true});expect(await publishSharedStrategyOutboxOnce({...f,lease:()=>sharedLease(config),configuration:config.queue},new AbortController().signal)).toBe(0);expect(f.writes).toHaveLength(0);
 });
 it("preserves an uncertain publication journal result for idempotent retry",async()=>{
  const f=harness({recordFails:true});await expect(publishSharedStrategyOutboxOnce({...f,lease:()=>sharedLease(config),configuration:config.queue},new AbortController().signal)).rejects.toThrow("journal");
  expect(f.calls).toHaveLength(1);expect(f.writes).toHaveLength(1);
 });
 it("does not mark publication after slot-generation loss during send",async()=>{
  const f=harness(),first=sharedLease(config);let current=first;
  const queue={send:async(...args:Parameters<typeof f.queue.send>)=>{const result=await f.queue.send(...args);current={...first,generation:2};return result;}};
  await expect(publishSharedStrategyOutboxOnce({database:f.database,queue,lease:()=>current,configuration:config.queue},new AbortController().signal)).rejects.toThrow("publication");expect(f.writes).toHaveLength(0);
 });
});
