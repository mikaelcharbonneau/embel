import {randomUUID,createHash} from 'node:crypto';
import {applySharedImageModel} from './shared-image-model-fixture';
import {createSharedLogoFixture} from './shared-account-logo-fixture';
import {applyPacket,OWNER_A,OWNER_B} from './local-supabase';
import {capability} from '../fixtures/identity-generation';
import {syntheticPng} from '../features/logo-vector/raster-fixtures';
import {logoWorkspaceV2Schema} from '../../src/domain/logo-workspace';
import {identityReferenceEntrySchema} from '../../src/domain/identity-references';
import type {IdentityAssetReservation} from '../../src/server/data/identity-asset-store';
import { reviewedStrategy } from "../fixtures/reviewed-strategy";
export {OWNER_A,OWNER_B,capability};
export const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
/** Real SQL/RLS, synthetic Auth sessions and local PNG bytes. The Creative direction
 * packets are installed before the retirement migration, as in production. No network,
 * credentials or paid provider calls. */
export async function createSharedIdentityFixture(){
 const f=await createSharedLogoFixture({beforeRetirement:async db=>{
  for(const name of ['shared_logo_advanced.sql','shared_identity_generation.sql','shared_identity_selected_logo_boards.sql','shared_identity_http_writer_permissions.sql','shared_logo_types_keep_concepts_after_boards.sql'])
   await applyPacket(db,'candidates/'+name);
  await applySharedImageModel(db);
 }});
 try{
  async function rpc<T=unknown>(owner:string,name:string,args:unknown[]){if(!/^[a-z_]+$/.test(name))throw Error('Invalid fixture RPC');return f.asAuth(owner,async()=>(await f.db.query<{value:T}>(`select to_jsonb(public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')})) value`,args.map(x=>x&&typeof x==='object'?JSON.stringify(x):x))).rows[0]!.value);}
  /** A reference image uploaded through the Logo web lane and registered for Identity. */
  async function upload(project:string,owner=OWNER_A,index=1,suppliedBytes?:Uint8Array){
   const workspace=logoWorkspaceV2Schema.parse(await rpc(owner,'get_logo_workspace',[project]));
   const key=randomUUID(),bytes=suppliedBytes??syntheticPng(8,8,(x,y)=>[x*20,y*20,110+index,255]);
   const rights='Synthetic local fixture; user supplied with no license verification';
   const request={kind:'reference_upload',input:{requestKey:key,expected:workspace.heads,aspects:['overall_feel'],rightsDeclaration:rights},file:{contentHash:hash(bytes),mimeType:'image/png',byteLength:bytes.byteLength}};
   await rpc(owner,'prepare_shared_identity_reference_upload',[project,request]);
   await f.executeLogo(owner,'input_prepare',project,request);
   const reservation=await f.executeLogo(owner,'asset_prepare',project,{kind:'upload',intent:{requestKey:key,usage:'logo_reference',mimeType:'image/png',contentHash:hash(bytes),rightsDeclaration:rights},byteLength:bytes.byteLength}) as IdentityAssetReservation;
   const verification={status:'verified',checkedAt:new Date().toISOString(),contentHash:hash(bytes),mimeType:'image/png',byteLength:bytes.byteLength};
   const receipt=await f.executeLogo(owner,'asset_readback',project,reservation.id,verification);
   await f.executeLogo(owner,'input_commit',project,request,{receipt,evidence:null});
   const metadata={attribution:{label:'Synthetic owned reference',creator:null,sourceUrl:null,rightsNote:rights},relevantElements:['colors'],tags:[]};
   const entry=identityReferenceEntrySchema.parse(await rpc(owner,'register_shared_identity_reference',[project,key,metadata]));
   return {key,metadata,entry,reservation,bytes,request,receipt};
  }
  async function project(owner=OWNER_A,select=true){
   const created=await rpc<{id:string}>(owner,'create_project',['complete_brand','Synthetic Identity',reviewedStrategy({description:'Clearly synthetic Identity SQL brief',selectedName:'Fixture',intake:{suppliedName:'Fixture'}}),'a'.repeat(64)]),p=created.id,source=await upload(p,owner);
   if(select)await rpc(owner,'set_identity_reference_reaction',[p,source.entry.reference.id,{expectedRevision:0,ensemble:true,elements:[]}]);
   return {projectId:p,source,owner};
  }
  return{...f,capability,rpc,project,upload};
 }catch(error){await f.db.close();throw error;}
}
export type SharedIdentityFixture=Awaited<ReturnType<typeof createSharedIdentityFixture>>;
