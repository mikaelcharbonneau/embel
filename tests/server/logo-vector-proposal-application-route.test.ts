import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const f=vi.hoisted(()=>({auth:vi.fn(),resolve:vi.fn(),apply:vi.fn(),read:vi.fn()}));
vi.mock('@/server/auth/context',()=>({getAuthenticatedContext:f.auth}));
vi.mock('@/server/runtime/logo-request-services',()=>({resolveLogoRequestServices:f.resolve}));
vi.mock('@/server/data/logo-vector-proposal-application',()=>({readLogoVectorProposalApplication:f.read}));
import {GET,POST} from '@/app/api/projects/[projectId]/logo/vector-proposals/[proposalId]/apply/route';
import {ApiError} from '@/server/http/errors';
const owner=randomUUID(),projectId=randomUUID(),proposalId=randomUUID(),auth={userId:owner};
const input={requestKey:randomUUID(),proposalId,baseVectorRevisionId:randomUUID(),expected:{projectRevision:1,referenceRevision:0,preferencesRevision:0,workspaceRevision:1,stageRevisions:{brief_references:1,concepts:0,vector:0,refinements:0,directions:0,deliverables:0}}};
const context={params:Promise.resolve({projectId,proposalId})},request=(body:unknown=input,origin='https://fluid.invalid',query='')=>new Request('https://fluid.invalid/api'+query,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('APP_ORIGIN','https://fluid.invalid');f.auth.mockResolvedValue(auth);f.resolve.mockResolvedValue({workspace:{applyLogoVectorProposal:f.apply}});});afterEach(()=>vi.unstubAllEnvs());
describe('explicit private proposal application route',()=>{
 it('passes only the exact path-bound command body, auth and signal to trusted composition',async()=>{f.apply.mockResolvedValue({receipt:'local'});const req=request(),response=await POST(req,context);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie');expect(f.apply).toHaveBeenCalledWith(auth,projectId,input,req.signal);expect(f.resolve).toHaveBeenCalledWith(auth,projectId,req.signal);expect(f.read).not.toHaveBeenCalled();});
 it('reads current eligibility and association without resolving mutation capabilities',async()=>{f.read.mockResolvedValue({eligible:false});const req=new Request('https://fluid.invalid/api'),response=await GET(req,context);expect(response.status).toBe(200);expect(await response.json()).toEqual({eligible:false});expect(f.read).toHaveBeenCalledWith(auth,projectId,proposalId,req.signal);expect(f.resolve).not.toHaveBeenCalled();});
 it('rejects anonymous, cross-origin, altered proposal, extra edit and query injection before producer resolution',async()=>{f.auth.mockRejectedValueOnce(new ApiError('unauthenticated'));expect((await POST(request(),context)).status).toBe(401);expect((await POST(request(input,'https://foreign.invalid'),context)).status).toBe(403);expect((await POST(request({...input,proposalId:randomUUID()}),context)).status).toBe(422);expect((await POST(request({...input,edit:{kind:'size',scale:2}}),context)).status).toBe(422);expect((await POST(request(input,undefined,'?ownerId='+owner),context)).status).toBe(422);expect(f.resolve).not.toHaveBeenCalled();});
 it('bounds streamed bodies and keeps unavailable composition unavailable',async()=>{expect((await POST(request({...input,oversized:'x'.repeat(33000)}),context)).status).toBe(413);f.apply.mockRejectedValueOnce(new ApiError('integration_unavailable'));expect((await POST(request(),context)).status).toBe(503);});
});
