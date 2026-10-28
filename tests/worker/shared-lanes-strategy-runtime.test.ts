import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createSharedStrategyFixture} from '../database/shared-strategy-fixture';
import {createSharedStrategyLaneEngine} from '../../worker/shared-lanes/strategy';
import {sharedSlotLeaseSchema} from '../../worker/shared-pool/contracts';
import {responseFixture,transportFixture} from '../server/openai-fixtures';
import {createOpenAIResponsesTransport,type OpenAIResponsesTransport,type OpenAITransportResponse} from '../../src/server/ai/openai-transport';
import {sharedPendingExecutionSchema} from '../../worker/shared-pool/contracts';
import {randomUUID} from 'node:crypto';

const body=()=>responseFixture({kind:'question',message:'Synthetic shared Strategy reply',question:'Which detail matters?',targetStage:null,options:[],selection:null});
let f:Awaited<ReturnType<typeof createSharedStrategyFixture>>;
beforeEach(async()=>{f=await createSharedStrategyFixture();},60000);
afterEach(async()=>{await f?.close();});
const create=(transport:OpenAIResponsesTransport)=>createSharedStrategyLaneEngine({database:{query:(sql,values)=>f.asSlot(f.slot,()=>f.db.query(sql,values))},slot:()=>sharedSlotLeaseSchema.parse(f.lease),
 deploymentId:f.slot.deploymentId,workerId:'synthetic-shared-worker',provider:{apiKey:'synthetic-never-live-key',model:f.policies['strategy.reformulate']!.model,modelVerificationReceipt:'synthetic-model-proof'},policies:f.policies},{transport});

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
});
