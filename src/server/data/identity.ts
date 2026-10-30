import "server-only";
import { z } from "zod";
import {
 selectIdentitySystemSchema,refineIdentityComponentSchema,
 updateIdentityPreferencesSchema,updateIdentityPreferencesResponseSchema,identityProjectSchema,identitySessionSchema,identityPreferenceRevisionSchema,
 identitySystemVersionSchema,identitySelectionSchema,identityComponentChangeSchema,validateIdentityRefinement,identitySystemCursorSchema,listIdentitySystemsSchema,projectIdentityOverviewSchema,identitySystemPageSchema,identitySystemDetailSchema,
 initialIdentityPreferences,getIdentityCurrentBasis,getIdentityReadiness,getIdentityFreshness,summarizeIdentitySystem,
} from "@/domain/project-identity";
import { logoBriefRevisionSchema } from "@/domain/logo-workspace";
import { identityLogoSourceSchema } from "@/domain/identity-logo-source";
import { isSharedWorkerRuntime } from "../shared-account/routing";
import { identityGeneratedSystemBindingSchema } from "@/domain/identity-jobs";
import { identityReferenceSnapshotSchema } from "@/domain/identity-references";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { productionIdentityTransactions,productionIdentitySaveAvailability } from "./identity-transaction";
import { resolveDevelopmentIdentityRuntime } from "../development/identity";
import { acquireAccountIdentityRuntime } from "../runtime/account-http-binding-source";

function input<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new ApiError("invalid_input");return result.data;}
function stored<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new ApiError("integration_unavailable");return result.data;}
function projectId(value:string):string {if(!z.uuid().safeParse(value).success)throw new ApiError("not_found");return value.toLowerCase();}
function databaseError(error:{code?:unknown}|null):void {
 if(!error)return;
 if(["P0002","PGRST116"].includes(String(error.code)))throw new ApiError("not_found");
 if(["PT409","23505","40001"].includes(String(error.code)))throw new ApiError("conflict");
 if(["22023","23514","23502","22P02","22007","22008","22003"].includes(String(error.code)))throw new ApiError("invalid_input");
 throw new ApiError("integration_unavailable");
}
function invariant(value:boolean):asserts value {if(!value)throw new ApiError("integration_unavailable");}
export async function setIdentityPreferences(auth:AuthenticatedContext,id:string,value:unknown) {
 id=projectId(id);const request=input(updateIdentityPreferencesSchema,value);
 const result=await auth.client.rpc("set_identity_preferences",{p_project_id:id,p_input:request});databaseError(result.error);
 const response=stored(updateIdentityPreferencesResponseSchema,result.data);
 if(response.session.ownerId!==auth.userId || response.session.projectId!==id)throw new ApiError("not_found");
 invariant(response.preferences.revision===request.expectedPreferencesRevision+1 && JSON.stringify(response.preferences.preferences)===JSON.stringify(request.preferences));
 return response;
}

const proofsSchema=z.strictObject({records:z.array(z.strictObject({system:identitySystemVersionSchema,rootSystemId:z.uuid(),base:z.uuid().nullable(),change:identityComponentChangeSchema.nullable(),selection:identitySelectionSchema.nullable()})),roots:z.array(identityGeneratedSystemBindingSchema)});
function verifyProofs(proofs:z.infer<typeof proofsSchema>,systems:Array<z.infer<typeof identitySystemVersionSchema>>,owner:string,id:string){
 const records=new Map(proofs.records.map(row=>[row.system.id,row]));const roots=new Map(proofs.roots.map(row=>[row.system.id,row]));
 invariant(records.size===proofs.records.length && roots.size===proofs.roots.length);
 const verified=new Set<string>(),visiting=new Set<string>();
 const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 function verify(key:string):void {
  if(verified.has(key))return;invariant(!visiting.has(key));visiting.add(key);
  const row=records.get(key);invariant(Boolean(row));if(!row)return;
  invariant(row.system.ownerId===owner && row.system.projectId===id);
  if(row.system.source.kind==="generated") {const root=roots.get(key);invariant(Boolean(root) && row.rootSystemId===key && row.base===null && row.change===null && row.selection===null && same(root!.system,row.system));}
  else {invariant(row.base===row.system.source.baseSystemVersionId && row.base!==null);verify(row.base!);verify(row.rootSystemId);const base=records.get(row.base!)!;invariant(base.rootSystemId===row.rootSystemId);try{validateIdentityRefinement({base:base.system,system:row.system,change:row.change,selection:row.selection});}catch{throw new ApiError("integration_unavailable");}}
  visiting.delete(key);verified.add(key);
 }
 for(const system of systems){verify(system.id);invariant(same(records.get(system.id)!.system,system));}
}
const stateFields={logoBrief:logoBriefRevisionSchema.optional(),project:identityProjectSchema,session:identitySessionSchema.nullable(),preferences:identityPreferenceRevisionSchema.nullable(),referenceSnapshot:identityReferenceSnapshotSchema};
const historyTransportSchema=z.strictObject({...stateFields,proofs:proofsSchema,history:z.strictObject({query:listIdentitySystemsSchema,records:z.array(identitySystemVersionSchema).max(50),nextCursor:identitySystemCursorSchema.nullable()}),selection:z.strictObject({selection:identitySelectionSchema,system:identitySystemVersionSchema}).nullable()});
const detailTransportSchema=z.strictObject({...stateFields,proofs:proofsSchema,system:identitySystemVersionSchema});
type CurrentState=z.infer<z.ZodObject<typeof stateFields>>;
function checkState(auth:AuthenticatedContext,id:string,state:CurrentState){
 if(state.project.id!==id || state.project.owner_id!==auth.userId)throw new ApiError("not_found");
 const owned=(row:{ownerId:string;projectId:string})=>row.ownerId===auth.userId && row.projectId===id;
 invariant(owned(state.referenceSnapshot) && (!state.session || owned(state.session)) && (!state.preferences || owned(state.preferences)) &&
  (state.session ? state.session.currentPreferencesRevision===(state.preferences?.revision??0) : state.preferences===null));
 const preferences=state.preferences?.preferences??initialIdentityPreferences(state.project.context);
 return getIdentityCurrentBasis({ownerId:auth.userId,projectId:id,context:state.project.context,references:state.referenceSnapshot,preferences,...(state.logoBrief?{logoBrief:state.logoBrief}:{})});
}
function historyQuery(value:unknown,id?:string){
 let normalized=value;
 if(value && typeof value==="object" && !Array.isArray(value) && "cursor" in value && value.cursor && typeof value.cursor==="object" && !Array.isArray(value.cursor)){
  const cursor={...value.cursor} as Record<string,unknown>;
  for(const key of ["projectId","id"])if(typeof cursor[key]==="string" && z.uuid().safeParse(cursor[key]).success)cursor[key]=(cursor[key] as string).toLowerCase();
  normalized={...value,cursor};
 }
 const query=input(listIdentitySystemsSchema,normalized);
 if(id && query.cursor && query.cursor.projectId!==id)throw new ApiError("invalid_input");
 return query;
}
async function readHistory(auth:AuthenticatedContext,id:string,value:unknown,rpcName:"get_project_identity"|"list_identity_systems"){
 const query=historyQuery(value,id);const result=await auth.client.rpc(rpcName,{p_project_id:id,p_query:query});databaseError(result.error);
 const response=stored(historyTransportSchema,result.data);const currentBasis=checkState(auth,id,response);
 verifyProofs(response.proofs,[...response.history.records,...(response.selection?[response.selection.system]:[])],auth.userId,id);
 invariant(JSON.stringify(response.history.query)===JSON.stringify(query));
 const systems=stored(identitySystemPageSchema,{ownerId:auth.userId,projectId:id,query,items:response.history.records.map(system=>summarizeIdentitySystem(system,currentBasis)),nextCursor:response.history.nextCursor});
 return {response,currentBasis,systems};
}
const sourceStateSchema = z.strictObject({ sourceLogo: identityLogoSourceSchema, sourceLogoCurrent: z.boolean() });
async function logoSourceState(auth: AuthenticatedContext, id: string, systemId: string) {
 if (!isSharedWorkerRuntime()) return {};
 const result = await auth.client.rpc("get_identity_logo_source", { p_project_id: id, p_system_version_id: systemId });
 databaseError(result.error);
 const source = stored(sourceStateSchema.nullable(), result.data);
 if (source) invariant(source.sourceLogo.brief.ownerId === auth.userId && source.sourceLogo.brief.projectId === id);
 return source ?? {};
}
export async function getProjectIdentity(auth:AuthenticatedContext,id:string,value:unknown={}){
 id=projectId(id);const {response,currentBasis,systems}=await readHistory(auth,id,value,"get_project_identity");
 const lease=await acquireAccountIdentityRuntime(auth);
 try {
 const runtime=lease.value??(!lease.configured?await resolveDevelopmentIdentityRuntime(auth.userId):null);
 return stored(projectIdentityOverviewSchema,{ownerId:auth.userId,projectId:id,project:response.project,session:response.session,preferences:response.preferences,
  ...(response.logoBrief?{logoBrief:response.logoBrief}:{}),referenceSnapshot:response.referenceSnapshot,currentBasis,readiness:getIdentityReadiness(response.project.context,response.project.scope,response.referenceSnapshot),systems,
  saveAvailability:runtime?.saveAvailability??productionIdentitySaveAvailability,
  currentSelection:response.selection?{...response.selection,...await logoSourceState(auth,id,response.selection.system.id),freshness:getIdentityFreshness(response.selection.system.input.basis,currentBasis)}:null});
 } finally {await lease.release();}
}
export async function listIdentitySystems(auth:AuthenticatedContext,id:string,value:unknown={}){
 id=projectId(id);const {systems}=await readHistory(auth,id,value,"list_identity_systems");return systems;
}
export async function getIdentitySystem(auth:AuthenticatedContext,id:string,systemId:string){
 id=projectId(id);systemId=projectId(systemId);const result=await auth.client.rpc("get_identity_system",{p_project_id:id,p_system_version_id:systemId});databaseError(result.error);
 const response=stored(detailTransportSchema,result.data);const currentBasis=checkState(auth,id,response);
 verifyProofs(response.proofs,[response.system],auth.userId,id);
 if(response.system.id!==systemId)throw new ApiError("not_found");
 return stored(identitySystemDetailSchema,{ownerId:auth.userId,projectId:id,system:response.system,currentBasis,...await logoSourceState(auth,id,systemId),freshness:getIdentityFreshness(response.system.input.basis,currentBasis)});
}
export function readIdentityQuery(request:Request){
 const params=new URL(request.url).searchParams;const value:Record<string,unknown>={};
 if(new URL(request.url).search.length>4096)throw new ApiError("invalid_input");
 for(const key of params.keys())if(!["limit","cursor"].includes(key) || params.getAll(key).length!==1)throw new ApiError("invalid_input");
 const limit=params.get("limit");if(limit!==null){if(!/^[0-9]+$/.test(limit))throw new ApiError("invalid_input");value.limit=Number(limit);}
 const cursor=params.get("cursor");if(cursor!==null){if(cursor.length>2048)throw new ApiError("invalid_input");try{value.cursor=JSON.parse(cursor);}catch{throw new ApiError("invalid_input");}}
 return historyQuery(value);
}

function canonicalBody(value:unknown,key:string):unknown {
 if(value && typeof value==="object" && !Array.isArray(value)){const result={...value} as Record<string,unknown>;if(typeof result[key]==="string" && z.uuid().safeParse(result[key]).success)result[key]=(result[key] as string).toLowerCase();return result;}return value;
}
/** Read-only ownership fence for unavailable production capability. It never
 * substitutes for the independent login binding and locked transaction checks. */
async function checkMutationProject(auth:AuthenticatedContext,id:string){
 const result=await auth.client.from("projects").select("id,owner_id").eq("id",id).eq("owner_id",auth.userId).maybeSingle();databaseError(result.error);
 if(!result.data || result.data.id!==id || result.data.owner_id!==auth.userId)throw new ApiError("not_found");
}
export async function selectIdentitySystem(auth:AuthenticatedContext,id:string,value:unknown,signal?:AbortSignal){
 id=projectId(id);const request=input(selectIdentitySystemSchema,canonicalBody(value,"systemVersionId"));
 await checkMutationProject(auth,id);const lease=await acquireAccountIdentityRuntime(auth,signal);
 try {
 const runtime=lease.value??(!lease.configured?await resolveDevelopmentIdentityRuntime(auth.userId,signal):null);
 return await (runtime?.transactions??productionIdentityTransactions).select(auth,id,request,signal);
 } finally {await lease.release();}
}
export async function refineIdentityComponent(auth:AuthenticatedContext,id:string,value:unknown,signal?:AbortSignal){
 id=projectId(id);const request=input(refineIdentityComponentSchema,canonicalBody(value,"baseSystemVersionId"));
 await checkMutationProject(auth,id);const lease=await acquireAccountIdentityRuntime(auth,signal);
 try {
 const runtime=lease.value??(!lease.configured?await resolveDevelopmentIdentityRuntime(auth.userId,signal):null);
 return await (runtime?.transactions??productionIdentityTransactions).refine(auth,id,request,signal);
 } finally {await lease.release();}
}
