import 'server-only';
import { z } from 'zod';
import type { ClaimedJob } from '@/domain/jobs';
import { logoQuoteRequestSchema,logoCostQuoteSchema,logoGenerationIntentSchema,logoDispatchReceiptSchema,logoRequestStateSchema,logoConceptJobInputSchema,logoRefinementJobInputSchema,logoVectorizeJobInputSchema,logoResolvedConceptInputSchema,logoResolvedRefinementInputSchema,logoProviderObservationSchema,logoProviderResponseReceiptSchema,logoConceptStepOutputSchema,logoRefinementStepOutputSchema,type LogoGenerationIntent,type LogoCostQuote,type LogoDispatchReceipt,type LogoRequestState,type LogoResolvedConceptInput,type LogoResolvedRefinementInput,type LogoProviderObservation,type LogoProviderResponseReceipt,type LogoConceptStepOutput,type LogoRefinementStepOutput } from '@/domain/logo-jobs';
import { logoAssetReferenceSchema,logoTypeSchema,logoTraceSettingsSchema } from '@/domain/logo-vector';
import type { AuthenticatedContext } from '../auth/context';
import { ApiError } from '../http/errors';
import { logoDatabaseError,logoOwner,logoId,parseLogoInput,parseLogoStored } from './logo-transaction';
import type { IdentityAssetStore } from './identity-asset-store';
import type { VerifiedAssetBytes } from '@/domain/logo-deliverables';
import { isLocalLogoRuntime } from '../logo-creation/local-runtime';
import { isHostedLogoRuntime } from '../logo-creation/hosted-runtime';

/** Inject only the separately authorized restricted owner-bound logo login.
 * Every SQL entrypoint validates session_user and its stored lease again. */
export interface LogoWorkerConnection { query<Row=Record<string,unknown>>(sql:string,parameters?:unknown[]):Promise<{rows:Row[]}> }
export class LogoAdmissionUncertainError extends ApiError {
 readonly recovery:{projectId:string;input:LogoGenerationIntent};
 constructor(projectId:string,input:LogoGenerationIntent){super('integration_unavailable');this.name='LogoAdmissionUncertainError';this.recovery={projectId,input:structuredClone(input)};}
}
/** Only a committed, exact-body durable rejection certifies that every future
 * replay is fenced. A generic HTTP/SQL conflict never certifies absence. */
export class LogoAdmissionRejectedError extends ApiError {
 readonly rejection:{status:'rejected';ownerId:string;projectId:string;requestKey:string;quoteId:string};
 constructor(ownerId:string,projectId:string,input:LogoGenerationIntent,code:'conflict'|'not_found'){
  super(code);this.name='LogoAdmissionRejectedError';
  this.rejection={status:'rejected',ownerId,projectId,requestKey:input.requestKey,quoteId:input.quoteId};
 }
}
const admissionRejectionSchema=z.strictObject({kind:z.literal('logo_admission_rejected'),errorCode:z.enum(['conflict','not_found']),rejection:z.strictObject({status:z.literal('rejected'),ownerId:z.uuid(),projectId:z.uuid(),requestKey:z.uuid(),quoteId:z.uuid()})});
function scope(owner:string,project:string,value:{ownerId:string;projectId:string}){if(value.ownerId!==owner||value.projectId!==project)throw new ApiError('not_found');}
function equal(a:unknown,b:unknown):boolean {if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;if(Array.isArray(a)!==Array.isArray(b))return false;const x=a as Record<string,unknown>,y=b as Record<string,unknown>;return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(k=>Object.hasOwn(y,k)&&equal(x[k],y[k]));}
/** HTTP calls never run a provider and no missing connection gains a fallback. */
export function createLogoJobService(){
 async function rpc(auth:AuthenticatedContext,name:string,args:Record<string,unknown>){logoOwner(auth);let response:{data:unknown;error:unknown};const accountImageLane=(isLocalLogoRuntime()||isHostedLogoRuntime())&&(name==='quote_logo_operation'||name==='admit_logo_operation');try{response=await auth.client.rpc(accountImageLane?'local_logo_operation':name,accountImageLane?{...args,p_kind:name==='quote_logo_operation'?'quote':'admit'}:args);}catch(e){throw logoDatabaseError(e);}if(response.error)throw logoDatabaseError(response.error);return response.data;}
 async function quoteLogoOperation(auth:AuthenticatedContext,projectId:string,input:unknown):Promise<LogoCostQuote>{const owner=logoOwner(auth);projectId=logoId(projectId);const request=parseLogoInput(logoQuoteRequestSchema,input);const q=parseLogoStored(logoCostQuoteSchema,await rpc(auth,'quote_logo_operation',{p_project_id:projectId,p_input:request}));scope(owner,projectId,q);if(!equal(q.request,request))throw new ApiError('integration_unavailable');return q;}
 async function admitLogoOperation(auth:AuthenticatedContext,projectId:string,input:unknown):Promise<LogoDispatchReceipt>{const owner=logoOwner(auth);projectId=logoId(projectId);const body=parseLogoInput(logoGenerationIntentSchema,input);let raw:unknown;try{raw=await rpc(auth,'admit_logo_operation',{p_project_id:projectId,p_input:body});}catch(e){if(e instanceof ApiError&&e.code!=='integration_unavailable')throw e;throw new LogoAdmissionUncertainError(projectId,body);}
  const rejected=admissionRejectionSchema.safeParse(raw);
  if(rejected.success){const proof=rejected.data.rejection;if(proof.ownerId!==owner||proof.projectId!==projectId||proof.requestKey!==body.requestKey||proof.quoteId!==body.quoteId)throw new LogoAdmissionUncertainError(projectId,body);throw new LogoAdmissionRejectedError(owner,projectId,body,rejected.data.errorCode);}
  try{const receipt=parseLogoStored(logoDispatchReceiptSchema,raw);scope(owner,projectId,receipt);if(receipt.requestKey!==body.requestKey)throw new Error('Wrong request');return receipt;}catch{throw new LogoAdmissionUncertainError(projectId,body);}}
 async function request(auth:AuthenticatedContext,projectId:string,requestKey:string,reconcile:boolean):Promise<LogoRequestState>{const owner=logoOwner(auth);projectId=logoId(projectId);requestKey=logoId(requestKey);const state=parseLogoStored(logoRequestStateSchema,await rpc(auth,reconcile?'reconcile_logo_request':'read_logo_request',{p_project_id:projectId,p_request_key:requestKey}));if(state.status!=='not_found'){if(state.requestKey!==requestKey)throw new ApiError('not_found');if(state.receipt)scope(owner,projectId,state.receipt);if(state.rejection){scope(owner,projectId,state.rejection);if(state.rejection.requestKey!==requestKey||state.rejection.input.requestKey!==requestKey)throw new ApiError('not_found');}for(const output of state.outputs)scope(owner,projectId,output.reference);}return state;}
 return{quoteLogoOperation,admitLogoOperation,readLogoRequest:(a:AuthenticatedContext,p:string,k:string)=>request(a,p,k,false),reconcileLogoRequest:(a:AuthenticatedContext,p:string,k:string)=>request(a,p,k,true)};
}
export const {quoteLogoOperation,admitLogoOperation,readLogoRequest,reconcileLogoRequest}=createLogoJobService();
export async function readLeasedLogoRecord(connection:LogoWorkerConnection,job:ClaimedJob,kind:string,input:unknown=null):Promise<unknown>{logoId(job.id);logoId(job.leaseToken);const result=await connection.query<{value:unknown}>('select public.read_leased_logo_record($1,$2,$3,$4) value',[job.id,job.leaseToken,kind,JSON.stringify(input)]);if(result.rows.length!==1)throw new ApiError('integration_unavailable');return result.rows[0]!.value;}
export async function loadLogoConceptInputs(connection:LogoWorkerConnection,job:ClaimedJob):Promise<LogoResolvedConceptInput>{const input=parseLogoStored(logoConceptJobInputSchema,job.input);scope(job.ownerId,job.projectId,input);const result=parseLogoStored(logoResolvedConceptInputSchema,await readLeasedLogoRecord(connection,job,'concept_inputs'));if(!equal(result.input,input))throw new ApiError('not_found');return result;}
export async function loadLogoRefinementInputs(connection:LogoWorkerConnection,job:ClaimedJob):Promise<LogoResolvedRefinementInput>{const input=parseLogoStored(logoRefinementJobInputSchema,job.input);scope(job.ownerId,job.projectId,input);const result=parseLogoStored(logoResolvedRefinementInputSchema,await readLeasedLogoRecord(connection,job,'refinement_inputs'));if(!equal(result.input,input))throw new ApiError('not_found');return result;}
export async function recordLogoProviderResponse(connection:LogoWorkerConnection,job:ClaimedJob,observation:LogoProviderObservation):Promise<LogoProviderResponseReceipt>{const input=parseLogoInput(logoProviderObservationSchema,observation);const result=await connection.query<{value:unknown}>('select public.record_logo_provider_response($1,$2,$3) value',[job.id,job.leaseToken,JSON.stringify(input)]);const receipt=parseLogoStored(logoProviderResponseReceiptSchema,result.rows[0]?.value);scope(job.ownerId,job.projectId,receipt);const {id:_id,ownerId:_owner,projectId:_project,jobId,leaseToken,...recorded}=receipt;void _id;void _owner;void _project;if(jobId!==job.id||leaseToken!==job.leaseToken||!equal(input,recorded))throw new ApiError('not_found');return receipt;}
export async function loadLogoStepOutput(connection:LogoWorkerConnection,job:ClaimedJob,stepKey:string):Promise<LogoConceptStepOutput|LogoRefinementStepOutput|null>{parseLogoInput(z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),stepKey);return parseLogoStored(z.union([logoConceptStepOutputSchema,logoRefinementStepOutputSchema]).nullable(),await readLeasedLogoRecord(connection,job,'step_output',{stepKey}));}
export async function loadLogoStepAsset(connection:LogoWorkerConnection,store:IdentityAssetStore,job:ClaimedJob,stepKey:'generate-refinement',signal?:AbortSignal):Promise<VerifiedAssetBytes>{if(signal?.aborted)throw new ApiError('integration_unavailable');const reference=parseLogoStored(logoAssetReferenceSchema,await readLeasedLogoRecord(connection,job,'step_asset',{stepKey}));scope(job.ownerId,job.projectId,reference);const result=await store.readLeasedAsset(job,reference,signal);await readLeasedLogoRecord(connection,job,'step_asset',{stepKey});if(!equal(reference,result.reference))throw new ApiError('not_found');return result;}

export async function loadLogoVectorInput(connection:LogoWorkerConnection,store:IdentityAssetStore,job:ClaimedJob,signal?:AbortSignal):Promise<{source:VerifiedAssetBytes;logoType:import('@/domain/logo-vector').LogoType;settings:import('@/domain/logo-vector').LogoTraceSettings}>{
 if(signal?.aborted)throw new ApiError('integration_unavailable');
 const input=parseLogoStored(logoVectorizeJobInputSchema,job.input);scope(job.ownerId,job.projectId,input);
 const shape=z.strictObject({reference:logoAssetReferenceSchema,logoType:logoTypeSchema,settings:logoTraceSettingsSchema});
 const loaded=parseLogoStored(shape,await readLeasedLogoRecord(connection,job,'vector_input'));scope(job.ownerId,job.projectId,loaded.reference);
 if(!equal(loaded.settings,input.settings))throw new ApiError('not_found');
 const source=await store.readLeasedAsset(job,loaded.reference,signal);
 const current=parseLogoStored(shape,await readLeasedLogoRecord(connection,job,'vector_input'));
 if(signal?.aborted||!equal(current,loaded)||!equal(source.reference,loaded.reference))throw new ApiError('integration_unavailable');
 return{source,logoType:loaded.logoType,settings:loaded.settings};
}

export type LogoVectorProducerResult = import('@/features/logo-vector/server/converter').LogoVectorConversionResult;
export { publishLogoVectorResult,loadLeasedLogoVectorRevision } from '@/features/logo-vector/server/publication';

export async function loadDirectionInputs(connection:LogoWorkerConnection,store:IdentityAssetStore,job:ClaimedJob,signal?:AbortSignal):Promise<import('@/domain/logo-jobs').LogoResolvedDirectionInput>{
 if(!store||signal?.aborted)throw new ApiError('integration_unavailable');
 const {loadDirectionInputs:load}=await import('@/features/identity-directions/server/publication');
 return load(connection,job,store,signal);
}
/** Actual font-byte inspection is required; the caller supplies the authorized
 * store explicitly. There is no hidden globally configured storage fallback. */
export async function stageLogoDirections(connection:LogoWorkerConnection,store:IdentityAssetStore,job:ClaimedJob,result:import('@/domain/logo-directions').IdentityDirectionProductionResult,providerReceipt:LogoProviderResponseReceipt,signal?:AbortSignal):Promise<import('@/domain/logo-jobs').LogoDirectionPublicationReceipt>{
 if(!store||signal?.aborted)throw new ApiError('integration_unavailable');
 const {stageLogoDirections:stage}=await import('@/features/identity-directions/server/publication');
 return stage(connection,job,result,providerReceipt,store,signal??new AbortController().signal);
}

export { loadLogoExportInputs,createExportPublicationDependencies } from '@/features/identity-deliverables/server/persistence';
