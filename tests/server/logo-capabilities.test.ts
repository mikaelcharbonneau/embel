import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { readLogoCapabilities } from '../../src/server/data/logo-capabilities';
import type { AuthenticatedContext } from '../../src/server/auth/context';
const ownerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',projectId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const value=()=>({ownerId,projectId,observedAt:'2026-10-07T03:00:00.000Z',operations:{'identity.logo_concept':{status:'unavailable'},'identity.logo_refine':{status:'unavailable'},'identity.logo_vectorize':{status:'available',expiresAt:'2026-10-07T03:00:10.000Z'},'identity.logo_directions':{status:'unavailable'},'identity.logo_export':{status:'unavailable'}}});
function fixture(data:unknown=value(),error:unknown=null){
 const response=Promise.resolve({data,error});const abortSignal=vi.fn(()=>response);const rpc=vi.fn(()=>Object.assign(response,{abortSignal}));
 return {rpc,abortSignal,auth:{userId:ownerId,client:{rpc}} as unknown as AuthenticatedContext};
}
describe('fixed authenticated capability RPC',()=>{
 it('reads the owned snapshot with the fixed project-only read RPC and abort signal',async()=>{
  const f=fixture(),signal=new AbortController().signal;expect(await readLogoCapabilities(f.auth,projectId,signal)).toEqual(value());
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('read_logo_capabilities',{p_project_id:projectId});expect(f.abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
 });
 it('rejects malformed expiry and owner/project mismatches instead of synthesizing readiness',async()=>{
  for(const data of [{...value(),ownerId:projectId},{...value(),projectId:ownerId}])await expect(readLogoCapabilities(fixture(data).auth,projectId)).rejects.toMatchObject({code:'not_found'});
  for(const data of [null,{}, {...value(),operations:{...value().operations,'identity.logo_vectorize':{status:'available',expiresAt:'2026-10-07T03:02:00Z'}}}])await expect(readLogoCapabilities(fixture(data).auth,projectId)).rejects.toMatchObject({code:'integration_unavailable'});
 });
 it('validates authentication/project before I/O and fences pre/post aborts',async()=>{
  const f=fixture();await expect(readLogoCapabilities({...f.auth,userId:'bad'},projectId)).rejects.toMatchObject({code:'unauthenticated'});
  await expect(readLogoCapabilities(f.auth,'bad')).rejects.toMatchObject({code:'not_found'});expect(f.rpc).not.toHaveBeenCalled();
  const c=new AbortController();c.abort();await expect(readLogoCapabilities(f.auth,projectId,c.signal)).rejects.toMatchObject({code:'integration_unavailable'});expect(f.rpc).not.toHaveBeenCalled();
  const late=new AbortController();f.rpc.mockImplementation(()=>{late.abort();return Object.assign(Promise.resolve({data:value(),error:null}),{abortSignal:f.abortSignal});});
  await expect(readLogoCapabilities(f.auth,projectId,late.signal)).rejects.toMatchObject({code:'integration_unavailable'});
 });
 it('maps unavailable/foreign SQL errors and transport failures without exposing raw messages',async()=>{
  await expect(readLogoCapabilities(fixture(null,{code:'P0002',message:'private'}).auth,projectId)).rejects.toMatchObject({code:'not_found'});
  await expect(readLogoCapabilities(fixture(null,{code:'42883',message:'private'}).auth,projectId)).rejects.toMatchObject({code:'integration_unavailable'});
  const f=fixture();f.rpc.mockImplementation(()=>{throw Error('private transport detail');});await expect(readLogoCapabilities(f.auth,projectId)).rejects.toMatchObject({code:'integration_unavailable'});
 });
});
