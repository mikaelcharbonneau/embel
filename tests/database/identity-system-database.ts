import { randomUUID,createHash } from "node:crypto";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { createIdentityInputSnapshot,identitySystemVersionSchema,initialIdentityPreferences } from "../../src/domain/project-identity";
import { asRole,HASH,OWNER_A,type TestDatabase } from "./local-supabase";
import { capture,react,seedReference } from "./identity-reference-database";

/** Administrative synthetic completed-job metadata ONLY. No upload, provider
 * execution, generated-row RPC, worker privilege or production fixture exists. */
export async function seedIdentityRoot(db:TestDatabase,projectId:string,options:{ownerId?:string;productionFiles?:boolean;createdAt?:string;rawContext?:Record<string,unknown>}={}){
 const owner=options.ownerId??OWNER_A;
 const project=(await db.query<{current_revision:number;scope:"complete_brand"|"naming_only"|"visual_identity_only"}>("select current_revision,scope from public.projects where id=$1 and owner_id=$2",[projectId,owner])).rows[0]!;
 const saved=contextSnapshotSchema.parse(options.rawContext??{description:"Explicit synthetic Identity source",selectedName:"Cedar",intake:{suppliedName:"Cedar"}});
 await asRole(db,"authenticated",owner,()=>db.query("select public.append_project_revision($1,$2,$3::jsonb,$4)",[projectId,project.current_revision,JSON.stringify(options.rawContext??saved),HASH]));
 const reference=await seedReference(db,projectId,{ownerId:owner});
 const reaction=await react(db,projectId,reference.reference,{expectedRevision:0,ensemble:true,elements:[]},owner);
 const references=await capture(db,projectId,reaction.referenceRevision,owner);
 const at=options.createdAt??new Date().toISOString();const input=createIdentityInputSnapshot({ownerId:owner,projectId,scope:project.scope,projectRevision:project.current_revision+1,context:saved,referenceSnapshot:references,preferencesRevision:0,preferences:initialIdentityPreferences(saved),capturedAt:at});
 const systemId=randomUUID(),inputId=randomUUID(),batchId=randomUUID(),jobId=randomUUID(),stepKey="identity.synthetic.1";
 async function file(mimeType:string){const assetId=randomUUID(),versionId=randomUUID(),contentHash=createHash("sha256").update(versionId).digest("hex");
  await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'Explicit synthetic Identity file','brand_asset')",[assetId,owner,projectId]);
  await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance) values($1,$2,$3,$4,1,$5,$6,$7,$8,$9,'{}')",[versionId,owner,projectId,assetId,input.projectRevision,HASH,contentHash,mimeType,`${owner}/${projectId}/${assetId}/${versionId}`]);
  return{ownerId:owner,projectId,assetId,versionId,contentHash,purpose:"brand_asset" as const,mimeType};
 }
 const board=await file("image/png");const productionFiles=options.productionFiles===false?[]:[{component:"colors",role:"Palette specification",asset:await file("application/json")}];
 const direction={direction:"Synthetic coherent direction",usageNotes:"Fixture only"};
 const system=identitySystemVersionSchema.parse({id:systemId,ownerId:owner,projectId,createdAt:at,input,source:{kind:"generated",batchId,jobId,stepKey},components:{logo:direction,colors:{swatches:[{key:"primary",name:"Forest",hex:"#123456"}],usageNotes:"Fixture palette"},typography:{styles:[{key:"body",role:"Body",family:"Synthetic Family",weight:400,style:"normal"}],usageNotes:"Specification only"},graphics:direction,imagery:direction,composition:direction},board:{asset:board,depictsSystemVersionId:systemId,staleComponents:[]},productionFiles});
 const output={identity:{version:1,operation:"identity.image",ownerId:owner,projectId,batchId,jobId,stepKey,targetCount:3,input,systems:[system]}};
 await db.query("insert into public.identity_input_snapshots(id,project_id,owner_id,project_revision,reference_revision,preferences_revision,input,created_at) values($1,$2,$3,$4,$5,null,$6::jsonb,$7)",[inputId,projectId,owner,input.projectRevision,input.referenceSnapshot.referenceRevision,JSON.stringify(input),at]);
 await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,finished_at) values($1,$2,$3,'identity.image',$4,$5,$6::jsonb,$7,'succeeded',0,$8)",[jobId,owner,projectId,input.projectRevision,HASH,JSON.stringify({identity:input}),`synthetic-identity-${jobId}`,at]);
 await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output,completed_at) values($1,$2,$3,$4,$5,'succeeded',0,$6::jsonb,$7)",[jobId,owner,projectId,stepKey,`synthetic-${systemId}`,JSON.stringify(output),at]);
 await db.query("insert into public.identity_batches(id,project_id,owner_id,job_id,input_id) values($1,$2,$3,$4,$5)",[batchId,projectId,owner,jobId,inputId]);
 await db.query("insert into public.identity_system_versions(id,project_id,owner_id,input_id,source,components,board,production_files,created_at,root_system_id,created_at_text) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::text::timestamptz,$1,$9::text)",[systemId,projectId,owner,inputId,JSON.stringify(system.source),JSON.stringify(system.components),JSON.stringify(system.board),JSON.stringify(system.productionFiles),at]);
 const files=[{component:null,role:"board",asset:system.board.asset},...system.productionFiles];
 for(const [slot,item] of files.entries())await db.query("insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id) values($1,$2,$3,$4,$5,$6,$7,$8)",[systemId,slot,projectId,owner,item.component,item.role,item.asset.assetId,item.asset.versionId]);
 await db.query("insert into public.identity_generated_roots(system_id,project_id,owner_id,batch_id,job_id,step_key,output_index,board) values($1,$2,$3,$4,$5,$6,0,$7::jsonb)",[systemId,projectId,owner,batchId,jobId,stepKey,JSON.stringify(system.board.asset)]);
 return{system,input,inputId,batchId,jobId,stepKey,output};
}
export function identityDalAuth(db:TestDatabase,owner=OWNER_A):AuthenticatedContext{return{userId:owner,client:{from(table:string){
 if(table!=="projects")throw Error("Unexpected fixture ownership read");const filters:Record<string,string>={};
 const chain={select(columns:string){if(columns!=="id,owner_id")throw Error("Unexpected ownership columns");return chain;},eq(key:string,value:string){if(!["id","owner_id"].includes(key))throw Error("Unexpected ownership filter");filters[key]=value;return chain;},async maybeSingle(){try{const result=await asRole(db,"authenticated",owner,()=>db.query("select id,owner_id from public.projects where id=$1 and owner_id=$2",[filters.id,filters.owner_id]));return{data:result.rows[0]??null,error:null};}catch(error){return{data:null,error:{code:(error as {code:string}).code}};}}};return chain;
 },rpc:async(name:string,args:Record<string,unknown>)=>{
 try{if(!["get_project_identity","list_identity_systems","get_identity_system","set_identity_preferences","select_identity_system","refine_identity_component"].includes(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error("Unexpected fixture RPC");
 const result=await asRole(db,"authenticated",owner,()=>db.query<{result:unknown}>(`select public.${name}(${Object.keys(args).map((key,index)=>`${key}=>$${index+1}`).join(",")}) result`,Object.values(args).map(value=>value && typeof value==="object"?JSON.stringify(value):value)));return{data:result.rows[0]!.result,error:null};
 }catch(error){return{data:null,error:{code:(error as {code:string}).code}};}
}}} as unknown as AuthenticatedContext;}
