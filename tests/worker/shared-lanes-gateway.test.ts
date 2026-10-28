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
