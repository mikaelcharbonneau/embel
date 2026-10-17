// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccountSessionProvider, useAccountSession, type VerifiedAccount } from '@/components/workspace/account-session';
import { contextSnapshotSchema } from '@/domain/projects';
import { initialNamingPreferencesV2 } from '@/domain/naming-brain-preferences';
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let root:Root|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
async function until(fn:()=>void){let error:unknown;for(let i=0;i<60;i++){await act(async()=>{await new Promise(r=>setTimeout(r,5));});try{fn();return;}catch(e){error=e;}}throw error;}
it('retains pending lifecycle intent across same-owner verification and clears after confirmed sign-out',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 let value:ReturnType<typeof useAccountSession>|undefined,posts=0;
 vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>{
  if(String(input)==='/api/auth/sign-out'){posts++;return new Response(JSON.stringify({authenticated:false}),{status:200});}
  return new Response(JSON.stringify({user:{id:id(1)}}),{status:200});
 }));
 function Probe(){const account=useAccountSession();useLayoutEffect(()=>{value=account;});return null;}
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 await act(async()=>root!.render(createElement(AccountSessionProvider,null,createElement(Probe))));
 await until(()=>expect(value?.session.status).toBe('ready'));
 expect(value?.lifecycleMemory).toBeDefined();expect(value?.homeInputSession).toBeDefined();expect(value?.logoInputSession).toBeDefined();
 const account=value!.session as VerifiedAccount, memory=value!.lifecycleMemory;
 await act(async()=>{memory.set(account,{kind:'idea_attachment',input:{requestKey:id(2),ideaId:id(3),expectedIdeaRevision:1,projectId:id(4),expectedProjectRevision:1},receipt:null,outcome:'uncertain'});});
 expect(await value!.signOut()).toEqual({ok:false,reason:'confirmation_required'});expect(posts).toBe(0);
 await act(async()=>value!.refresh());expect(memory.get(account,'idea_attachment')).toBeNull();
 await until(()=>expect(value!.session.status).toBe('ready'));
 expect(value!.lifecycleMemory).toBe(memory);expect(memory.get(value!.session as VerifiedAccount,'idea_attachment')?.outcome).toBe('uncertain');
 let result:unknown;await act(async()=>{result=await value!.signOut(true);});expect(result).toEqual({ok:true});expect(memory.hasUnsaved()).toBe(false);expect(posts).toBe(1);
});
it('guards sign-out for a retained logo input file and clears it only after confirmed sign-out',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);let value:ReturnType<typeof useAccountSession>|undefined,posts=0;
 vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>{if(String(input)==='/api/auth/sign-out'){posts++;return new Response(JSON.stringify({authenticated:false}),{status:200});}return new Response(JSON.stringify({user:{id:id(1)}}),{status:200});}));
 function Probe(){const account=useAccountSession();useLayoutEffect(()=>{value=account;});return null;}
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(AccountSessionProvider,null,createElement(Probe))));await until(()=>expect(value?.session.status).toBe('ready'));
 const {syntheticLogoWorkspace}=await import('../fixtures/logo-creation');const {emptyLogoInputDraft}=await import('@/features/logo-inputs/client/session');
 const account=value!.session as VerifiedAccount, memory=value!.logoInputSession,workspace={...syntheticLogoWorkspace(),ownerId:account.userId};
 memory.connect(account,workspace,{} as never,false);memory.setDraft(account,workspace.projectId,{...emptyLogoInputDraft(),referenceFile:new File(['synthetic'],'reference.png',{type:'image/png'})});
 expect(await value!.signOut()).toEqual({ok:false,reason:'confirmation_required'});expect(posts).toBe(0);expect(memory.hasUnsaved()).toBe(true);
 await act(async()=>value!.refresh());expect(memory.getDraft(account,workspace.projectId)).toBeNull();await until(()=>expect(value?.session.status).toBe('ready'));const again=value!.session as VerifiedAccount;memory.connect(again,workspace,{} as never,false);expect(memory.getDraft(again,workspace.projectId)?.referenceFile?.name).toBe('reference.png');
 let result:unknown;await act(async()=>{result=await value!.signOut(true);});expect(result).toEqual({ok:true});expect(memory.hasUnsaved()).toBe(false);expect(posts).toBe(1);
});
it('keeps Naming edits private through verification and includes them in confirmed sign-out cleanup', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let value: ReturnType<typeof useAccountSession> | undefined, posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    if (String(input) === '/api/auth/sign-out') { posts++; return Response.json({ authenticated: false }); }
    return Response.json({ user: { id: id(1) } });
  }));
  function Probe() { const account = useAccountSession(); useLayoutEffect(() => { value = account; }); return null; }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Probe))));
  await until(() => expect(value?.session.status).toBe('ready'));
  const account = value!.session as VerifiedAccount, memory = value!.namingBrainDrafts;
  const context = contextSnapshotSchema.parse({ description: 'Synthetic Naming lifecycle' });
  await act(async () => { memory.connectPreferences(account, id(4), null, context); memory.editPreferences(account, id(4), { ...initialNamingPreferencesV2(context), notes: 'Private pending Naming choices' }); });
  expect(await value!.signOut()).toEqual({ ok: false, reason: 'confirmation_required' }); expect(posts).toBe(0);
  await act(async () => value!.refresh()); expect(memory.get(account, id(4))).toBeNull();
  await until(() => expect(value?.session.status).toBe('ready'));
  expect(memory.get(value!.session as VerifiedAccount, id(4))?.preferences?.draft.notes).toBe('Private pending Naming choices');
  await act(async () => { await value!.signOut(true); }); expect(memory.hasUnsaved()).toBe(false); expect(posts).toBe(1);
});
