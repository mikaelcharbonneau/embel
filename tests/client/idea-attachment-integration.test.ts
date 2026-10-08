// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';
import {AccountSessionProvider} from '@/components/workspace/account-session';
import {IdeaDetail} from '@/components/ideas/idea-detail';
import {ideaContentSchema} from '@/domain/ideas';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;let root:Root|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
it('offers attachment from a verified saved Idea without dispatching a mutation',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const writes:string[]=[];
 const idea={id:id(2),ownerId:id(1),revision:1,content:ideaContentSchema.parse({title:'Fictional service idea'}),createdAt:'2026-10-07T00:00:00.000000Z',updatedAt:'2026-10-07T00:00:00.000000Z',links:[]};
 vi.stubGlobal('fetch',vi.fn(async(input:unknown,init?:RequestInit)=>{const path=String(input);if(init?.method&&init.method!=='GET')writes.push(path);return new Response(JSON.stringify(path==='/api/session'?{user:{id:id(1)}}:path===`/api/ideas/${id(2)}`?{idea}:{projects:[],nextCursor:null}),{status:200});}));
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(AccountSessionProvider,null,createElement(IdeaDetail,{ideaId:id(2)}))));
 for(let i=0;i<60&&!host.querySelector('[aria-label="Attach saved Idea to a brand"]');i++)await act(async()=>{await new Promise(r=>setTimeout(r,5));});
 expect(host.textContent).toContain('Fictional service idea');expect(host.querySelector('[aria-label="Attach saved Idea to a brand"]')).not.toBeNull();expect(writes).toEqual([]);
});
