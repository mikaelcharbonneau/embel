import { AccountLogoExportAdmissionRejectedError, type AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoDraftMemory, LogoDraftRecord } from "@/components/identity/logo-draft-memory";
import { AccountRequestError } from "@/components/workspace/account-api";
import { logoExportIntentSchema, matchesLogoExportRejection, type LogoExportIntent, type LogoDeliverablesOverview } from "@/domain/logo-deliverables";
import { logoRequestStateSchema, type LogoOperation, type LogoRequestState } from "@/domain/logo-jobs";
export type LogoExportOptions=Pick<LogoExportIntent,"pngLongEdge"|"socialSelections">;
type ExportAvailability=(operation:LogoOperation)=>boolean;
export type ExportActionContext={memory:LogoDraftMemory;client:AccountLogoClient;projectId:string;signal:AbortSignal;current():boolean;isAvailable?:ExportAvailability};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function active(c:ExportActionContext){return !c.signal.aborted&&c.current();}
/** The live UI supplies the current operation gate. The fallback keeps isolated
 * legacy helper fixtures compatible; saved workspace metadata is not live proof. */
function exportAvailable(record:LogoDraftRecord,isAvailable?:ExportAvailability){return isAvailable?isAvailable("identity.logo_export"):record.workspace?.capabilities.export.status==="available";}
export function buildLogoExportIntent(record:LogoDraftRecord,overview:LogoDeliverablesOverview,variantSetId:string,options:LogoExportOptions,requestKey:string,isAvailable?:ExportAvailability):LogoExportIntent {
 const w=record.workspace;
 if(!w||!record.base||!exportAvailable(record,isAvailable))throw new AccountRequestError(503);
 if(record.dirty||record.conflict||record.vectorDraft||record.directionDraft||record.pendingIntent||record.pendingMutation||record.pendingExport)throw new AccountRequestError(409);
 const set=overview.variantSets.find(item=>item.id===variantSetId),review=overview.variantReviews.find(item=>item.variantSetId===variantSetId&&item.approvedLogoId===set?.approvedLogoId&&item.directionApprovalId===set.directionApprovalId);
 if(!w.approvedLogo||!overview.directionApproval||overview.ownerId!==w.ownerId||overview.projectId!==w.projectId||overview.logoApproval?.id!==w.approvedLogo.id||overview.directionApproval.approvedLogoId!==w.approvedLogo.id||!set||set.approvedLogoId!==w.approvedLogo.id||set.directionApprovalId!==overview.directionApproval.id||!review||w.staleStages.some(item=>item.stage==="vector"||item.stage==="directions"))throw new AccountRequestError(409);
 const required=set.items.filter(item=>item.applicability.status==="applicable");
 if(!required.length||review.acceptedVariants.length!==required.length||required.some(item=>!review.acceptedVariants.some(accepted=>accepted.variantId===item.id&&accepted.renderHash===item.renderHash)))throw new AccountRequestError(409);
 return logoExportIntentSchema.parse({requestKey,expected:record.base,approvedLogoId:w.approvedLogo.id,directionApprovalId:overview.directionApproval.id,variantSetId,pngLongEdge:options.pngLongEdge,socialSelections:options.socialSelections});
}
function validateState(c:ExportActionContext,input:LogoExportIntent,state:LogoRequestState):void {
 const w=c.memory.get(c.projectId)?.workspace;if(!w)throw new AccountRequestError(409);
 if(!logoRequestStateSchema.safeParse(state).success)throw new AccountRequestError(502);
 if(state.status!=="not_found"&&state.rejection){if(!matchesLogoExportRejection(state.rejection,w.ownerId,c.projectId,input))throw new AccountRequestError(502);return;}
 if(state.status!=="not_found"&&(state.requestKey!==input.requestKey||!state.receipt||!("operation" in state.receipt)||state.receipt.operation!=="identity.logo_export"||state.receipt.ownerId!==w.ownerId||state.receipt.projectId!==c.projectId||state.outputs.some(output=>output.reference.ownerId!==w.ownerId||output.reference.projectId!==c.projectId)))throw new AccountRequestError(502);
}
function settle(c:ExportActionContext,input:LogoExportIntent,state:LogoRequestState):void {
 if(!active(c)||state.status==="not_found"||!["succeeded","partial","failed","cancelled"].includes(state.status))return;
 const latest=c.memory.get(c.projectId);if(latest&&same(latest.pendingExport,input))c.memory.set(c.projectId,{...latest,pendingExport:null});
}
export async function checkLogoExport(c:ExportActionContext):Promise<LogoRequestState|null> {
 if(!active(c))return null;const input=c.memory.get(c.projectId)?.pendingExport;if(!input)return null;
 // The shared reconcile endpoint uses POST. Export recovery stays on the read-only GET route.
 const state=await c.client.readLogoRequest(input.requestKey,c.signal);
 if(!state||!active(c)||!same(c.memory.get(c.projectId)?.pendingExport,input))return null;
 validateState(c,input,state);settle(c,input,state);return state;
}
function rejected(c:ExportActionContext,input:LogoExportIntent,error:unknown):LogoRequestState|null {
 if(!(error instanceof AccountLogoExportAdmissionRejectedError))throw error;
 if(!active(c)||!same(c.memory.get(c.projectId)?.pendingExport,input))return null;
 const state=logoRequestStateSchema.parse({status:"failed",requestKey:input.requestKey,receipt:null,outputs:[],billing:{status:"recorded",confirmedMicrousd:0},reason:"admission_rejected",rejection:error.rejection});
 validateState(c,input,state);settle(c,input,state);return state;
}
export async function dispatchLogoExport(c:ExportActionContext,raw:LogoExportIntent):Promise<LogoRequestState|null> {
 if(!active(c))return null;const record=c.memory.get(c.projectId);if(!record?.workspace)return null;const input=logoExportIntentSchema.parse(raw);
 if(record.pendingExport){if(!same(record.pendingExport,input))throw new AccountRequestError(409);return checkLogoExport(c);}
 if(c.isAvailable&&!c.isAvailable("identity.logo_export"))throw new AccountRequestError(503);
 if(record.dirty||record.conflict||record.vectorDraft||record.directionDraft||record.pendingIntent||record.pendingMutation||!same(record.base,input.expected))throw new AccountRequestError(409);
 c.memory.set(c.projectId,{...record,pendingExport:input});
 let receipt;try{receipt=await c.client.requestLogoExport(input,c.signal);}catch(error){return rejected(c,input,error);}
 if(!receipt||!active(c))return null;
 if(receipt.ownerId!==record.workspace.ownerId||receipt.projectId!==c.projectId||receipt.requestKey!==input.requestKey||receipt.operation!=="identity.logo_export")throw new AccountRequestError(502);
 return checkLogoExport(c);
}
/** Explicit replay can only resend the retained exact original after a read. */
export async function replayLogoExport(c:ExportActionContext):Promise<LogoRequestState|null> {
 if(!active(c))return null;const input=c.memory.get(c.projectId)?.pendingExport;if(!input)return null;
 const state=await checkLogoExport(c);if(!state||!active(c)||state.status!=="not_found")return state;
 if(!same(c.memory.get(c.projectId)?.pendingExport,input))return null;
 let receipt;try{receipt=await c.client.requestLogoExport(input,c.signal);}catch(error){return rejected(c,input,error);}if(!receipt||!active(c))return null;
 const w=c.memory.get(c.projectId)?.workspace;if(!w||receipt.ownerId!==w.ownerId||receipt.projectId!==c.projectId||receipt.operation!=="identity.logo_export"||receipt.requestKey!==input.requestKey)throw new AccountRequestError(502);
 return checkLogoExport(c);
}
