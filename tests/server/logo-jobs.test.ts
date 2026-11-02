import { describe,expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { createLogoJobService,LogoAdmissionUncertainError, LogoAdmissionRejectedError, loadLogoVectorInput } from '../../src/server/data/logo-jobs';
import { syntheticLogoQuote, syntheticResolvedLogoConcept } from '../fixtures/logo-creation';
import type { AuthenticatedContext } from '../../src/server/auth/context';
const id=(n:number)=>`a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const expected={projectRevision:1,referenceRevision:0,preferencesRevision:0,workspaceRevision:1,stageRevisions:{brief_references:1,concepts:0,vector:0,refinements:0,directions:0,deliverables:0}};
const intent={requestKey:id(3),quoteId:id(4),acceptedMaxCostMicrousd:100,expected};
function auth(rpc:ReturnType<typeof vi.fn>){return{userId:id(1),client:{rpc}} as unknown as AuthenticatedContext;}
describe('logo durable facade',()=>{
 it('retains exact original admission after a lost acknowledgement without requoting',async()=>{const rpc=vi.fn().mockRejectedValue(new Error('connection dropped'));const service=createLogoJobService();const error=await service.admitLogoOperation(auth(rpc),id(2),intent).catch(e=>e);expect(error).toBeInstanceOf(LogoAdmissionUncertainError);expect(error.recovery).toEqual({projectId:id(2),input:intent});expect(rpc).toHaveBeenCalledExactlyOnceWith('admit_logo_operation',{p_project_id:id(2),p_input:intent});});
 it('rejects foreign receipt after admission as uncertain rather than confirmed failure',async()=>{const rpc=vi.fn().mockResolvedValue({data:{ownerId:id(9),projectId:id(2),requestKey:id(3),operation:'identity.logo_concept',batchId:id(5),jobIds:[id(6)],inputHash:'a'.repeat(64)},error:null});await expect(createLogoJobService().admitLogoOperation(auth(rpc),id(2),intent)).rejects.toBeInstanceOf(LogoAdmissionUncertainError);});
 it('marks only an exact committed durable rejection safe to return to review',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:{kind:'logo_admission_rejected',errorCode:'conflict',rejection:{status:'rejected',ownerId:id(1),projectId:id(2),requestKey:id(3),quoteId:id(4)}},error:null});const error=await createLogoJobService().admitLogoOperation(auth(rpc),id(2),intent).catch(e=>e);expect(error).toBeInstanceOf(LogoAdmissionRejectedError);expect(error.rejection).toEqual({status:'rejected',ownerId:id(1),projectId:id(2),requestKey:id(3),quoteId:id(4)});
 });
 it('does not attach rejection proof to generic conflicts or an already-existing changed request',async()=>{
  for(const message of ['logo_request_conflict','logo_quote_stale','serialization_failure']){const rpc=vi.fn().mockResolvedValue({data:null,error:{code:'PT409',message}});const error=await createLogoJobService().admitLogoOperation(auth(rpc),id(2),intent).catch(e=>e);expect(error).not.toBeInstanceOf(LogoAdmissionRejectedError);expect(error).toMatchObject({code:'conflict'});}
 });
 it('read and reconcile validate request identity and never dispatch',async()=>{const rpc=vi.fn().mockResolvedValue({data:{status:'not_found'},error:null});const s=createLogoJobService(),a=auth(rpc);expect(await s.readLogoRequest(a,id(2),id(3))).toEqual({status:'not_found'});expect(await s.reconcileLogoRequest(a,id(2),id(3))).toEqual({status:'not_found'});expect(rpc.mock.calls.map(c=>c[0])).toEqual(['read_logo_request','reconcile_logo_request']);});
});


describe('leased local vector input loader',()=>{
 it('rejects a foreign source before byte access',async()=>{
  const job={id:id(7),ownerId:id(1),projectId:id(2),leaseToken:id(8),operation:'identity.logo_vectorize',input:{version:2,ownerId:id(1),projectId:id(2),requestKey:id(3),quoteId:id(4),policyIdentity:'a'.repeat(64),handlerVersion:'vector-v1',inputHash:'a'.repeat(64),operation:'identity.logo_vectorize',source:{kind:'refinement',rasterRevisionId:id(9)},settings:{preset:'bw',simplify:0,filterSpeckle:0,maxColors:2},engine:{id:'vtracer',version:'1.0.0-alpha.4',artifactHash:'a'.repeat(64)}},inputRevision:1,status:'running' as const,reservedCostMicrousd:0,actualCostMicrousd:0};
  const query=vi.fn().mockResolvedValue({rows:[{value:{reference:{ownerId:id(99),projectId:id(2),assetId:id(10),versionId:id(11),contentHash:'a'.repeat(64)},logoType:'wordmark',settings:job.input.settings}}]});
  const readLeasedAsset=vi.fn();
  await expect(loadLogoVectorInput({query},{readLeasedAsset} as unknown as import('../../src/server/data/identity-asset-store').IdentityAssetStore,job)).rejects.toMatchObject({code:'not_found'});expect(readLeasedAsset).not.toHaveBeenCalled();
 });
});


it.each([['茶屋',true],['مرحبا',true],['Studio 🦄',false]])('checks the exact saved brief before preparing a concept quote for %s',async(name,supported)=>{
 const quote=syntheticLogoQuote(), brief=structuredClone(syntheticResolvedLogoConcept().brief);
 brief.payload.name=name;
 const rpc=vi.fn(async(method:string)=>({data:method==='read_logo_workspace_record'?brief:quote,error:null}));
 const account={userId:quote.ownerId,client:{rpc}} as unknown as AuthenticatedContext;
 const promise=createLogoJobService().quoteLogoOperation(account,quote.projectId,quote.request);
 if(supported){expect(await promise).toEqual(quote);expect(rpc.mock.calls.map(call=>call[0])).toEqual(['read_logo_workspace_record','quote_logo_operation']);}
 else {await expect(promise).rejects.toMatchObject({code:'invalid_input'});expect(rpc.mock.calls.map(call=>call[0])).toEqual(['read_logo_workspace_record']);}
});
