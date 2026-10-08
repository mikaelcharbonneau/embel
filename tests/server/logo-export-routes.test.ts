import {beforeEach,afterEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));const f=vi.hoisted(()=>({auth:vi.fn(),overview:vi.fn(),read:vi.fn(),request:vi.fn()}));
vi.mock('@/server/auth/context',()=>({getAuthenticatedContext:f.auth}));
vi.mock('@/server/data/logo-deliverables',()=>({getLogoDeliverables:f.overview,getLogoExport:f.read,requestLogoExport:f.request}));
import {GET as overview} from '@/app/api/projects/[projectId]/logo/deliverables/route';
import {GET as read} from '@/app/api/projects/[projectId]/logo/exports/[exportId]/route';
import {POST as request} from '@/app/api/projects/[projectId]/logo/exports/route';
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={params:Promise.resolve({projectId:id(2),exportId:id(3)})};
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('APP_ORIGIN','https://fluid.invalid');f.auth.mockResolvedValue({userId:id(1),client:{}});});afterEach(()=>vi.unstubAllEnvs());
it('bounds both export and request pagination independently',async()=>{
 f.overview.mockResolvedValue({fixture:'overview'});const req=new Request(`https://fluid.invalid/api?limit=2&requestCursor=${id(8)}&cursor=${id(9)}`);const response=await overview(req,context);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(f.overview.mock.calls[0]!.slice(1)).toEqual([id(2),{limit:2,requestCursor:id(8),cursor:id(9)},req.signal]);
 for(const q of ['limit=51','requestCursor=bad','ownerId='+id(1),'limit=1&limit=2'])expect((await overview(new Request('https://fluid.invalid/api?'+q),context)).status).toBe(422);expect(f.overview).toHaveBeenCalledTimes(1);
});
it('reads one exact owned immutable manifest',async()=>{f.read.mockResolvedValue({fixture:'manifest'});const req=new Request('https://fluid.invalid/api');expect((await read(req,context)).status).toBe(200);expect(f.read.mock.calls[0]!.slice(1)).toEqual([id(2),id(3),req.signal]);});
it('rejects absent origin or malformed export intent before admission',async()=>{
 const response=await request(new Request('https://fluid.invalid/api',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),context);expect(response.status).toBe(403);
 expect((await request(new Request('https://fluid.invalid/api',{method:'POST',headers:{origin:'https://fluid.invalid','content-type':'application/json'},body:JSON.stringify({ownerId:id(1)})}),context)).status).toBe(422);expect(f.request).not.toHaveBeenCalled();
});
import {LogoExportAdmissionRejectedError} from '@/features/identity-deliverables/server/admission-errors';
import {syntheticLogoWorkspace} from '../fixtures/logo-creation';
import {ApiError} from '@/server/http/errors';
const intent={requestKey:id(80),expected:syntheticLogoWorkspace().heads,approvedLogoId:id(81),directionApprovalId:id(82),variantSetId:id(83),pngLongEdge:512 as const,socialSelections:[]};
const proof={status:'rejected' as const,operation:'identity.logo_export' as const,ownerId:id(1),projectId:id(2),requestKey:intent.requestKey,input:intent};
const exportRequest=()=>new Request('https://fluid.invalid/api',{method:'POST',headers:{origin:'https://fluid.invalid','content-type':'application/json'},body:JSON.stringify(intent)});
it('returns only an exact committed export rejection proof',async()=>{f.request.mockRejectedValue(new LogoExportAdmissionRejectedError(proof));const response=await request(exportRequest(),context);expect(response.status).toBe(409);expect(response.headers.get('cache-control')).toBe('private, no-store');expect((await response.json()).rejection).toEqual(proof);});
it.each([{...proof,ownerId:id(90)},{...proof,projectId:id(90)},{...proof,input:{...intent,pngLongEdge:1024 as const}}])('withholds mismatched rejection proof %#',async rejected=>{f.request.mockRejectedValue(new LogoExportAdmissionRejectedError(rejected));const response=await request(exportRequest(),context);expect(response.status).toBe(409);expect((await response.json()).rejection).toBeUndefined();});
it('does not turn an ordinary conflict into rejection evidence',async()=>{f.request.mockRejectedValue(new ApiError('conflict'));expect((await(await request(exportRequest(),context)).json()).rejection).toBeUndefined();});
