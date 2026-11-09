import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createSharedLaneGateway} from '../../worker/shared-lanes/gateway';
import type {SharedSlotLease,SharedExecution} from '../../worker/shared-pool/contracts';
import {ApiTextJobStore} from '../../worker/api-text-store';

function fixture(){
 const slot:SharedSlotLease={version:1,slotId:randomUUID(),instanceId:randomUUID(),lane:'strategy',generation:2,leaseToken:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),roleName:'embel_shared_strategy_fixture',roleOid:123};
 const e:SharedExecution={version:1,executionId:randomUUID(),executionToken:randomUUID(),slotId:slot.slotId,instanceId:slot.instanceId,generation:slot.generation,lane:'strategy',ownerId:randomUUID(),projectId:randomUUID(),jobId:randomUUID(),leaseToken:randomUUID(),operation:'strategy.reformulate',policyIdentity:'a'.repeat(64),deploymentId:'fixture-shared'};
 const authority={version:1,contract:'hosted_strategy_shared_uncapped_v1',jobId:e.jobId,ownerId:e.ownerId,projectId:e.projectId,leaseToken:e.leaseToken,inputHash:'b'.repeat(64),policyIdentity:e.policyIdentity,roleOid:slot.roleOid,generation:e.generation,slotId:e.slotId,instanceId:e.instanceId,executionId:e.executionId,executionToken:e.executionToken};
 const job={id:e.jobId,owner_id:e.ownerId,project_id:e.projectId,lease_token:e.leaseToken,operation:e.operation,input_hash:authority.inputHash,input_revision:1,state:'running',reserved_cost_microusd:0,actual_cost_microusd:0,billing_mode:'openai_api',input:{version:3,spendControl:'uncapped',policyIdentity:e.policyIdentity}};
 const result={disposition:'claimed',state:'running',job,executionAuthority:authority};
 const message={version:1 as const,jobId:e.jobId,policyIdentity:e.policyIdentity,deploymentId:e.deploymentId,dispatchIdentity:'c'.repeat(64)};
 let current:SharedSlotLease|null=slot;
 const response={execution:e,result};
 const query=vi.fn(async(sql:string,values?:unknown[])=>{void sql;void values;return{rows:[{envelope:response as {execution:SharedExecution;result:unknown}}]};});
 const controller=new AbortController();
 const gateway=createSharedLaneGateway({database:{query},slot:()=>current,lane:'strategy',deploymentId:e.deploymentId,expectedJobId:e.jobId,message,signal:controller.signal});
 return{slot,e,authority,job,result,message,response,query,controller,gateway,setCurrent:(v:SharedSlotLease|null)=>{current=v;}};
}
describe('shared lane frozen execution facade (unit-only, no SQL/provider readiness claim)',()=>{
 it('uses a fixed action RPC with the complete immutable queue descriptor',async()=>{
  const f=fixture();expect(await f.gateway.invoke('claim',['worker',120])).toBe(f.result);
  expect(f.query.mock.calls[0]?.[0]).toBe('select public.shared_strategy_worker_action($1::jsonb,$2::jsonb,$3,$4::jsonb) as envelope');
  expect(JSON.parse(String(f.query.mock.calls[0]?.[1]?.[3]))).toEqual({message:f.message,values:['worker',120]});
  f.gateway.assertJob(f.e.jobId,f.e.leaseToken,f.e.ownerId,f.e.projectId);
 });
 it.each(['ownerId','projectId','jobId','leaseToken','slotId','instanceId','executionId','executionToken'] as const)('rejects a forged %s in SQL claim authority',async field=>{
  const f=fixture();f.authority[field]=randomUUID();await expect(f.gateway.invoke('claim',[])).rejects.toThrow();expect(f.gateway.execution()).toBeNull();
 });
 it('rejects a claim job different from the execution even when its own authority agrees',async()=>{
  const f=fixture();f.job.owner_id=randomUUID();f.authority.ownerId=f.job.owner_id;
  await expect(f.gateway.invoke('claim',[])).rejects.toThrow();
 });
 it('keeps issued evidence usable with the original lease after Stop/current-slot loss',async()=>{
  const f=fixture();await f.gateway.invoke('claim',[]);f.controller.abort();f.setCurrent(null);
  f.response.result=true as never;
  expect(await f.gateway.invoke('complete',[f.e.leaseToken],true)).toBe(true);
  expect(JSON.parse(String(f.query.mock.calls[1]?.[1]?.[0]))).toEqual(f.slot);
  expect(JSON.parse(String(f.query.mock.calls[1]?.[1]?.[1]))).toEqual(f.e);
  await expect(f.gateway.invoke('authorize',[])).rejects.toThrow();expect(f.query).toHaveBeenCalledTimes(2);
 });
 it('refuses a new dispatch after a generation change and cross-job assertions',async()=>{
  const f=fixture();await f.gateway.invoke('claim',[]);f.setCurrent({...f.slot,generation:f.slot.generation+1});
  await expect(f.gateway.invoke('begin',[])).rejects.toThrow();
  expect(()=>f.gateway.assertJob(randomUUID(),f.e.leaseToken)).toThrow();expect(()=>f.gateway.assertJob(f.e.jobId,randomUUID())).toThrow();
  expect(f.query).toHaveBeenCalledTimes(1);
 });
 it('does not invent an execution when a claim acknowledgment is unreadable',async()=>{
  const f=fixture();f.query.mockRejectedValueOnce(Error('synthetic_lost_committed_ack'));
  await expect(f.gateway.invoke('claim',[])).rejects.toThrow('synthetic_lost_committed_ack');expect(f.gateway.execution()).toBeNull();
 });
 it('does not let a later response switch an execution on a reused connection',async()=>{
  const f=fixture();await f.gateway.invoke('claim',[]);f.response.execution={...f.e,ownerId:randomUUID()};
  await expect(f.gateway.invoke('complete',[],true)).rejects.toThrow();expect(f.gateway.execution()?.ownerId).toBe(f.e.ownerId);
 });
 it('the real Strategy store caches only the exact parsed shared claim, never arbitrary job objects',async()=>{
  const f=fixture(),store=new ApiTextJobStore({query:async()=>({rows:[{result:f.result}]})},f.message,f.e.deploymentId,f.e.operation);
  const claimed=await store.claim('fixture-worker',120);if(!claimed)throw Error('missing synthetic claim');
  expect(store.hasUnmeteredExecutionAuthority(claimed)).toBe(true);
  expect(store.hasUnmeteredExecutionAuthority({...claimed})).toBe(false);
  f.result.executionAuthority={...f.authority,jobId:randomUUID()};await expect(store.claim('fixture-worker',120)).rejects.toThrow(/binding mismatch/i);
 });
});

describe('Logo provider receipt delivery under the original execution',()=>{
 async function receiptFixture(operation='identity.logo_concept'){
  const f=fixture(),slot={...f.slot,lane:'logo' as const},e={...f.e,lane:'logo' as const,operation};
  const response:{execution:SharedExecution;result:unknown}={execution:e,result:[{...f.job,operation:e.operation}]};
  const query=vi.fn(async(sql:string,values?:unknown[])=>{void sql;void values;return{rows:[{envelope:response}]};});
  const gateway=createSharedLaneGateway({database:{query},slot:()=>slot,lane:'logo',deploymentId:e.deploymentId,signal:f.controller.signal});
  await gateway.invoke('claim',['worker',120]);response.result={id:randomUUID()};query.mockClear();
  const args=[e.jobId,e.leaseToken,JSON.stringify({observedAt:'2026-10-30T01:59:00.123Z',artifactHash:'a'.repeat(64)})];
  return{e,slot,response,query,gateway,args,controller:f.controller};
 }
 it('replays a lost receipt acknowledgement with the exact serialized body and original authority',async()=>{
  const f=await receiptFixture();let first:unknown[]=[];
  f.query.mockImplementationOnce(async(_sql,values)=>{first=[...values!];values![3]='mutated by failing transport';throw Error('Query read timeout');});
  expect(await f.gateway.invoke('receipt',f.args,true)).toEqual(f.response.result);
  expect(f.query).toHaveBeenCalledTimes(2);expect(f.query.mock.calls[1]![1]).toEqual(first);
  expect(JSON.parse(String(first[0]))).toEqual(f.slot);expect(JSON.parse(String(first[1]))).toEqual(f.e);
  expect(JSON.parse(String(first[3]))).toEqual(f.args);
 });
 it('bounds receipt retries when delivery remains unknown',async()=>{
  const f=await receiptFixture();f.query.mockRejectedValue(Error('Query read timeout'));
  await expect(f.gateway.invoke('receipt',f.args,true)).rejects.toThrow('Query read timeout');expect(f.query).toHaveBeenCalledTimes(2);
 });
 it.each(['42501','22023','PT409','40001'])('does not retry an acknowledged database rejection %s',async code=>{
  const f=await receiptFixture();f.query.mockRejectedValue(Object.assign(Error('Database rejected receipt'),{code}));
  await expect(f.gateway.invoke('receipt',f.args,true)).rejects.toThrow('Database rejected receipt');expect(f.query).toHaveBeenCalledTimes(1);
 });
 it('does not retry after cancellation or replay a different action',async()=>{
  const f=await receiptFixture();f.query.mockImplementationOnce(async()=>{f.controller.abort();throw Error('Query read timeout');});
  await expect(f.gateway.invoke('receipt',f.args,true)).rejects.toThrow();expect(f.query).toHaveBeenCalledTimes(1);
  const g=await receiptFixture();g.query.mockRejectedValue(Error('Query read timeout'));
  await expect(g.gateway.invoke('complete',g.args,true)).rejects.toThrow();expect(g.query).toHaveBeenCalledTimes(1);
  const h=await receiptFixture('identity.logo_directions');h.query.mockRejectedValue(Error('Query read timeout'));
  await expect(h.gateway.invoke('receipt',h.args,true)).rejects.toThrow();expect(h.query).toHaveBeenCalledTimes(1);
 });
 it('never turns a malformed or foreign acknowledgement into a retry',async()=>{
  const f=await receiptFixture();f.response.execution={...f.e,ownerId:randomUUID()};
  await expect(f.gateway.invoke('receipt',f.args,true)).rejects.toThrow();expect(f.query).toHaveBeenCalledTimes(1);
  const g=await receiptFixture();g.query.mockResolvedValue({rows:[]} as never);
  await expect(g.gateway.invoke('receipt',g.args,true)).rejects.toThrow();expect(g.query).toHaveBeenCalledTimes(1);
 });
});

describe('Naming observation uses the same-deployment rules as every lane',()=>{
 function observationFixture(){
  const f=fixture(),original={...f.e,lane:'naming' as const,operation:'naming.generate',deploymentId:'dpl_current'},slot={...f.slot,lane:'naming' as const,generation:3,instanceId:randomUUID(),leaseToken:randomUUID()};
  const response:{execution:SharedExecution;result:unknown}={execution:original,result:{action:'closed'}};
  const query=vi.fn(async()=>({rows:[{envelope:response}]}));
  const gateway=createSharedLaneGateway({database:{query},slot:()=>slot,lane:'naming',deploymentId:'dpl_current',observationExecution:original});
  return{original,slot,response,query,gateway};
 }
 it('accepts only the exact frozen handle while sending the current slot and JSON arguments',async()=>{
  const f=observationFixture();expect(await f.gateway.invoke('recover',{},true)).toEqual({action:'closed'});
  expect(f.gateway.execution()).toEqual(f.original);
  const values=(f.query.mock.calls as unknown as Array<[string,unknown[]]>)[0]![1];
  expect(JSON.parse(String(values[0]))).toEqual(f.slot);expect(JSON.parse(String(values[1]))).toEqual(f.original);expect(values[2]).toBe('recover');expect(JSON.parse(String(values[3]))).toEqual({});
  await expect(f.gateway.invoke('claim',{})).rejects.toThrow();await expect(f.gateway.invoke('round_begin',{})).rejects.toThrow();expect(f.query).toHaveBeenCalledTimes(1);
 });
 it.each(['deploymentId','ownerId','projectId','jobId','executionId','executionToken','leaseToken','policyIdentity','generation'] as const)('rejects a returned change to %s',async field=>{
  const f=observationFixture();f.response.execution={...f.original,[field]:field==='generation'?99:field==='policyIdentity'?'b'.repeat(64):field==='deploymentId'?'dpl_other':randomUUID()};
  await expect(f.gateway.invoke('recover',{},true)).rejects.toThrow();expect(f.gateway.execution()).toEqual(f.original);
 });
 it('refuses an observer of another deployment\'s execution',async()=>{
  const f=observationFixture(),gateway=createSharedLaneGateway({database:{query:f.query},slot:()=>f.slot,lane:'naming',deploymentId:'dpl_successor',observationExecution:f.original});
  await expect(gateway.invoke('recover',{},true)).rejects.toThrow();
 });
 it('still rejects a foreign deployment during an active Naming claim',async()=>{
  const f=observationFixture(),gateway=createSharedLaneGateway({database:{query:f.query},slot:()=>f.slot,lane:'naming',deploymentId:'dpl_successor'});
  await expect(gateway.invoke('claim',{})).rejects.toThrow();expect(gateway.execution()).toBeNull();
 });
});
