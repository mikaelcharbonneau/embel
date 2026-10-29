import {describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {namingBrainJobInputSchema} from '../../src/domain/naming-brain';
import {createNamingBrainPolicy} from '../../src/server/ai/naming-brain/policy';
import type {NamingBrainstormProvider} from '../../src/server/ai/naming-brainstorm-provider';
import {createSharedNamingLaneEngine} from '../../worker/shared-lanes/naming';
import {buildNamingBrainstormRequest} from '../../worker/naming-brainstorm';
import type {SharedExecution,SharedSlotLease} from '../../worker/shared-pool/contracts';
import {hash,id,snapshot} from '../domain/naming-brain-fixtures';
function fixture(mismatch=false,options:{legacy?:boolean;actualLegacy?:boolean;sameDeployment?:boolean}={}){
 const policy=createNamingBrainPolicy('gpt-6-luna'),input=namingBrainJobInputSchema.parse({version:2,handlerVersion:'naming-brain-v1',billingMode:'openai_api',jobId:id(4),runId:id(3),batchId:id(5),snapshot:snapshot(),acceptedPolicyIdentity:hash,policy,executionAuthority:'hosted_owner_v1',providerBudgetVersion:2,localPipelineVersion:2,localTimingVersion:2,...(options.legacy?{}:{generationProfile:'brainstorm_v1'})});
 const slot:SharedSlotLease={version:1,slotId:id(10),instanceId:id(11),lane:'naming',generation:9,leaseToken:id(12),expiresAt:new Date(Date.now()+60000).toISOString(),roleName:'embel_shared_naming_fixture',roleOid:123};
 const execution:SharedExecution={version:1,executionId:id(13),executionToken:id(14),slotId:slot.slotId,instanceId:id(15),generation:8,lane:'naming',ownerId:input.snapshot.ownerId,projectId:input.snapshot.projectId,jobId:input.jobId,leaseToken:id(16),operation:'naming.generate',policyIdentity:hash,deploymentId:'dpl_original'};
 const job={id:input.jobId,owner_id:execution.ownerId,project_id:execution.projectId,operation:execution.operation,input,input_revision:1,state:'needs_reconciliation',reserved_cost_microusd:policy.runAllowanceMicrousd,actual_cost_microusd:0,lease_token:null};
 const state={generationProfile:'brainstorm_v1' as const,runId:input.runId,brief:input.snapshot,historyEpoch:0,history:[],exclusionIdentities:[],publishedCount:0,calls:[] as Array<{callId:string;request:ReturnType<typeof buildNamingBrainstormRequest>;candidateTarget:number;state:'unknown';responseId:string;requestId:string}>};
 const request=buildNamingBrainstormRequest(input,state,1,120);state.calls.push({callId:id(17),request,candidateTarget:120,state:'unknown',responseId:'resp_retained',requestId:'req_original'});
 const candidates=Array.from({length:113},(_,index)=>({value:`Synthetic${index}`,rationale:'Creative sound proposal.',primaryApproach:'invented'}));
 const response={id:'resp_retained',status:'completed',model:policy.model,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({candidates})}]}],usage:{input_tokens:10,output_tokens:20,total_tokens:30}};
 const create=vi.fn(),cancel=vi.fn(),retrieve=vi.fn(async()=>({response,requestId:'req_retrieval'})),provider:NamingBrainstormProvider={create,cancel,retrieve};
 const actions:string[]=[],payloads:unknown[]=[];
 const engine=createSharedNamingLaneEngine({slot:()=>slot,deploymentId:options.sameDeployment?'dpl_original':'dpl_successor',workerId:'synthetic-worker',policy,provider:{apiKey:'synthetic',model:policy.model,modelVerificationReceipt:'synthetic-model-proof'},database:{async query(_sql,values=[]){
  expect(JSON.parse(String(values[0]))).toEqual(slot);expect(JSON.parse(String(values[1]))).toEqual(execution);const action=String(values[2]);actions.push(action);payloads.push(JSON.parse(String(values[3])));
  const observedJob=options.actualLegacy?JSON.parse(JSON.stringify({...job,input:{...input,generationProfile:undefined}})):job;
  const result=action==='recover'?{observationJob:observedJob,observationLeaseToken:execution.leaseToken}:action==='brainstorm_state'?state:action==='brainstorm_event'?true:undefined;
  if(result===undefined)throw Error('unexpected_mutation');return{rows:[{envelope:{execution:mismatch?{...execution,deploymentId:'dpl_successor'}:execution,result}}]};
 }}},{brainstormProvider:provider});
 return{engine,execution,job,actions,payloads,create,cancel,retrieve};
}
describe('historical Naming observe-only lane (mock SQL/provider, no live acceptance claim)',()=>{
 it('observes prior-DPL response through successor slot, retaining original immutable scope and never creating or publishing',async()=>{
  const f=fixture(),jobBefore=structuredClone(f.job),executionBefore=structuredClone(f.execution);
  try{expect(await f.engine.recover!([{execution:f.execution,job:f.job,mode:'observe'}])).toEqual({disposition:'retry',state:'observation_retained'});
   expect(f.retrieve).toHaveBeenCalledOnce();expect(f.create).not.toHaveBeenCalled();expect(f.cancel).not.toHaveBeenCalled();expect(f.actions).toEqual(['recover','brainstorm_state','brainstorm_event']);
   expect(f.payloads[2]).toMatchObject({kind:'completed',responseId:'resp_retained',requestId:'req_original'});expect((f.payloads[2] as {candidates:unknown[]}).candidates).toHaveLength(100);
   expect(f.job).toEqual(jobBefore);expect(f.execution).toEqual(executionBefore);
  }finally{await f.engine.close();}
 });
 it.each([true,false])('skips a legacy cross-DPL pending input (legacy=%s) before any provider access',async legacy=>{
  const f=fixture(false,{legacy});const pendingJob=legacy?f.job:{...f.job,input:{malformed:true}};
  try{expect(await f.engine.recover!([{execution:f.execution,job:pendingJob,mode:'observe'}])).toEqual({disposition:'retry',state:'retained_unsupported'});expect(f.actions).toEqual([]);expect(f.retrieve).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();expect(f.cancel).not.toHaveBeenCalled();}finally{await f.engine.close();}
 });
 it('refuses a forged brainstorm pending profile when SQL returns a legacy job',async()=>{
  const f=fixture(false,{actualLegacy:true});try{expect(await f.engine.recover!([{execution:f.execution,job:f.job,mode:'observe'}])).toEqual({disposition:'retry',state:'retained_unsupported'});expect(f.actions).toEqual(['recover']);expect(f.retrieve).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();expect(f.cancel).not.toHaveBeenCalled();}finally{await f.engine.close();}
 });
 it('preserves same-deployment brainstorm observation',async()=>{
  const f=fixture(false,{sameDeployment:true});try{expect(await f.engine.recover!([{execution:f.execution,job:f.job,mode:'observe'}])).toMatchObject({state:'observation_retained'});expect(f.retrieve).toHaveBeenCalledOnce();expect(f.create).not.toHaveBeenCalled();expect(f.cancel).not.toHaveBeenCalled();}finally{await f.engine.close();}
 });
 it.each(['foreign','dpl_x','dpl_bad/identifier'])('refuses malformed historical hosted deployment %s before SQL or provider access',async deploymentId=>{
  const f=fixture();try{expect(await f.engine.recover!([{execution:{...f.execution,deploymentId},job:f.job,mode:'observe'}])).toEqual({disposition:'retry',state:'retained_unsupported'});expect(f.actions).toEqual([]);expect(f.retrieve).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();expect(f.cancel).not.toHaveBeenCalled();}finally{await f.engine.close();}
 });
 it('rejects returned deployment rebinding before any provider observation',async()=>{
  const f=fixture(true);try{await expect(f.engine.recover!([{execution:f.execution,job:f.job,mode:'observe'}])).rejects.toThrow();expect(f.create).not.toHaveBeenCalled();expect(f.retrieve).not.toHaveBeenCalled();}finally{await f.engine.close();}
 });
});
