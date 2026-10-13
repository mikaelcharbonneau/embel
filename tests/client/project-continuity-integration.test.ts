// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';
import {AccountSessionProvider} from '@/components/workspace/account-session';
import {AccountProjectEditor} from '@/components/workspace/account-project-editor';
import {contextSnapshotSchema} from '@/domain/projects';
vi.mock('@/components/workspace/account-strategy-editor',()=>({AccountStrategyEditor:({storage}:{storage:{scopeControl:React.ReactNode;projectContext?:React.ReactNode}})=>createElement('div',null,storage.scopeControl,storage.projectContext)}));
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;let root:Root|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
it('shows saved project continuation and frozen attached sources without new generation',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const requests:string[]=[];
 const project={id:id(2),owner_id:id(1),current_revision:1,scope:'complete_brand',title:'Fictional brand',context:contextSnapshotSchema.parse({description:'A service'}),created_at:'2026-10-07T00:00:00Z'};
 vi.stubGlobal('fetch',vi.fn(async(input:unknown,init?:RequestInit)=>{const path=String(input);requests.push((init?.method??'GET')+' '+path);let value:unknown={};
 if(path==='/api/session')value={user:{id:id(1)}};else if(path===`/api/projects/${id(2)}`)value={project};else if(path.includes('/idea-attachments'))value={ownerId:id(1),projectId:id(2),items:[],nextCursor:null};else if(path.endsWith('/standalone-source'))value={ownerId:id(1),projectId:id(2),source:null};else if(path.endsWith('/idea-source'))value={source:null};
 return new Response(JSON.stringify(value),{status:200});}));
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(AccountSessionProvider,null,createElement(AccountProjectEditor,{projectId:id(2)}))));
 for(let i=0;i<60&&!host.querySelector('[aria-label="Brand context and continuation"]');i++)await act(async()=>{await new Promise(r=>setTimeout(r,5));});
 expect(host.querySelector('[aria-label="Brand context and continuation"]')).not.toBeNull();expect(host.querySelector('[aria-label="Attached Idea sources"]')).not.toBeNull();expect(host.textContent).toContain('Continue your Strategy');expect(requests.every(r=>r.startsWith('GET '))).toBe(true);expect(host.querySelector(`a[href="/brands/account/${id(2)}/logo"]`)?.textContent).toBe('Open logo workspace');expect(host.querySelector(`a[href="/brands/account/${id(2)}/inspiration"]`)?.textContent).toBe('Open Inspiration');expect(host.querySelector(`a[href="/brands/account/${id(2)}/identity"]`)?.textContent).toBe('Saved references and systems');
});
