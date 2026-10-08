import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
const f=vi.hoisted(()=>({auth:vi.fn(),read:vi.fn()}));
vi.mock('@/server/auth/context',()=>({getAuthenticatedContext:f.auth}));
vi.mock('@/server/data/logo-capabilities',()=>({readLogoCapabilities:f.read}));
import { GET } from '../../src/app/api/projects/[projectId]/logo/capabilities/route';
import { ApiError } from '../../src/server/http/errors';
const projectId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',ownerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const context={params:Promise.resolve({projectId})};
beforeEach(()=>{vi.resetAllMocks();f.auth.mockResolvedValue({userId:ownerId,client:{}});});
describe('capabilities hint HTTP endpoint',()=>{
 it('uses only the authenticated owned read and returns private no-store JSON',async()=>{
  const hint={ownerId,projectId,observedAt:'2026-10-07T03:00:00Z',operations:{}};f.read.mockResolvedValue(hint);
  const request=new Request('https://fluid.invalid/api/projects/'+projectId+'/logo/capabilities');const response=await GET(request,context);
  expect(response.status).toBe(200);expect(await response.json()).toEqual(hint);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie');
  expect(f.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({userId:ownerId}),projectId,request.signal);
 });
 it('rejects client owner, operation and cache parameters without reading',async()=>{
  for(const query of ['ownerId='+ownerId,'operation=identity.logo_concept','observedAt=now'])expect((await GET(new Request('https://fluid.invalid/api?'+query),context)).status).toBe(422);
  expect(f.read).not.toHaveBeenCalled();
 });
 it('fails closed on auth, missing project or unavailable SQL without exposing internal errors',async()=>{
  f.auth.mockRejectedValue(new ApiError('unauthenticated'));expect((await GET(new Request('https://fluid.invalid/api'),context)).status).toBe(401);expect(f.read).not.toHaveBeenCalled();
  f.auth.mockResolvedValue({userId:ownerId,client:{}});
  for(const code of ['not_found','integration_unavailable'] as const){f.read.mockRejectedValue(new ApiError(code));const response=await GET(new Request('https://fluid.invalid/api'),context);expect(response.status).toBe(code==='not_found'?404:503);expect(response.headers.get('cache-control')).toBe('private, no-store');}
  f.read.mockRejectedValue(Error('private credential/configuration failure'));const response=await GET(new Request('https://fluid.invalid/api'),context);expect(response.status).toBe(500);expect(JSON.stringify(await response.json())).not.toContain('private credential');
 });
});
