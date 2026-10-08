import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const f=vi.hoisted(()=>({resolve:vi.fn(),auth:vi.fn(),batches:vi.fn(),refinements:vi.fn(),refinement:vi.fn(),current:vi.fn(),detail:vi.fn()}));
vi.mock('../../src/server/auth/context',()=>({getAuthenticatedContext:f.auth}));
vi.mock('../../src/server/data/logo-workspace',()=>({listLogoConceptBatches:f.batches,listLogoRasterRefinements:f.refinements,readLogoRasterRefinement:f.refinement,readLogoCurrentVectorRevisionId:f.current,readLogoVectorDetail:f.detail}));
vi.mock('@/server/runtime/logo-request-services',()=>({resolveLogoRequestServices:f.resolve}));
import {GET as batches} from '../../src/app/api/projects/[projectId]/logo/batches/route';
import {GET as refinements} from '../../src/app/api/projects/[projectId]/logo/raster-refinements/route';
import {GET as refinement} from '../../src/app/api/projects/[projectId]/logo/raster-refinements/[rasterRevisionId]/route';
import {GET as currentVector} from '../../src/app/api/projects/[projectId]/logo/vector/current/route';
import {GET as vectorDetail} from '../../src/app/api/projects/[projectId]/logo/vector/revisions/[vectorRevisionId]/route';
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={params:Promise.resolve({projectId:id(2),rasterRevisionId:id(3)})};
beforeEach(()=>{vi.resetAllMocks();f.auth.mockResolvedValue({userId:id(1),client:{}});f.resolve.mockResolvedValue({workspace:{readLogoVectorDetail:f.detail}});});afterEach(()=>vi.unstubAllEnvs());
describe('owned logo history routes',()=>{
 it.each([['batches',batches],['refinements',refinements]] as const)('%s bounds pages and forbids arbitrary filters',async(name,get)=>{
  const service=name==='batches'?f.batches:f.refinements;service.mockResolvedValue({ownerId:id(1),projectId:id(2),items:[],nextCursor:null});
  const response=await get(new Request('https://fluid.invalid/api?limit=5&cursor=opaque'),context);
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(service.mock.calls[0]!.slice(1)).toEqual([id(2),{limit:5,cursor:'opaque'}]);
  for(const query of ['limit=51','ownerId=foreign','limit=1&limit=2'])expect((await get(new Request('https://fluid.invalid/api?'+query),context)).status).toBe(422);
  expect(service).toHaveBeenCalledTimes(1);
 });
 it('uses exact project and revision with the authenticated context',async()=>{
  f.refinement.mockResolvedValue({fixture:'owned-refinement'});expect((await refinement(new Request('https://fluid.invalid/api'),context)).status).toBe(200);
  expect(f.refinement.mock.calls[0]!.slice(1)).toEqual([id(2),id(3)]);
 });
 it('returns the authoritative current vector with verified owner scope',async()=>{
  f.current.mockResolvedValue(id(9));
  const response=await currentVector(new Request('https://fluid.invalid/api'),context);
  expect(await response.json()).toEqual({ownerId:id(1),projectId:id(2),vectorRevisionId:id(9)});
  expect(f.current.mock.calls[0]!.slice(1)).toEqual([id(2)]);
 });
 it('passes the exact vector revision and abort signal to the validated detail service',async()=>{
  const request=new Request('https://fluid.invalid/api');f.detail.mockResolvedValue({fixture:'validated-detail'});
  const response=await vectorDetail(request,{params:Promise.resolve({projectId:id(2),vectorRevisionId:id(9)})});
  expect(response.status).toBe(200);expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({userId:id(1)}),id(2),request.signal);expect(f.detail.mock.calls[0]!.slice(1)).toEqual([id(2),id(9),request.signal]);
 });

});
