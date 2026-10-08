import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createLogoTransactionService} from '@/server/data/logo-transaction';
import type {IdentityConnectionFactory} from '@/server/data/identity-transaction';
import {proposalMutationFixture} from '../features/logo-vector/proposal-mutation-fixtures';

async function fixture(){
 const f=await proposalMutationFixture(),events:string[]=[],revisionId=randomUUID(),vectorRevisionId=randomUUID();let replay=false,lost=false,roleMismatch=false;
 const revision={version:2,id:revisionId,ownerId:f.revision.ownerId,projectId:f.projectId,stage:'refinements',revision:1,parentRevisionId:null,inputRevisions:f.revision.inputRevisions,inputHash:'a'.repeat(64),payload:{rasterRevisionIds:[],vectorRevisionId,approvalId:null,sourceRequestKey:f.command.body.requestKey},createdAt:'2026-10-08T00:00:00Z'};
 const receipt={ownerId:f.revision.ownerId,projectId:f.projectId,requestKey:f.command.body.requestKey,revision,workspace:{...f.workspace,heads:{...f.workspace.heads,workspaceRevision:2,stageRevisions:{...f.workspace.heads.stageRevisions,refinements:1}},stages:{...f.workspace.stages,refinements:{stage:'refinements',id:revisionId,revision:1}}}};
 const factory:IdentityConnectionFactory={acquire:async()=>({binding:{ownerId:f.revision.ownerId,roleName:'synthetic_application',roleOid:123},connection:{query:async(sql,args)=>{
  events.push(sql);if(sql.includes('session_user'))return{rows:[{role_name:'synthetic_application',role_oid:roleMismatch?124:123}]};
  if(sql.includes('read_logo_trusted_request')){expect(JSON.parse(String(args?.[1]))).toEqual(f.command);return{rows:[{value:replay?receipt:null}]};}
  if(sql.includes('apply_logo_trusted_command')){expect(JSON.parse(String(args?.[1]))).toEqual(f.command);replay=true;return{rows:[{value:receipt}]};}
  if(sql==='COMMIT'&&lost)throw Error('Lost acknowledgement');return{rows:[]};},release:discard=>{events.push(`release:${discard}`);},discard:()=>{events.push('discard');}}})};
 const producer=vi.fn(async()=>{events.push('producer');return f.run();});
 return{...f,events,receipt,producer,factory,service:createLogoTransactionService(factory,{applyLogoVectorProposal:producer}),replay:()=>{replay=true;},lose:()=>{lost=true;},wrongRole:()=>{roleMismatch=true;}};
}
describe('trusted proposal application recovery',()=>{
 it('routes a distinct command and stages bytes before BEGIN, returning only after COMMIT',async()=>{const f=await fixture();expect(await f.service.run(f.auth,f.projectId,f.command)).toEqual(f.receipt);expect(f.events.indexOf('producer')).toBeLessThan(f.events.indexOf('BEGIN'));expect(f.events).toContain('COMMIT');});
 it('exact original-body replay precedes all source/font work even after heads or rights change',async()=>{const f=await fixture();f.replay();f.workspace.heads.workspaceRevision=99;f.fonts[0]!.bytes=new Uint8Array();expect(await f.service.run(f.auth,f.projectId,f.command)).toEqual(f.receipt);expect(f.producer).not.toHaveBeenCalled();expect(f.publications).toHaveLength(0);});
 it('lost COMMIT remains uncertain and replays without repeated producer I/O',async()=>{const f=await fixture();f.lose();await expect(f.service.run(f.auth,f.projectId,f.command)).rejects.toMatchObject({name:'LogoUncertainCommitError',recovery:{projectId:f.projectId,input:f.command}});expect(await f.service.run(f.auth,f.projectId,f.command)).toEqual(f.receipt);expect(f.producer).toHaveBeenCalledOnce();expect(f.events).toContain('release:true');});
 it('checks current role/OID binding before returning an existing receipt',async()=>{const f=await fixture();f.replay();f.wrongRole();await expect(f.service.run(f.auth,f.projectId,f.command)).rejects.toMatchObject({code:'integration_unavailable'});expect(f.producer).not.toHaveBeenCalled();});
 it('rejects caller-supplied edits or evidence before acquiring a connection',async()=>{const f=await fixture();await expect(f.service.run(f.auth,f.projectId,{...f.command,body:{...f.command.body,edit:{kind:'size',scale:2}}})).rejects.toMatchObject({code:'invalid_input'});expect(f.events).toEqual([]);});
 it('checks cancellation between staging and BEGIN',async()=>{const f=await fixture(),c=new AbortController(),p=vi.fn(async()=>{const evidence=await f.run();c.abort();return evidence;});await expect(createLogoTransactionService(f.factory,{applyLogoVectorProposal:p}).run(f.auth,f.projectId,f.command,c.signal)).rejects.toBeDefined();expect(f.events).not.toContain('BEGIN');});
});
