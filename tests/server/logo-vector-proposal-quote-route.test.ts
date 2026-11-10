import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('@/server/config',()=>({getApplicationOrigin:()=> 'https://fluid.invalid'}));
const f=vi.hoisted(()=>({auth:vi.fn(),legacy:vi.fn(),resolve:vi.fn(),quote:vi.fn()}));
vi.mock('@/server/auth/context',()=>({getAuthenticatedContext:f.auth}));
vi.mock('@/server/data/logo-jobs',()=>({quoteLogoOperation:f.legacy}));
vi.mock('@/server/runtime/logo-request-services',()=>({resolveLogoRequestServices:f.resolve}));
import { POST } from '@/app/api/projects/[projectId]/logo/quotes/route';
import { proposalHeads,proposalId } from '../features/logo-vector/proposal-fixtures';
const projectId=proposalId(2),ownerId=proposalId(1),context={params:Promise.resolve({projectId})};
const input={operation:'propose_vector_edit',expected:proposalHeads,baseVectorRevisionId:proposalId(5),instruction:'Rotate the symbol',targetComponentIds:['synthetic-symbol']};
const request=(body:unknown,origin='https://fluid.invalid')=>new Request('https://fluid.invalid/api/projects/'+projectId+'/logo/quotes',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();f.auth.mockResolvedValue({userId:ownerId,client:{}});f.resolve.mockResolvedValue({proposalQuotes:{quoteLogoVectorProposal:f.quote}});});
it('refuses vector edit proposal quotes now that the vector editor is removed',async()=>{
 const response=await POST(request(input),context);
 expect(response.status).toBe(422);expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(f.resolve).not.toHaveBeenCalled();expect(f.quote).not.toHaveBeenCalled();expect(f.legacy).not.toHaveBeenCalled();
});;
it('keeps legacy quote calls on their original path',async()=>{
 const body={operation:'concepts',expected:proposalHeads,briefRevisionId:proposalId(3),referenceSnapshotId:proposalId(4)};f.legacy.mockResolvedValue({fixture:'legacy'});
 expect((await POST(request(body),context)).status).toBe(200);expect(f.legacy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:ownerId}),projectId,body);expect(f.resolve).not.toHaveBeenCalled();
});
it('fails before resolving privileged services for untrusted origin or client proof fields',async()=>{
 expect((await POST(request(input,'https://other.invalid'),context)).status).toBe(403);
 expect((await POST(request({...input,context:{}}),context)).status).toBe(422);expect(f.resolve).not.toHaveBeenCalled();expect(f.quote).not.toHaveBeenCalled();expect(f.legacy).not.toHaveBeenCalled();
});
