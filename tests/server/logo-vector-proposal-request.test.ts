import { describe,expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { createLogoVectorProposalService,LogoVectorProposalClosureUncertainError } from '@/server/data/logo-vector-proposals';
import { logoVectorProposalRecordSchema,uncappedLogoVectorProposalTextPolicySchema } from '@/domain/logo-vector-proposal-jobs';
import type { AuthenticatedContext } from '@/server/auth/context';
import { proposalId } from '../features/logo-vector/proposal-fixtures';
import { proposalRecord } from './logo-vector-proposal-fixtures';
function fixture(legacy=false){
 const original=proposalRecord(),{maximumCostMicrousd,...policy}=original.providerReceipt.observation.textPolicy;
 if(maximumCostMicrousd!==122880)throw Error('Synthetic legacy policy mismatch');
 const uncapped=uncappedLogoVectorProposalTextPolicySchema.parse({...policy,version:2,adapterVersion:'logo-vector-propose-api-uncapped-v2',spendControl:'uncapped'});
 const proposal=structuredClone(legacy?original:logoVectorProposalRecordSchema.parse({...original,providerReceipt:{...original.providerReceipt,observation:{...original.providerReceipt.observation,textPolicy:uncapped}}}));
 const input={requestKey:proposal.requestKey,quoteId:proposal.quoteId,expected:proposal.expected};
 const receipt={ownerId:proposal.ownerId,projectId:proposal.projectId,requestKey:input.requestKey,operation:'identity.logo_vector_propose',batchId:null,jobIds:[proposal.jobId],inputHash:'a'.repeat(64)};
 const state={status:'succeeded',requestKey:input.requestKey,receipt,outputs:[],billing:{status:'recorded',confirmedMicrousd:proposal.actualCostMicrousd},reason:null};
 const value={ownerId:proposal.ownerId,projectId:proposal.projectId,input,state,proposal};
 const rpc=vi.fn<(name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:unknown}>>(async()=>({data:value,error:null}));
 const auth={userId:proposal.ownerId,client:{rpc}} as unknown as AuthenticatedContext;
 return{proposal,input,receipt,state,value,rpc,auth,service:createLogoVectorProposalService()};
}
describe('exact vector proposal request recovery and closure',()=>{
 it('recovers the actual owned proposal with the original uncapped intent and no list scan/provider',async()=>{
  const f=fixture();expect(await f.service.readLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).toEqual(f.value);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('read_logo_vector_proposal_request',{p_project_id:f.proposal.projectId,p_input:f.input});
 });
 it('retains the exact legacy amount only when present in the original request',async()=>{
  const f=fixture(true),input={...f.input,acceptedMaxCostMicrousd:122880};f.rpc.mockResolvedValue({data:{...f.value,input},error:null});
  expect((await f.service.readLogoVectorProposalRequest(f.auth,f.proposal.projectId,input)).input).toEqual(input);
  expect(f.rpc.mock.calls[0]![1].p_input).toEqual(input);
 });
 it.each(['owner','project','intent','job','quote','component'] as const)('rejects an unexpected %s source before exposing recovered proposal',async kind=>{
  const f=fixture();if(kind==='owner')f.value.ownerId=proposalId(999);if(kind==='project')f.value.projectId=proposalId(999);
  if(kind==='intent')f.value.input={...f.input,requestKey:proposalId(999)};
  if(kind==='job')f.receipt.jobIds=[proposalId(999)];if(kind==='quote')f.proposal.quoteId=proposalId(999);
  if(kind==='component'){if(f.proposal.payload?.status!=='proposed')throw Error('Synthetic proposal expected');f.proposal.payload.edit={kind:'rotation',componentId:'foreign-component',degrees:5};}
  await expect(f.service.readLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).rejects.toBeDefined();expect(f.rpc).toHaveBeenCalledTimes(1);
 });
 it('does not turn lookup absence into a closure write or a new admission',async()=>{
  const f=fixture();f.rpc.mockResolvedValue({data:null,error:{code:'P0002',message:'private absence details'}});
  await expect(f.service.readLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).rejects.toMatchObject({code:'not_found'});
  expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(['read_logo_vector_proposal_request']);
 });
 it('accepts only an exact durable non-admission witness',async()=>{
  const f=fixture(),witness={status:'not_admitted',ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,input:f.input};
  f.rpc.mockResolvedValue({data:witness,error:null});expect(await f.service.closeLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).toEqual(witness);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('close_logo_vector_proposal_request',{p_project_id:f.proposal.projectId,p_input:f.input});
 });
 it('returns an admitted unknown outcome after Stop without claiming a stopped provider or refund',async()=>{
  const f=fixture(),request={...f.value,proposal:null,state:{...f.state,status:'needs_reconciliation',billing:{status:'unknown',confirmedMicrousd:null},reason:'provider_outcome_unknown'}};
  f.rpc.mockResolvedValue({data:{status:'admitted',request},error:null});expect(await f.service.closeLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).toEqual({status:'admitted',request});
 });
 it.each(['foreign','changed','absent','fake_stop'])('preserves the original intent when close proof is %s',async kind=>{
  const f=fixture();let data:unknown={status:'not_admitted',ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,input:f.input};
  if(kind==='foreign')data={status:'not_admitted',ownerId:proposalId(999),projectId:f.proposal.projectId,input:f.input};
  if(kind==='changed')data={status:'not_admitted',ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,input:{...f.input,quoteId:proposalId(999)}};
  if(kind==='absent')data=null;if(kind==='fake_stop')data={status:'not_admitted',ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,input:f.input,providerStopped:true};
  f.rpc.mockResolvedValue({data,error:null});await expect(f.service.closeLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).rejects.toMatchObject({name:'LogoVectorProposalClosureUncertainError',recovery:{projectId:f.proposal.projectId,input:f.input}});
 });
 it('repeats only the exact closure after lost acknowledgement',async()=>{
  const f=fixture(),witness={status:'not_admitted',ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,input:f.input};
  f.rpc.mockRejectedValueOnce(Error('private acknowledgement loss')).mockResolvedValue({data:witness,error:null});
  await expect(f.service.closeLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).rejects.toBeInstanceOf(LogoVectorProposalClosureUncertainError);
  expect(await f.service.closeLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).toEqual(witness);
  expect(f.rpc.mock.calls).toEqual([['close_logo_vector_proposal_request',{p_project_id:f.proposal.projectId,p_input:f.input}],['close_logo_vector_proposal_request',{p_project_id:f.proposal.projectId,p_input:f.input}]]);
 });
 it('retains the original close intent on SQL job-lock contention without retrying',async()=>{const f=fixture();f.rpc.mockResolvedValue({data:null,error:{code:'55P03',message:'private locked job'}});await expect(f.service.closeLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input)).rejects.toMatchObject({name:'LogoVectorProposalClosureUncertainError',recovery:{projectId:f.proposal.projectId,input:f.input}});expect(f.rpc).toHaveBeenCalledTimes(1);});
 it('does not issue a request after caller cancellation or with injected provider authority',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();await expect(f.service.readLogoVectorProposalRequest(f.auth,f.proposal.projectId,f.input,controller.signal)).rejects.toMatchObject({code:'integration_unavailable'});
  await expect(f.service.closeLogoVectorProposalRequest(f.auth,f.proposal.projectId,{...f.input,provider:'openai'})).rejects.toMatchObject({code:'invalid_input'});expect(f.rpc).not.toHaveBeenCalled();
 });
});


describe('bounded pending vector proposal request discovery',()=>{
 it('reads actual server-owned original intents without admitting, closing or scanning proposal history',async()=>{
  const f=fixture(),value={ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,items:[f.value],nextCursor:null};
  f.rpc.mockResolvedValue({data:value,error:null});expect(await f.service.listPendingLogoVectorProposalRequests(f.auth,f.proposal.projectId)).toEqual(value);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('list_pending_logo_vector_proposal_requests',{p_project_id:f.proposal.projectId,p_cursor:null,p_limit:10});
 });
 it('passes only the explicit cursor and bounded requested page size',async()=>{
  const f=fixture(),value={ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,items:[f.value],nextCursor:f.input.requestKey};
  f.rpc.mockResolvedValue({data:value,error:null});expect(await f.service.listPendingLogoVectorProposalRequests(f.auth,f.proposal.projectId,{cursor:proposalId(900),limit:1})).toEqual(value);
  expect(f.rpc.mock.calls[0]![1]).toEqual({p_project_id:f.proposal.projectId,p_cursor:proposalId(900),p_limit:1});
 });
 it.each(['scope','duplicate','cursor','item','too_many'] as const)('rejects malformed pending page %s',async kind=>{
  const f=fixture(),value={ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,items:[f.value],nextCursor:null as string|null};
  if(kind==='scope')value.ownerId=proposalId(999);if(kind==='duplicate')value.items=[f.value,f.value];
  if(kind==='cursor')value.nextCursor=proposalId(999);if(kind==='item')f.value.ownerId=proposalId(999);
  if(kind==='too_many')value.items=Array.from({length:11},()=>f.value);
  f.rpc.mockResolvedValue({data:value,error:null});await expect(f.service.listPendingLogoVectorProposalRequests(f.auth,f.proposal.projectId)).rejects.toMatchObject({code:'integration_unavailable'});expect(f.rpc).toHaveBeenCalledTimes(1);
 });
 it('does not turn an empty current page into closure or replace an unknown original key',async()=>{
  const f=fixture(),value={ownerId:f.proposal.ownerId,projectId:f.proposal.projectId,items:[],nextCursor:null};
  f.rpc.mockResolvedValue({data:value,error:null});expect((await f.service.listPendingLogoVectorProposalRequests(f.auth,f.proposal.projectId)).items).toEqual([]);
  expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(['list_pending_logo_vector_proposal_requests']);expect(f.input.requestKey).toBe(f.proposal.requestKey);
 });
 it('rejects invalid cursor and limit before any SQL',async()=>{
  const f=fixture();await expect(f.service.listPendingLogoVectorProposalRequests(f.auth,f.proposal.projectId,{cursor:'invalid'})).rejects.toMatchObject({code:'invalid_input'});
  await expect(f.service.listPendingLogoVectorProposalRequests(f.auth,f.proposal.projectId,{limit:11})).rejects.toMatchObject({code:'invalid_input'});expect(f.rpc).not.toHaveBeenCalled();
 });
});
