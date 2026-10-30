import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { identityAvailabilitySchema, identityBatchRequestCloseSchema, identityBatchStateSchema, identityGenerationIntentSchema, type IdentityAvailability, type IdentityBatchRequestClose, type IdentityBatchState, type IdentityGenerationIntent } from "@/domain/identity-jobs";
import { IMAGE_MODEL } from "@/domain/providers";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { isSharedWorkerRuntime } from "../shared-account/routing";

export class IdentityAdmissionUncertainError extends ApiError {
  readonly recovery: { projectId: string; input: IdentityGenerationIntent };
  constructor(projectId: string, input: IdentityGenerationIntent) { super("integration_unavailable"); this.name="IdentityAdmissionUncertainError"; this.recovery={projectId,input:structuredClone(input)}; }
}
export class IdentityIntentClosureUncertainError extends ApiError {
  readonly recovery: { projectId: string; input: IdentityGenerationIntent };
  constructor(projectId: string, input: IdentityGenerationIntent) { super("integration_unavailable"); this.name="IdentityIntentClosureUncertainError"; this.recovery={projectId,input:structuredClone(input)}; }
}
const uuid=(value:string)=>{const parsed=z.uuid().safeParse(value);if(!parsed.success)throw new ApiError("not_found");return parsed.data.toLowerCase();};
async function ownedProject(auth:AuthenticatedContext,id:string){
  const {data,error}=await auth.client.from("projects").select("id,owner_id").eq("id",id).eq("owner_id",auth.userId).maybeSingle();
  if(error)throw new ApiError("integration_unavailable");
  if(!data||data.id!==id||data.owner_id!==auth.userId)throw new ApiError("not_found");
}
async function rpc(auth:AuthenticatedContext,name:string,args:Record<string,unknown>):Promise<unknown>{
  try{const {data,error}=await auth.client.rpc(name,args);if(error){
    const code=typeof error==="object"&&error!==null&&"code" in error?error.code:null;
    if(code==="23505"||code==="40001"||code==="PT409")throw new ApiError("conflict");
    if(code==="42501"||code==="P0002"||code==="PT404")throw new ApiError("not_found");
    if(code==="22023"||code==="PT422")throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }return data;}catch(e){if(e instanceof ApiError)throw e;throw new ApiError("integration_unavailable");}
}
function stored<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.safeParse(value);if(!parsed.success)throw new ApiError("integration_unavailable");return parsed.data;}
function scope(auth:AuthenticatedContext,projectId:string,value:{ownerId:string;projectId:string}){if(value.ownerId!==auth.userId||value.projectId!==projectId)throw new ApiError("integration_unavailable");}
export async function getIdentityAvailability(auth:AuthenticatedContext,projectId:string):Promise<IdentityAvailability>{
  projectId=uuid(projectId);await ownedProject(auth,projectId);
  if(!isSharedWorkerRuntime())return identityAvailabilitySchema.parse({ownerId:auth.userId,projectId,status:"unavailable",operation:"identity.image",requestedModel:IMAGE_MODEL,reason:"pipeline_not_implemented"});
  const value=stored(identityAvailabilitySchema,await rpc(auth,"get_shared_identity_availability",{p_project_id:projectId}));scope(auth,projectId,value);return value;
}
export async function enqueueIdentityBatch(auth:AuthenticatedContext,projectId:string,input:unknown):Promise<IdentityBatchState>{
  const parsed=identityGenerationIntentSchema.safeParse(input);if(!parsed.success)throw new ApiError("invalid_input");
  projectId=uuid(projectId);
  if(isSharedWorkerRuntime()&&"version" in parsed.data&&(parsed.data.version===2||parsed.data.version===3)){
    const existing=await readIdentityBatchRequest(auth,projectId,parsed.data.idempotencyKey);
    if(existing){if(!isDeepStrictEqual(existing.intent,parsed.data))throw new ApiError("conflict");return existing;}
  }
  const availability=await getIdentityAvailability(auth,projectId);
  if(availability.status!=="available"||availability.version!==3||!("version" in parsed.data)||parsed.data.version!==3)throw new ApiError("integration_unavailable");
  if(parsed.data.acceptedPolicyIdentity!==availability.policyIdentity||parsed.data.expectedLogoRevision!==availability.expectedLogoRevision
    ||!isDeepStrictEqual(parsed.data.sourceLogo,availability.sourceLogo.source))throw new ApiError("conflict");
  try{const value=stored(identityBatchStateSchema,await rpc(auth,"ensure_shared_identity_batch",{p_project_id:projectId,p_intent:parsed.data}));scope(auth,projectId,value);
    if(!isDeepStrictEqual(value.intent,parsed.data))throw new ApiError("integration_unavailable");return value;
  }catch(e){if(e instanceof ApiError&&e.code!=="integration_unavailable")throw e;throw new IdentityAdmissionUncertainError(projectId,parsed.data);}
}
async function read(auth:AuthenticatedContext,projectId:string,batchId:string|null,requestKey:string|null):Promise<IdentityBatchState|null>{
  projectId=uuid(projectId);if(batchId!==null)batchId=uuid(batchId);
  if(requestKey!==null&&!z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/).safeParse(requestKey).success)throw new ApiError("invalid_input");
  await ownedProject(auth,projectId);if(!isSharedWorkerRuntime())throw new ApiError("integration_unavailable");
  const value=stored(identityBatchStateSchema.nullable(),await rpc(auth,"get_shared_identity_batch",{p_project_id:projectId,p_batch_id:batchId,p_request_key:requestKey}));
  if(value){scope(auth,projectId,value);if(batchId&&value.batchId!==batchId||requestKey&&value.intent.idempotencyKey!==requestKey)throw new ApiError("integration_unavailable");}return value;
}
export const getIdentityBatch=(auth:AuthenticatedContext,p:string,id:string)=>read(auth,p,id,null);
export const readIdentityBatchRequest=(auth:AuthenticatedContext,p:string,key:string)=>read(auth,p,null,key);
export const getLatestIdentityBatch=(auth:AuthenticatedContext,p:string)=>read(auth,p,null,null);
export async function cancelIdentityBatch(auth:AuthenticatedContext,projectId:string,batchId:string):Promise<IdentityBatchState>{
  projectId=uuid(projectId);batchId=uuid(batchId);await ownedProject(auth,projectId);if(!isSharedWorkerRuntime())throw new ApiError("integration_unavailable");
  const value=stored(identityBatchStateSchema,await rpc(auth,"cancel_shared_identity_batch",{p_project_id:projectId,p_batch_id:batchId}));scope(auth,projectId,value);if(value.batchId!==batchId)throw new ApiError("integration_unavailable");return value;
}

/** A missing lookup is not rejection evidence. Only this serialized SQL mutation
 * can close the exact original intent, or request Stop for its actual admission. */
export async function closeIdentityBatchRequest(auth:AuthenticatedContext,projectId:string,input:unknown):Promise<IdentityBatchRequestClose>{
  const parsed=identityGenerationIntentSchema.safeParse(input);
  if(!parsed.success||!("version" in parsed.data)||(parsed.data.version!==2&&parsed.data.version!==3))throw new ApiError("invalid_input");
  projectId=uuid(projectId);await ownedProject(auth,projectId);
  if(!isSharedWorkerRuntime())throw new ApiError("integration_unavailable");
  try{
    const result=stored(identityBatchRequestCloseSchema,await rpc(auth,"close_shared_identity_generation_intent",{p_project_id:projectId,p_intent:parsed.data}));
    if(result.status==="not_admitted"){
      scope(auth,projectId,result);
      if(!isDeepStrictEqual(result.intent,parsed.data))throw new ApiError("integration_unavailable");
    }else{
      scope(auth,projectId,result.batch);
      if(!isDeepStrictEqual(result.batch.intent,parsed.data))throw new ApiError("integration_unavailable");
    }
    return result;
  }catch(error){
    if(error instanceof ApiError&&error.code!=="integration_unavailable")throw error;
    throw new IdentityIntentClosureUncertainError(projectId,parsed.data);
  }
}
