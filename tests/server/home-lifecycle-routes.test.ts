import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
const f=vi.hoisted(()=>({auth:vi.fn(),attach:vi.fn(),attachRead:vi.fn(),list:vi.fn(),promote:vi.fn(),promoteRead:vi.fn(),source:vi.fn(),snapshot:vi.fn()}));
vi.mock('@/server/auth/context',()=>({getAuthenticatedContext:f.auth}));
vi.mock('@/server/data/home-lifecycle',()=>({attachIdeaToProject:f.attach,readIdeaProjectAttachmentRequest:f.attachRead,getProjectIdeaAttachments:f.list,promoteStandaloneWorkspace:f.promote,readStandalonePromotionRequest:f.promoteRead,getStandalonePromotionSource:f.source,getStandalonePromotionSnapshot:f.snapshot}));
import { POST as attach } from '@/app/api/ideas/[ideaId]/projects/route';
import { GET as attachRead } from '@/app/api/ideas/project-attachments/requests/[requestKey]/route';
import { GET as list } from '@/app/api/projects/[projectId]/idea-attachments/route';
import { POST as promote } from '@/app/api/workspaces/promotions/route';
import { GET as promoteRead } from '@/app/api/workspaces/promotions/requests/[requestKey]/route';
import { GET as source } from '@/app/api/projects/[projectId]/standalone-source/route';
import { GET as snapshot } from '@/app/api/projects/[projectId]/standalone-source/snapshot/route';
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const params={params:Promise.resolve({ideaId:id(3),projectId:id(4),requestKey:id(2)})};
const post=(body:unknown,origin='https://fluid.invalid')=>new Request('https://fluid.invalid/api',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('APP_ORIGIN','https://fluid.invalid');f.auth.mockResolvedValue({userId:id(1),client:{}});});afterEach(()=>vi.unstubAllEnvs());
it('binds explicit attachment to route idea and authenticated context, with origin and strict body gates',async()=>{
 const input={requestKey:id(2),ideaId:id(3),expectedIdeaRevision:1,projectId:id(4),expectedProjectRevision:1};f.attach.mockResolvedValue({fixture:'receipt'});
 expect((await attach(post(input),params)).status).toBe(200);expect(f.attach.mock.calls[0]!.slice(1)).toEqual([id(3),input]);
 expect((await attach(post({...input,ownerId:id(9)}),params)).status).toBe(422);
 expect((await attach(post(input,'https://foreign.invalid'),params)).status).toBe(403);expect(f.attach).toHaveBeenCalledTimes(1);
});
it('keeps explicit promotion bounded and privately cached',async()=>{
 const input={requestKey:id(2),workspaceId:id(5),expectedWorkspaceRevision:1,selection:{tool:'trademarks'},contextSource:null,title:'Fictional brand'};f.promote.mockResolvedValue({fixture:'receipt'});
 const response=await promote(post(input));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(f.promote.mock.calls[0]![1]).toEqual(input);
 expect((await promote(post({...input,ownerId:id(9)}))).status).toBe(422);expect(f.promote).toHaveBeenCalledTimes(1);
});
it('bounds list queries and rejects duplicate or unknown filters',async()=>{
 f.list.mockResolvedValue({items:[],nextCursor:null});expect((await list(new Request('https://fluid.invalid/api?limit=2&cursor='+id(8)),params)).status).toBe(200);
 expect(f.list.mock.calls[0]!.slice(1)).toEqual([id(4),{limit:2,cursor:id(8)}]);
 for(const q of ['limit=51','limit=2&limit=3','ownerId='+id(9),'cursor=bad'])expect((await list(new Request('https://fluid.invalid/api?'+q),params)).status).toBe(422);expect(f.list).toHaveBeenCalledTimes(1);
});
it.each([[attachRead,'attachRead'],[promoteRead,'promoteRead'],[source,'source'],[snapshot,'snapshot']] as const)('uses authenticated exact scope for recovery and provenance',async(get,name)=>{
 f[name].mockResolvedValue({fixture:name});const response=await get(new Request('https://fluid.invalid/api'),params);expect(response.status).toBe(200);expect(f[name].mock.calls[0]![1]).toBe(name==='source'||name==='snapshot'?id(4):id(2));expect(response.headers.get('cache-control')).toBe('private, no-store');
});
