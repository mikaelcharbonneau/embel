import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
const f=vi.hoisted(()=>({auth:vi.fn(),lookup:vi.fn(),close:vi.fn(),pending:vi.fn()}));
vi.mock('@/server/auth/context',()=>({getAuthenticatedContext:f.auth}));
vi.mock('@/server/data/logo-vector-proposals',()=>({readLogoVectorProposalRequest:f.lookup,closeLogoVectorProposalRequest:f.close,listPendingLogoVectorProposalRequests:f.pending}));
import { POST as lookup } from '@/app/api/projects/[projectId]/logo/vector-proposals/requests/[requestKey]/lookup/route';
import { GET as pending } from '@/app/api/projects/[projectId]/logo/vector-proposals/requests/current/route';
import { POST as cancel } from '@/app/api/projects/[projectId]/logo/vector-proposals/requests/[requestKey]/cancel/route';
import { ApiError } from '@/server/http/errors';
import { proposalHeads,proposalId } from '../features/logo-vector/proposal-fixtures';
const ownerId=proposalId(1),projectId=proposalId(2),requestKey=proposalId(3),input={requestKey,quoteId:proposalId(4),expected:proposalHeads};
const context={params:Promise.resolve({projectId,requestKey})};
const request=(body:unknown=input,origin='https://embel.invalid',query='')=>new Request(`https://embel.invalid/api/projects/${projectId}/logo/vector-proposals/requests/${requestKey}/lookup${query}`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('APP_ORIGIN','https://embel.invalid');f.auth.mockResolvedValue({userId:ownerId});});
afterEach(()=>vi.unstubAllEnvs());
describe('exact original vector proposal request HTTP boundaries',()=>{
 it.each([['lookup',lookup,f.lookup],['cancel',cancel,f.close]] as const)('passes only authenticated original intent to finite %s DAL',async(name,handler,method)=>{
  const value={fixture:'owned protocol'},req=request();method.mockResolvedValue(value);const result=await handler(req,context);
  expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store');expect(result.headers.get('vary')).toBe('Cookie');
  expect(await result.json()).toEqual(value);expect(name==='lookup'?f.close:f.lookup).not.toHaveBeenCalled();expect(method).toHaveBeenCalledExactlyOnceWith({userId:ownerId},projectId,input,req.signal);
 });
 it('rejects wrong request key, foreign origin, injected scope/proof and query parameters before any DAL',async()=>{
  for(const handler of [lookup,cancel]){
   expect((await handler(request({...input,requestKey:proposalId(99)}),context)).status).toBe(422);
   expect((await handler(request(input,'https://foreign.invalid'),context)).status).toBe(403);
   expect((await handler(request({...input,ownerId}),context)).status).toBe(422);
   expect((await handler(request({...input,providerReceipt:{}}),context)).status).toBe(422);
   expect((await handler(request(input,undefined,'?ownerId='+ownerId),context)).status).toBe(422);
  }
  expect(f.lookup).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
 });
 it('bounds the original body and requires a valid path before finite SQL access',async()=>{
  expect((await lookup(request({...input,oversized:'x'.repeat(33000)}),context)).status).toBe(413);
  expect((await cancel(request(),{params:Promise.resolve({projectId:'invalid',requestKey})})).status).toBe(404);
  expect(f.lookup).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
 });
 it('retains lookup absence as an error without calling closure or admission',async()=>{
  f.lookup.mockRejectedValue(new ApiError('not_found'));expect((await lookup(request(),context)).status).toBe(404);expect(f.close).not.toHaveBeenCalled();
 });
 it('does not serialize a raw database error as rejection or provider Stop proof',async()=>{
  f.close.mockRejectedValue(Error('private database error payload'));const result=await cancel(request(),context);expect(result.status).toBe(500);expect(await result.text()).not.toContain('private database error payload');expect(f.lookup).not.toHaveBeenCalled();
 });
 it('discovers bounded current requests through GET without a mutation or caller intent',async()=>{
  const value={ownerId,projectId,items:[],nextCursor:null};f.pending.mockResolvedValue(value);
  const req=new Request(`https://embel.invalid/api/projects/${projectId}/logo/vector-proposals/requests/current?cursor=${requestKey}&limit=5`),result=await pending(req,{params:Promise.resolve({projectId})});
  expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(f.pending).toHaveBeenCalledExactlyOnceWith({userId:ownerId},projectId,{cursor:requestKey,limit:5},req.signal);expect(f.lookup).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
 });
 it.each(['?limit=11','?limit=0','?limit=1.5','?limit=01','?cursor=invalid','?limit=1&limit=2','?cursor='+requestKey+'&cursor='+requestKey,'?ownerId='+ownerId])('rejects invalid pending-discovery query %s without finite SQL',async query=>{
  expect((await pending(new Request('https://embel.invalid/api'+query),{params:Promise.resolve({projectId})})).status).toBe(422);expect(f.pending).not.toHaveBeenCalled();
 });
 it('requires authentication before recovery, closure or project information',async()=>{
  f.auth.mockRejectedValue(new ApiError('unauthenticated'));expect((await lookup(request(),context)).status).toBe(401);expect((await cancel(request(),context)).status).toBe(401);expect(f.lookup).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
 });
});
