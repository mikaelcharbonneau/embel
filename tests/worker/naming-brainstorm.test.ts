import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema } from "../../src/domain/naming-brain";
import { filterNamingBrainstormCandidates, namingBrainstormIdentity, type NamingBrainstormWire } from "../../src/domain/naming-brainstorm";
import { createNamingBrainstormProvider } from "../../src/server/ai/naming-brainstorm-provider";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { observeNamingBrainstorm, runNamingBrainstorm, type NamingBrainstormGateway } from "../../worker/naming-brainstorm";
import { id, snapshot, preferences, hash } from "../domain/naming-brain-fixtures";
import type { ClaimedJob } from "../../src/domain/jobs";

type Call = {callId:string;request:NamingBrainstormWire;candidateTarget:number;state:string;responseId:string|null;requestId:string|null;candidates:unknown[]};
function fixture(options:{counts?:number[];lostBeforeId?:boolean;lostAfterId?:boolean;loseCreatedAck?:boolean;loseCompletedAck?:boolean;denyBegin?:boolean;badCandidates?:boolean}={}) {
  const input=namingBrainJobInputSchema.parse({version:2,handlerVersion:"naming-brain-v1",billingMode:"openai_api",runId:id(3),jobId:id(4),batchId:id(5),snapshot:snapshot(),acceptedPolicyIdentity:hash,policy:createNamingBrainPolicy("gpt-6-luna"),executionAuthority:"hosted_owner_v1",providerBudgetVersion:2,localPipelineVersion:2,localTimingVersion:2,generationProfile:"brainstorm_v1"});
  const job:ClaimedJob={id:input.jobId,ownerId:input.snapshot.ownerId,projectId:input.snapshot.projectId,operation:"naming.generate",input,inputRevision:1,leaseToken:id(6),status:"running",reservedCostMicrousd:input.policy.runAllowanceMicrousd,actualCostMicrousd:0};
  const state={generationProfile:"brainstorm_v1",runId:input.runId,brief:input.snapshot,exclusionIdentities:[namingBrainstormIdentity("Owned Name")],historyEpoch:0,history:[{candidateId:id(9),value:"Owned Name"}],publishedCount:0,calls:[] as Call[]};
  const actions:string[]=[],methods:string[]=[],bodies:NamingBrainstormWire[]=[],responses=new Map<string,Record<string,unknown>>();
  let createdSaved=false,loseCreated=options.loseCreatedAck,loseCompleted=options.loseCompletedAck;
  const gateway:NamingBrainstormGateway={async invoke(action,args){actions.push(action);const arg=args as Record<string,unknown>;
    if(action==="brainstorm_state")return structuredClone(state);
    if(action==="brainstorm_begin") {if(options.denyBegin)throw Error("fenced");const call={callId:id(100+state.calls.length),request:structuredClone(arg.request as NamingBrainstormWire),candidateTarget:Number(arg.candidateTarget),state:"prepared",responseId:null,requestId:null,candidates:[]};state.calls.push(call);return {...call,dispatch:"create"};}
    if(action==="brainstorm_event") {const call=state.calls.find(row=>row.callId===arg.callId)!;call.state=String(arg.kind);call.responseId=arg.responseId as string|null;call.requestId=arg.requestId as string|null;if(arg.kind==="created"){createdSaved=true;if(loseCreated){loseCreated=false;throw Error("ack_lost");}}
      if(arg.kind==="completed"){call.candidates=arg.candidates as unknown[];if(loseCompleted){loseCompleted=false;throw Error("ack_lost");}}return true;}
    if(action==="brainstorm_publish") {const call=state.calls.find(row=>row.callId===arg.callId)!;const insertedCount=Math.min(100-state.publishedCount,call.candidates.length);state.publishedCount+=insertedCount;return {publishedCount:state.publishedCount,insertedCount};}
    if(action==="brainstorm_finish")return {state:state.calls.some(row=>!["completed","rejected"].includes(row.state))?"needs_reconciliation":state.publishedCount===100?"succeeded":state.publishedCount?"partial":"failed",publishedCount:state.publishedCount};
    throw Error("unexpected_action");
  }};
  const provider=createNamingBrainstormProvider({apiKey:"synthetic-never-live",fetch:async(incoming,init)=>{
    const request=new Request(incoming,init),url=new URL(request.url);methods.push(request.method);
    if(request.method==="GET")return Response.json(responses.get(url.pathname.split("/").at(-1)!)!,{headers:{"x-request-id":"req_read"}});
    expect(url.pathname).toBe("/v1/responses");const body=await request.json() as NamingBrainstormWire;bodies.push(body);createdSaved=false;
    expect(state.calls.at(-1)?.request).toEqual(body);expect(request.headers.get("x-stainless-retry-count")).toBe("0");
    if(options.lostBeforeId)throw Error("private-fixture-value");
    const responseId=`resp_fixture_${bodies.length}`;
    const candidates=options.badCandidates?[{value:"Owned Name",rationale:"Fixture sound.",primaryApproach:"invented"},{value:"",rationale:"",primaryApproach:"invented"}]:Array.from({length:options.counts?.[bodies.length-1]??120},(_,index)=>({value:`Fixture${bodies.length}Name${index}`,rationale:"A proposed sound and imagery.",primaryApproach:"invented"}));
    const response={id:responseId,status:"completed",model:input.policy.model,output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({candidates})}]}],usage:{input_tokens:80,output_tokens:60,total_tokens:140}};responses.set(responseId,response);
    let part=0;
    return new Response(new ReadableStream<Uint8Array>({pull(controller){
      if(part++===0){controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:"response.created",sequence_number:0,response:{id:responseId}})}\n\n`));return;}
      // The SDK may prefetch bytes; persistence is checked before publication below.
      if(options.lostAfterId){controller.close();return;}
      if(part===2){controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:"response.completed",sequence_number:1,response})}\n\n`));return;}controller.close();
    }}),{headers:{"content-type":"text/event-stream","x-request-id":`req_create_${bodies.length}`}});
  }});
  const run=()=>runNamingBrainstorm({gateway,input,job,provider,signal:new AbortController().signal,heartbeat:async()=>({cancelled:false}),assertContinuation:async()=>{}});
  return {run,state,actions,methods,bodies,gateway,input,provider,createdSaved:()=>createdSaved};
}

describe("fast-first Naming with native Responses SDK and inert HTTP",()=>{
  it("persists 100 in one 120-candidate call with actual usage and no research",async()=>{
    const f=fixture();expect(await f.run()).toBe("succeeded");expect(f.state.publishedCount).toBe(100);expect(f.methods).toEqual(["POST"]);expect(f.state.calls).toHaveLength(1);expect(f.state.calls[0]).toMatchObject({candidateTarget:120,responseId:"resp_fixture_1",requestId:"req_create_1",state:"completed"});
    expect(f.createdSaved()).toBe(true);expect(f.actions.indexOf("brainstorm_begin")).toBeLessThan(f.actions.indexOf("brainstorm_event"));expect(f.actions.indexOf("brainstorm_event")).toBeLessThan(f.actions.indexOf("brainstorm_publish"));
    const body=f.bodies[0]!;expect(body).toMatchObject({store:true,stream:true,reasoning:{effort:"low"},max_output_tokens:16000});expect(body).not.toHaveProperty("tools");expect(body).not.toHaveProperty("spend_control");expect(body).not.toHaveProperty("previous_response_id");
  });
  it("runs only two bounded topups when committed usable counts need them",async()=>{const f=fixture({counts:[50,30,40]});expect(await f.run()).toBe("succeeded");expect(f.state.calls.map(c=>c.candidateTarget)).toEqual([120,60,40]);expect(f.methods).toEqual(["POST","POST","POST"]);});
  it("returns an honest short count after three terminal calls",async()=>{const f=fixture({counts:[10,10,10]});expect(await f.run()).toBe("partial");expect(f.state.publishedCount).toBe(30);expect(f.bodies).toHaveLength(3);});
  it("does not count duplicate history or malformed candidates",async()=>{const f=fixture({badCandidates:true});expect(await f.run()).toBe("failed");expect(f.state.publishedCount).toBe(0);expect(f.bodies).toHaveLength(3);});
  it("quarantines an unknown create without an ID and never replays it",async()=>{const f=fixture({lostBeforeId:true});expect(await f.run()).toBe("needs_reconciliation");expect(await f.run()).toBe("needs_reconciliation");expect(f.bodies).toHaveLength(1);expect(f.state.calls[0]).toMatchObject({state:"unknown",responseId:null});});
  it("recovers a known ID with GET only and never publishes from observation",async()=>{const f=fixture({lostAfterId:true});expect(await f.run()).toBe("needs_reconciliation");expect(await observeNamingBrainstorm({gateway:f.gateway,input:f.input,provider:f.provider,signal:new AbortController().signal})).toBe(1);expect(f.methods).toEqual(["POST","GET"]);expect(f.state.publishedCount).toBe(0);expect(f.state.calls[0]?.state).toBe("completed");});
  it.each(["loseCreatedAck","loseCompletedAck"] as const)("retains an ID when %s fails and recovers without another create",async key=>{const f=fixture({[key]:true});expect(await f.run()).toBe("needs_reconciliation");await observeNamingBrainstorm({gateway:f.gateway,input:f.input,provider:f.provider,signal:new AbortController().signal});expect(f.methods).toEqual(["POST","GET"]);expect(f.state.publishedCount).toBe(0);});
  it("cannot dispatch when source authority rejects the persisted boundary",async()=>{const f=fixture({denyBegin:true});expect(await f.run()).toBe("failed");expect(f.methods).toEqual([]);});
});

describe("brainstorm deterministic admission",()=>{
  it("normalizes NFC, preserves existing identity semantics, and honors literal constraints",()=>{
    const prefs={...preferences(),approaches:["invented" as const],requiredText:["café"],excludedText:["bad"],minimumGraphemes:4,maximumGraphemes:10};
    const row=(value:string,primaryApproach="invented")=>({value,rationale:"  Intended sound.  ",primaryApproach});
    const result=filterNamingBrainstormCandidates([row(" cafe\u0301 "),row("CAFÉ"),row("badcafé"),row("cafétreeverylong"),row("caféx","real_words"),row("Cafe"),row("café★")],prefs,[namingBrainstormIdentity("Café")]);
    expect(result.map(c=>c.value)).toEqual(["café★"]);expect(result[0]).toMatchObject({identityKey:"café★",rationale:"Intended sound.",graphemeCount:5});
  });
  it("counts graphemes rather than UTF-16 units and keeps the hard 100-grapheme bound",()=>{
    const row=(value:string)=>({value,rationale:"A creative sound.",primaryApproach:"invented"});
    expect(filterNamingBrainstormCandidates([row("a".repeat(101)),row("👨‍👩‍👧".repeat(4))],preferences(),[]).map(c=>c.graphemeCount)).toEqual([4]);
  });
});
