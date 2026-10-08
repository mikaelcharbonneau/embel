import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createLogoVectorProposalApplicationClient} from '@/features/logo-vector/client/proposal-application';
import type {VerifiedAccount} from '@/components/workspace/account-session';
const owner=randomUUID(),projectId=randomUUID(),proposalId=randomUUID(),baseVectorRevisionId=randomUUID(),requestKey=randomUUID();
const expected={projectRevision:1,referenceRevision:0,preferencesRevision:0,workspaceRevision:1,stageRevisions:{brief_references:0,concepts:0,vector:0,refinements:0,directions:0,deliverables:0}};
const input={requestKey,expected,baseVectorRevisionId,proposalId},command={method:'applyLogoVectorProposal',body:input},id=randomUUID();
const workspace={version:2,ownerId:owner,projectId,heads:{...expected,workspaceRevision:2,stageRevisions:{...expected.stageRevisions,refinements:1}},stages:{brief_references:null,concepts:null,vector:null,refinements:{stage:'refinements',id,revision:1},directions:null,deliverables:null},approvedLogo:null,staleStages:[],capabilities:Object.fromEntries(['save','upload','generate','convert','export'].map(key=>[key,{status:'available'}]))};
const receipt={ownerId:owner,projectId,requestKey,workspace,revision:{version:2,id,ownerId:owner,projectId,stage:'refinements',revision:1,parentRevisionId:null,inputRevisions:[],inputHash:'a'.repeat(64),payload:{rasterRevisionIds:[],vectorRevisionId:randomUUID(),approvalId:null,sourceRequestKey:requestKey},createdAt:'2026-10-08T00:00:00Z'}};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function fixture(){let active=true;const fetcher=vi.fn<typeof fetch>(),account={userId:owner,generation:3} as VerifiedAccount,expire=vi.fn();return{fetcher,expire,client:createLogoVectorProposalApplicationClient(account,projectId,()=>active,expire,fetcher),leave:()=>{active=false;}};}
describe('separate owner-fenced explicit candidate application client',()=>{
 it('retains exact body/key through uncertainty and read-only recovery without paid dispatch',async()=>{
  const f=fixture();f.fetcher.mockRejectedValueOnce(Error('lost'));await expect(f.client.submit(input)).rejects.toThrow();expect(f.client.getPending()).toEqual(command);
  f.fetcher.mockResolvedValueOnce(json({status:'not_found'}));expect(await f.client.recover(false)).toBeNull();expect(f.fetcher.mock.calls[1]![1]?.method).toBe('GET');expect(f.client.getPending()).toEqual(command);
  f.fetcher.mockResolvedValueOnce(json({status:'not_found'})).mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(json(workspace));expect(await f.client.recover(true)).toMatchObject({status:'succeeded',receipt,workspace});expect(f.fetcher.mock.calls[3]![1]?.body).toBe(JSON.stringify(input));expect(f.client.getPending()).toBeNull();
 });
 it('a double submit recovers the original request instead of starting another POST',async()=>{
  const f=fixture();f.fetcher.mockRejectedValueOnce(Error('lost'));await expect(f.client.submit(input)).rejects.toThrow();f.fetcher.mockResolvedValueOnce(json({status:'not_found'}));await f.client.submit(structuredClone(input));expect(f.fetcher.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(1);
  await expect(f.client.submit({...input,requestKey:randomUUID()})).rejects.toMatchObject({status:409});
 });
 it('uses the original full command for cancellation and preserves pending on unproven not_found',async()=>{
  const f=fixture();f.fetcher.mockRejectedValueOnce(Error('lost'));await expect(f.client.submit(input)).rejects.toThrow();f.fetcher.mockResolvedValueOnce(json({status:'not_found'}));await expect(f.client.cancel()).rejects.toMatchObject({status:502});expect(f.client.getPending()).toEqual(command);
  f.fetcher.mockResolvedValueOnce(json({status:'cancelled',ownerId:owner,projectId,requestKey,command}));expect(await f.client.cancel()).toEqual({status:'cancelled'});expect(JSON.parse(String(f.fetcher.mock.calls[2]![1]?.body))).toEqual(command);expect(f.client.getPending()).toBeNull();
 });
 it('never adopts a historical receipt as the latest workspace after newer edits',async()=>{
  const f=fixture(),latest={...workspace,heads:{...workspace.heads,workspaceRevision:8}};f.fetcher.mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(json(latest));expect(await f.client.submit(input)).toMatchObject({receipt,workspace:latest});
 });
 it.each(['owner','command','receipt'] as const)('rejects substituted %s in recovery',async reason=>{
  const f=fixture();f.fetcher.mockRejectedValueOnce(Error('lost'));await expect(f.client.submit(input)).rejects.toThrow();const value={status:'succeeded',ownerId:owner,projectId,requestKey,command:structuredClone(command),receipt:structuredClone(receipt)};
  if(reason==='owner')value.ownerId=randomUUID();if(reason==='command')value.command.body.proposalId=randomUUID();if(reason==='receipt')value.receipt.revision.payload.approvalId=randomUUID() as never;
  f.fetcher.mockResolvedValueOnce(json(value));await expect(f.client.recover(false)).rejects.toMatchObject({status:502});expect(f.client.getPending()).toEqual(command);
 });
 it('hides pending data and delayed output after owner/session generation changes',async()=>{
  const f=fixture();let resolve!:(value:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const wait=f.client.submit(input);f.leave();resolve(json(receipt));expect(await wait).toBeNull();expect(f.client.getPending()).toBeNull();expect(f.fetcher).toHaveBeenCalledOnce();
 });
 it('expires only the captured active session on 401 and never retries',async()=>{const f=fixture();f.fetcher.mockResolvedValueOnce(new Response('',{status:401}));await expect(f.client.submit(input)).rejects.toMatchObject({status:401});expect(f.expire).toHaveBeenCalledOnce();expect(f.fetcher).toHaveBeenCalledOnce();});
 it('rejects oversized response bodies and keeps uncertain request identity',async()=>{const f=fixture();f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(2_097_153),{headers:{'content-type':'application/json'}}));await expect(f.client.submit(input)).rejects.toMatchObject({status:502});expect(f.client.getPending()).toEqual(command);});
});
