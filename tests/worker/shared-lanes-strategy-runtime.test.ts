import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createSharedStrategyFixture} from '../database/shared-strategy-fixture';
import {createSharedStrategyLaneEngine} from '../../worker/shared-lanes/strategy';
import {sharedSlotLeaseSchema} from '../../worker/shared-pool/contracts';
import {responseFixture,transportFixture} from '../server/openai-fixtures';
import {createOpenAIResponsesTransport,type OpenAIResponsesTransport,type OpenAITransportResponse} from '../../src/server/ai/openai-transport';
import {sharedPendingExecutionSchema} from '../../worker/shared-pool/contracts';
import {randomUUID} from 'node:crypto';
import type {JobDatabase} from '../../worker/postgres-store';

const body=()=>responseFixture({kind:'question',message:'Synthetic shared Strategy reply',question:'Which detail matters?',targetStage:null,options:[],selection:null});
let f:Awaited<ReturnType<typeof createSharedStrategyFixture>>;
beforeEach(async()=>{f=await createSharedStrategyFixture();},60000);
afterEach(async()=>{await f?.close();});
const create=(transport:OpenAIResponsesTransport,database:JobDatabase={query:(sql,values)=>f.asSlot(f.slot,()=>f.db.query(sql,values))})=>createSharedStrategyLaneEngine({database,slot:()=>sharedSlotLeaseSchema.parse(f.lease),
 deploymentId:f.slot.deploymentId,workerId:'synthetic-shared-worker',provider:{apiKey:'synthetic-never-live-key',model:f.policies['strategy.reformulate']!.model,modelVerificationReceipt:'synthetic-model-proof'},policies:f.policies},{transport});

async function ambiguousExecution() {
 const admitted=await f.submit((await f.project()).id);
 const claim=await f.claim(admitted.dispatch), token=claim.result.job.lease_token;
 await f.action(admitted.dispatch,'plan',[token,[{key:'synthetic',maximumCostMicrousd:1}]],claim.execution);
 await f.action(admitted.dispatch,'begin',[token,'synthetic',claim.requestKey,1],claim.execution);
 await f.action(admitted.dispatch,'complete',[token,'synthetic','ambiguous',0,{error:'provider_usage_missing'},'resp_known_shared_fixture'],claim.execution);
 const page=await f.asSlot(f.slot,()=>f.db.query<{page:{items:unknown[]}}>('select public.read_shared_worker_execution_page($1,null,25) page',[JSON.stringify(f.lease)]));
 return {id:admitted.id,rows:page.rows[0]!.page.items.map(row=>sharedPendingExecutionSchema.parse(row))};
}

describe('actual shared Strategy engine and restricted SQL (inert response transport)',()=>{
 it('runs one admitted actual engine response and acknowledges duplicate without another create',async()=>{
  const admitted=await f.submit((await f.project()).id),transport=transportFixture(body()),engine=create(transport);
  try{
   expect(await engine.run(admitted.dispatch)).toEqual({disposition:'ack',state:'succeeded'});
   expect(await engine.run(admitted.dispatch)).toEqual({disposition:'ack',state:'succeeded'});
   expect(transport.createResponse).toHaveBeenCalledTimes(1);
   expect((await f.db.query('select outcome->>\'status\' status from fluid_private.shared_strategy_observed_outcomes')).rows).toEqual([{status:'succeeded'}]);
   expect((await f.db.query('select state from fluid_private.shared_worker_executions')).rows).toEqual([{state:'closed'}]);
   expect((await f.db.query('select * from fluid_private.shared_worker_gateway_context')).rows).toEqual([]);
  }finally{await engine.close();}
 });
 it('keeps a noncooperative issued future busy until its known late outcome is durably journaled',async()=>{
  const admitted=await f.submit((await f.project()).id),stop=new AbortController();
  let resolveResponse!:(response:OpenAITransportResponse)=>void,markIssued!:()=>void;
  const issued=new Promise<void>(resolve=>{markIssued=resolve;});
  const transport:OpenAIResponsesTransport={countInputTokens:vi.fn(async()=>200),createResponse:vi.fn(async()=>{
   markIssued();return new Promise<OpenAITransportResponse>(resolve=>{resolveResponse=resolve;});})};
  const engine=create(transport);let runSettled=false,closeSettled=false;
  const run=engine.run(admitted.dispatch,stop.signal).then(value=>{runSettled=true;return value;});
  await Promise.race([issued,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic engine never reached issued transport')),10000);timer.unref();})]);stop.abort();
  // Real runner abort grace is five seconds. The actual provider promise remains
  // unresolved and must not be mistaken for quiescence or a refundable request.
  await new Promise(resolve=>setTimeout(resolve,5200));
  expect(runSettled).toBe(false);
  expect((await f.db.query('select state,provider_request_id from public.job_steps where job_id=$1',[admitted.id])).rows).toEqual([{state:'ambiguous',provider_request_id:null}]);
  const close=engine.close().then(()=>{closeSettled=true;});await Promise.resolve();expect(closeSettled).toBe(false);
  resolveResponse({body:body(),requestId:'req_shared_late_fixture'});
  expect(await run).toEqual({disposition:'ack',state:'needs_reconciliation'});await close;
  expect(closeSettled).toBe(true);expect(transport.createResponse).toHaveBeenCalledTimes(1);
  expect((await f.db.query("select outcome->>'providerRequestId' provider,outcome->>'status' status from fluid_private.shared_strategy_observed_outcomes where job_id=$1",[admitted.id])).rows)
   .toEqual([{provider:'resp_synthetic_fixture',status:'succeeded'}]);
  expect((await f.db.query('select state,provider_request_id from public.job_steps where job_id=$1',[admitted.id])).rows).toEqual([{state:'ambiguous',provider_request_id:null}]);
  expect((await f.db.query('select state from public.jobs where id=$1',[admitted.id])).rows).toEqual([{state:'needs_reconciliation'}]);
 },30000);
 it('retrieves only a SQL-proven response ID with the native GET transport and preserves ambiguity',async()=>{
  const admitted=await f.submit((await f.project()).id),claim=await f.claim(admitted.dispatch),token=claim.result.job.lease_token;
  await f.action(admitted.dispatch,'plan',[token,[{key:'synthetic',maximumCostMicrousd:1}]],claim.execution);
  await f.action(admitted.dispatch,'begin',[token,'synthetic',claim.requestKey,1],claim.execution);
  await f.action(admitted.dispatch,'complete',[token,'synthetic','ambiguous',0,{error:'provider_usage_missing'},'resp_known_shared_fixture'],claim.execution);
  const response={...body(),id:'resp_known_shared_fixture'};
  const requests:RequestInit[]=[];
  const transport=createOpenAIResponsesTransport({apiKey:'synthetic-never-live-key',fetch:async(incoming,init)=>{
   const url=new URL(String(incoming));expect(url.origin).toBe('https://api.openai.com');expect(url.pathname).toBe('/v1/responses/resp_known_shared_fixture');
   expect(init?.method).toBe('GET');requests.push(init!);return Response.json(response,{headers:{'x-request-id':'req_shared_observe'}});
  }}),engine=create(transport);
  try{
   const pending=await f.asSlot(f.slot,()=>f.db.query<{pending:unknown}>('select public.read_shared_worker_executions($1) pending',[f.lease]));
   const rows=pending.rows.map(r=>sharedPendingExecutionSchema.parse(r.pending));expect(rows).toHaveLength(1);
   await expect(engine.recover!([{...rows[0]!,execution:{...rows[0]!.execution,executionToken:randomUUID()}}])).rejects.toThrow();expect(requests).toHaveLength(0);
   expect(await engine.recover!(rows)).toEqual({disposition:'retry',state:'observation_retained'});expect(requests).toHaveLength(1);
   expect(await engine.recover!(rows)).toEqual({disposition:'retry',state:'retained_unsupported'});expect(requests).toHaveLength(1);
   expect((await f.db.query('select state,provider_request_id from public.job_steps where job_id=$1',[admitted.id])).rows).toEqual([{state:'ambiguous',provider_request_id:'resp_known_shared_fixture'}]);
   expect((await f.db.query('select state from public.jobs where id=$1',[admitted.id])).rows).toEqual([{state:'needs_reconciliation'}]);
   expect((await f.db.query('select response_id from fluid_private.shared_strategy_observed_responses')).rows).toEqual([{response_id:'resp_known_shared_fixture'}]);
  }finally{await engine.close();}
 });
 it('keeps an unavailable provider GET unresolved, then observes the same handle later',async()=>{
  const {id,rows}=await ambiguousExecution();
  let available=false;
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   expect(init?.method).toBe('GET');
   expect(new URL(String(input)).pathname).toBe('/v1/responses/resp_known_shared_fixture');
   return available ? Response.json({...body(),id:'resp_known_shared_fixture'}) : Response.json({},{status:404});
  });
  const engine=create(createOpenAIResponsesTransport({apiKey:'synthetic-never-live-key',fetch}));
  try {
   expect(await engine.recover!(rows)).toEqual({disposition:'retry',state:'observation_unavailable'});
   expect(await f.db.query('select response_id from fluid_private.shared_strategy_observed_responses')).toMatchObject({rows:[]});
   expect((await f.db.query('select state from public.jobs where id=$1',[id])).rows).toEqual([{state:'needs_reconciliation'}]);
   available=true;
   expect(await engine.recover!(rows)).toEqual({disposition:'retry',state:'observation_retained'});
   expect(fetch).toHaveBeenCalledTimes(2);
  }finally{await engine.close();}
 });

 it('rotates through unavailable handles and never records a mismatched provider response',async()=>{
  const {rows}=await ambiguousExecution();
  const ids=['resp_a','resp_b','resp_c','resp_d','resp_e'];
  const observed:string[]=[];
  const database:JobDatabase={async query(_sql,values){
   const execution=JSON.parse(String(values?.[1])), action=values?.[2];
   const args=JSON.parse(String(values?.[3]));
   let result:unknown;
   if(action==='recovery')result=ids.map(responseId=>({stepKey:'synthetic',responseId}));
   else if(action==='observe_response'){observed.push(args.values[2]);result=true;}
   else throw Error('Unexpected gateway call');
   return {rows:[{envelope:{execution,result}}]};
  }};
  const retrieveResponse=vi.fn(async(id:string)=>{
   if(id==='resp_e')return {body:{id,status:'completed'},requestId:null};
   if(id==='resp_b')return {body:{id:'resp_other',status:'completed'},requestId:null};
   throw Error('Synthetic GET failure');
  });
  const transport={...transportFixture(body()), retrieveResponse};
  const engine=create(transport,database);
  try{
   expect(await engine.recover!(rows)).toEqual({disposition:'retry',state:'observation_unavailable'});
   expect(retrieveResponse.mock.calls.map(([id])=>id)).toEqual(ids.slice(0,3));
   expect(await engine.recover!(rows)).toEqual({disposition:'retry',state:'observation_unavailable'});
   expect(retrieveResponse.mock.calls.slice(3).map(([id])=>id)).toEqual(['resp_d','resp_e','resp_a']);
   expect(observed).toEqual(['resp_e']);
   expect(transport.createResponse).not.toHaveBeenCalled();
  }finally{await engine.close();}
 });

 it('does not treat missing SQL write acknowledgement as an unavailable provider lookup',async()=>{
  const {rows}=await ambiguousExecution();
  const transport={...transportFixture(body()),retrieveResponse:vi.fn(async()=>({body:{id:'resp_known_shared_fixture',status:'completed'},requestId:null}))};
  const engine=create(transport,{query:(sql,values)=>{
   if(values?.[2]==='observe_response')throw Error('Synthetic observation connection loss');
   return f.asSlot(f.slot,()=>f.db.query(sql,values));
  }});
  await expect(engine.recover!(rows)).rejects.toThrow('shared_strategy_observation_unconfirmed');
  await expect(engine.recover!(rows)).rejects.toThrow('shared_strategy_drain_unconfirmed');
  await expect(engine.close()).rejects.toThrow('shared_strategy_drain_unconfirmed');
  expect(transport.retrieveResponse).toHaveBeenCalledTimes(1);
 });

});
