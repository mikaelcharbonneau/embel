import {beforeEach,afterEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));const f=vi.hoisted(()=>({auth:vi.fn(),capability:vi.fn(),stage:vi.fn(),read:vi.fn(),save:vi.fn(),saved:vi.fn()}));
vi.mock('@/server/auth/context',()=>({getAuthenticatedContext:f.auth}));vi.mock('@/server/home-attachments',()=>({getHomeAttachmentCapability:f.capability,stageHomeAttachment:f.stage,readHomeAttachmentRequest:f.read,saveAttachedProjectDraft:f.save,readAttachedProjectDraftRequest:f.saved}));
import {GET as capability} from '@/app/api/home/attachments/capability/route';
import {POST as upload} from '@/app/api/home/attachments/route';
import {GET as read} from '@/app/api/home/attachments/requests/[requestKey]/route';
import {POST as save} from '@/app/api/home/projects/route';
import {GET as saved} from '@/app/api/home/projects/requests/[requestKey]/route';
import {contextSnapshotSchema} from '@/domain/projects';
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;const context={params:Promise.resolve({requestKey:id(2)})};
const policy={allowedMimeTypes:['text/plain'],maxFiles:5,maxFileBytes:10485760,maxTotalBytes:26214400};
const headers={origin:'https://fluid.invalid','content-type':'text/plain','X-Embel-Account':id(1),'x-fluid-request-key':id(2),'x-fluid-attachment-name':encodeURIComponent('Québec.txt'),'x-fluid-content-hash':'a'.repeat(64)};
const projectInput={requestKey:id(2),project:{title:'Retained brief',scope:'complete_brand',context:contextSnapshotSchema.parse({description:'Typed brief'})},attachmentIds:[id(3)]};
const saveRequest=()=>new Request('https://fluid.invalid/api/home/projects',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(projectInput)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('APP_ORIGIN','https://fluid.invalid');f.auth.mockResolvedValue({userId:id(1),client:{}});f.capability.mockReturnValue(policy);});afterEach(()=>vi.unstubAllEnvs());
it('reports actual capability privately and identifies unavailable configuration',async()=>{f.capability.mockReturnValue(null);const r=await capability();expect(await r.json()).toMatchObject({ownerId:id(1),policy:null,reason:expect.any(String)});expect(r.headers.get('cache-control')).toBe('private, no-store');});
it('passes raw bounded bytes and exact decoded metadata without creating a project',async()=>{f.stage.mockResolvedValue({fixture:'verified'});const req=new Request('https://fluid.invalid/api',{method:'POST',headers,body:'hello'});const r=await upload(req);expect(r.status).toBe(200);expect(await r.json()).toEqual({requestKey:id(2),attachment:{fixture:'verified'}});expect(f.stage.mock.calls[0]!.slice(1)).toEqual([{requestKey:id(2),name:'Québec.txt',mimeType:'text/plain',contentHash:'a'.repeat(64)},new TextEncoder().encode('hello'),req.signal]);expect(f.save).not.toHaveBeenCalled();});
it('rejects malformed metadata and counts actual bytes rather than trusting content-length',async()=>{expect((await upload(new Request('https://fluid.invalid/api',{method:'POST',headers:{...headers,'x-fluid-attachment-name':'%bad'},body:'x'}))).status).toBe(422);const req=new Request('https://fluid.invalid/api',{method:'POST',headers:{...headers,'content-length':'1'},body:new Uint8Array(10485761)});expect((await upload(req)).status).toBe(413);expect(f.stage).not.toHaveBeenCalled();});
it('requires origin and configured storage before accepting an upload',async()=>{f.capability.mockReturnValue(null);expect((await upload(new Request('https://fluid.invalid/api',{method:'POST',headers,body:'x'}))).status).toBe(503);expect((await upload(new Request('https://fluid.invalid/api',{method:'POST',headers:{...headers,origin:'https://foreign.invalid'},body:'x'}))).status).toBe(403);expect(f.stage).not.toHaveBeenCalled();});
it.each([[read,'read'],[saved,'saved']] as const)('uses exact authenticated request recovery',async(get,key)=>{f[key].mockResolvedValue({status:'not_found'});const req=new Request('https://fluid.invalid/api');expect((await get(req,context)).status).toBe(200);expect(f[key].mock.calls[0]!.slice(1)).toEqual([id(2),req.signal]);});
it('rejects malformed final-save commands without project writes',async()=>{expect((await save(new Request('https://fluid.invalid/api',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'}))).status).toBe(422);expect(f.save).not.toHaveBeenCalled();});
it('creates an attached project only for the captured authenticated account',async()=>{
 f.save.mockResolvedValue({fixture:'receipt'});const req=saveRequest();
 expect((await save(req)).status).toBe(200);expect(f.save).toHaveBeenCalledWith({userId:id(1),client:{}},projectInput,req.signal);
});
it.each([undefined,'invalid',id(9)])('rejects missing or mismatched accounts before upload or project creation: %s',async expectedOwner=>{
 const uploadRequest=new Request('https://fluid.invalid/api/home/attachments',{method:'POST',headers,body:'private bytes'}),projectRequest=saveRequest();
 for(const req of [uploadRequest,projectRequest]) { if(expectedOwner)req.headers.set('X-Embel-Account',expectedOwner);else req.headers.delete('X-Embel-Account'); }
 expect((await upload(uploadRequest)).status).toBe(401);expect(uploadRequest.bodyUsed).toBe(false);
 expect((await save(projectRequest)).status).toBe(401);expect(projectRequest.bodyUsed).toBe(false);
 expect(f.capability).not.toHaveBeenCalled();expect(f.stage).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
});
it('rejects stale owner A headers after cookies authenticate as owner B',async()=>{
 f.auth.mockResolvedValue({userId:id(9),client:{}});
 expect((await upload(new Request('https://fluid.invalid/api/home/attachments',{method:'POST',headers,body:'private bytes'}))).status).toBe(401);
 expect((await save(saveRequest())).status).toBe(401);
 expect(f.stage).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
});
