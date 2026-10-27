import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { PollingQueueClient } from "@vercel/queue";
import { receiveSharedStrategyOnce,runSharedStrategyQueue,type SharedQueueReceiverPort } from "../../worker/shared-pool/queue";
import { sharedConfiguration } from "./shared-pool-fixture";
const config=()=>sharedConfiguration().queue;
const message={version:1,jobId:"77777777-7777-4777-8777-777777777777",policyIdentity:"a".repeat(64),dispatchIdentity:"b".repeat(64),deploymentId:config().deploymentId};
function received(){return new Response(["--inert-boundary","Content-Type: application/json","Vqs-Message-Id: msg_inert","Vqs-Receipt-Handle: receipt_inert","Vqs-Delivery-Count: 2",`Vqs-Timestamp: ${new Date().toISOString()}`,"",JSON.stringify(message),"--inert-boundary--",""]
 .join("\r\n"),{headers:{"content-type":"multipart/mixed; boundary=inert-boundary"}});}
function harness(receive?:()=>Promise<Response>){
 const calls:Array<{method:string;path:string;body?:string;headers:Headers}>=[];
 vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(input instanceof Request?input.url:input);expect(url.origin).toBe("https://broker.invalid");
  const method=init?.method??"GET",headers=new Headers(init?.headers);expect(headers.get("authorization")).toBe("Bearer synthetic-shared-queue-token");expect(headers.get("Vqs-Deployment-Id")).toBe(config().deploymentId);
  calls.push({method,path:url.pathname,body:typeof init?.body==="string"?init.body:undefined,headers});
  if(method==="POST"){expect(url.pathname).toBe(`/api/v3/topic/${config().topic}/consumer/${config().consumerGroup}`);expect(headers.get("Vqs-Max-Messages")).toBe("1");return receive?receive():received();}
  expect(url.pathname).toBe(`/api/v3/topic/${config().topic}/consumer/${config().consumerGroup}/lease/receipt_inert`);expect(["DELETE","PATCH"]).toContain(method);return new Response(null,{status:204});
 }));
 const queue=new PollingQueueClient({region:"iad1",deploymentId:config().deploymentId,token:"synthetic-shared-queue-token",resolveBaseUrl:()=>new URL("https://broker.invalid"),telemetry:{isEnabled:false}});
 return{queue,calls};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("shared outbound polling over actual installed Queue SDK (no network)",()=>{
 it("receives the fixed group/region/deployment and acknowledges only qualified durable engine ACK",async()=>{
  const f=harness(),deliver=vi.fn(async()=>({disposition:"ack" as const,state:"needs_reconciliation"}));
  expect(await receiveSharedStrategyOnce({configuration:config(),queue:f.queue,deliver},new AbortController().signal)).toEqual({ok:true});
  expect(deliver.mock.calls).toHaveLength(1);expect(f.calls.map(c=>c.method)).toEqual(["POST","DELETE"]);
 });
 it("reschedules retry/uncertain journal writes without ACK",async()=>{
  const f=harness();await receiveSharedStrategyOnce({configuration:config(),queue:f.queue,deliver:async()=>({disposition:"retry",state:"journal_unconfirmed"})},new AbortController().signal);
  expect(f.calls.map(c=>c.method)).toEqual(["POST","PATCH"]);expect(f.calls[1]!.body).toBe('{"visibilityTimeoutSeconds":120}');
 });
 it("does not mistake a delivery exception for successful work",async()=>{
  const f=harness();await receiveSharedStrategyOnce({configuration:config(),queue:f.queue,deliver:async()=>{throw Error("inert unconfirmed write");}},new AbortController().signal);
  expect(f.calls.map(c=>c.method)).toEqual(["POST","PATCH"]);
 });
 it("does not dispatch a receive delivered after shutdown and drains the SDK lifecycle",async()=>{
  let release!:(response:Response)=>void;const f=harness(()=>new Promise(resolve=>{release=resolve;})),stop=new AbortController(),deliver=vi.fn(async()=>({disposition:"ack" as const,state:"succeeded"}));
  let done=false;const running=runSharedStrategyQueue({configuration:config(),queue:f.queue,deliver},stop.signal).finally(()=>{done=true;});
  await vi.waitFor(()=>expect(f.calls).toHaveLength(1));stop.abort();await Promise.resolve();expect(done).toBe(false);
  release(received());await running;expect(deliver).not.toHaveBeenCalled();expect(f.calls.map(c=>c.method)).toEqual(["POST","PATCH"]);
 });
 it("an aborted handler remains occupied until it settles and can never return a late ACK",async()=>{
  vi.useFakeTimers();const f=harness(),stop=new AbortController();let release!:()=>void,observed:AbortSignal|undefined;
  const once=receiveSharedStrategyOnce({configuration:{...config(),handlerDeadlineMs:1000},queue:f.queue,deliver:async(_m,signal)=>{observed=signal;await new Promise<void>(resolve=>{release=resolve;});return{disposition:"ack",state:"succeeded"};}},stop.signal);
  await vi.advanceTimersByTimeAsync(1001);expect(observed?.aborted).toBe(true);expect(f.calls.map(c=>c.method)).toEqual(["POST"]);
  release();await once;expect(f.calls.map(c=>c.method)).toEqual(["POST","PATCH"]);
 });
 it("bounds concurrent receive lifecycles and stops starting new ones on abort",async()=>{
  const stop=new AbortController();let active=0,maximum=0,calls=0;const release:Array<()=>void>=[];
  const queue:SharedQueueReceiverPort={async receive(){calls++;active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>release.push(resolve));active--;return{ok:false,reason:"empty"};}};
  const running=runSharedStrategyQueue({configuration:{...config(),concurrency:2},queue,deliver:async()=>({disposition:"ack",state:"succeeded"})},stop.signal);
  await vi.waitFor(()=>expect(calls).toBe(2));stop.abort();release.forEach(fn=>fn());await running;expect(maximum).toBe(2);expect(calls).toBe(2);
 });
});
