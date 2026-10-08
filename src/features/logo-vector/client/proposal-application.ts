import { z } from 'zod';
import type { VerifiedAccount } from '@/components/workspace/account-session';
import { AccountRequestError } from '@/components/workspace/account-api';
import { logoMutationReceiptSchema, logoWorkspaceV2Schema, type LogoMutationReceipt, type LogoWorkspaceV2 } from '@/domain/logo-workspace';
import { logoUuidSchema, freezeLogoRecord } from '@/domain/logo-vector';
import { applyLogoVectorProposalCommandSchema, logoVectorProposalApplicationSchema, type ApplyLogoVectorProposalInput, type ApplyLogoVectorProposalCommand } from '../model/proposal-materialization';
import { logoVectorEditRequestStateSchema, sameLogoVectorEditCommand, type LogoVectorEditRequestState } from '../model/cancellation';

export type LogoVectorProposalApplicationResult = {status:'succeeded';receipt:LogoMutationReceipt;workspace:LogoWorkspaceV2}|{status:'cancelled'};
/** Independent per-account apply intent. No UI state, provider path, background
 * retry, selection or approval. The caller can retain getPending() for its own recovery. */
export function createLogoVectorProposalApplicationClient(account:VerifiedAccount,projectId:string,isCurrent:(account:VerifiedAccount)=>boolean,expire:(account:VerifiedAccount)=>void,fetcher:typeof fetch=fetch) {
 const captured=Object.freeze({...account}),owner=logoUuidSchema.parse(account.userId),project=logoUuidSchema.parse(projectId),base=`/api/projects/${project}/logo`;
 let pending:Readonly<ApplyLogoVectorProposalCommand>|null=null,closed=false;
 const controllers=new Set<AbortController>(),current=()=>!closed&&isCurrent(captured);
 async function request<T>(path:string,schema:z.ZodType<T>,method:'GET'|'POST',body?:unknown,external?:AbortSignal):Promise<T|null>{
  if(!current()||external?.aborted)return null;
  const controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);external?.addEventListener('abort',abort,{once:true});
  try{
   if(external?.aborted){controller.abort();return null;}
   const response=await fetcher(path,{method,credentials:'same-origin',mode:'same-origin',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(!current()||controller.signal.aborted)return null;
   if(!response.ok){if(response.status===401)expire(captured);throw new AccountRequestError(response.status);}
   if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new AccountRequestError(502);
   const advertised=response.headers.get('content-length');if(advertised!==null&&(!/^\d+$/.test(advertised)||Number(advertised)>2_097_152))throw new AccountRequestError(502);
   const reader=response.body?.getReader();if(!reader)throw new AccountRequestError(502);
   const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const next=await reader.read();if(!current()||controller.signal.aborted)return null;if(next.done)break;length+=next.value.byteLength;if(length>2_097_152)throw new AccountRequestError(502);chunks.push(next.value);}}
   finally{void reader.cancel().catch(()=>undefined);reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AccountRequestError(502);}
   const parsed=schema.safeParse(raw);if(!parsed.success)throw new AccountRequestError(502);
   return current()&&!controller.signal.aborted?parsed.data:null;
  }catch(error){if(!current()||controller.signal.aborted)return null;throw error;}
  finally{controllers.delete(controller);external?.removeEventListener('abort',abort);}
 }
 const exact=(command:ApplyLogoVectorProposalCommand)=>current()&&sameLogoVectorEditCommand(pending,command);
 async function finish(command:ApplyLogoVectorProposalCommand,receipt:LogoMutationReceipt,signal?:AbortSignal):Promise<LogoVectorProposalApplicationResult|null>{
  if(!exact(command))return null;
  const state=logoVectorEditRequestStateSchema.safeParse({status:'succeeded',ownerId:owner,projectId:project,requestKey:command.body.requestKey,command,receipt});
  if(!state.success||receipt.revision.stage!=='refinements'||receipt.revision.payload.approvalId!==null)throw new AccountRequestError(502);
  // Replay may be historical. Return current authoritative heads separately.
  const workspace=await request(`${base}`,logoWorkspaceV2Schema,'GET',undefined,signal);
  if(!workspace||!exact(command))return null;
  if(workspace.ownerId!==owner||workspace.projectId!==project||workspace.heads.workspaceRevision<receipt.workspace.heads.workspaceRevision)throw new AccountRequestError(502);
  pending=null;return{status:'succeeded',receipt,workspace};
 }
 async function settle(command:ApplyLogoVectorProposalCommand,state:LogoVectorEditRequestState,signal?:AbortSignal):Promise<LogoVectorProposalApplicationResult|null>{
  if(!exact(command)||state.status==='not_found')return null;
  if(state.ownerId!==owner||state.projectId!==project||!sameLogoVectorEditCommand(state.command,command))throw new AccountRequestError(502);
  if(state.status==='succeeded')return finish(command,state.receipt,signal);
  pending=null;return{status:'cancelled'};
 }
 async function send(command:ApplyLogoVectorProposalCommand,signal?:AbortSignal){
  const receipt=await request(`${base}/vector-proposals/${command.body.proposalId}/apply`,logoMutationReceiptSchema,'POST',command.body,signal);
  return receipt?finish(command,receipt,signal):null;
 }
 async function recover(retry=false,signal?:AbortSignal):Promise<LogoVectorProposalApplicationResult|null>{
  if(!pending||!current())return null;const command=pending;
  const state=await request(`${base}/edits/requests/${command.body.requestKey}`,logoVectorEditRequestStateSchema,'GET',undefined,signal);
  if(!state||!exact(command))return null;
  if(state.status==='not_found')return retry?send(command,signal):null;
  return settle(command,state,signal);
 }
 return{
  getPending:()=>current()&&pending?structuredClone(pending):null,
  /** Restore only the unchanged original body for this captured account/project. No I/O. */
  retain(input:ApplyLogoVectorProposalInput){if(!current())return;const command=applyLogoVectorProposalCommandSchema.parse({method:'applyLogoVectorProposal',body:input});if(pending&&!sameLogoVectorEditCommand(pending,command))throw new AccountRequestError(409);pending=freezeLogoRecord(command);},
  async submit(input:ApplyLogoVectorProposalInput,signal?:AbortSignal){
   if(!current()||signal?.aborted)return null;const parsed=applyLogoVectorProposalCommandSchema.safeParse({method:'applyLogoVectorProposal',body:input});if(!parsed.success)throw new AccountRequestError(422);const command=parsed.data;
   if(pending){if(!sameLogoVectorEditCommand(pending,command))throw new AccountRequestError(409);return recover(false,signal);}
   pending=freezeLogoRecord(command);return send(command,signal);
  },
  recover,
  async cancel(signal?:AbortSignal){
   if(!pending||!current())return null;const command=pending,state=await request(`${base}/edits/requests/${command.body.requestKey}/cancel`,logoVectorEditRequestStateSchema,'POST',command,signal);
   if(!state)return null;if(state.status==='not_found')throw new AccountRequestError(502);return settle(command,state,signal);
  },
  async readApplication(proposalId:string,signal?:AbortSignal){
   const id=logoUuidSchema.parse(proposalId),value=await request(`${base}/vector-proposals/${id}/apply`,logoVectorProposalApplicationSchema,'GET',undefined,signal);
   if(value&&(value.proposal.ownerId!==owner||value.proposal.projectId!==project||value.proposal.id!==id))throw new AccountRequestError(502);return value;
  },
  dispose(){closed=true;pending=null;for(const controller of controllers)controller.abort();controllers.clear();},
 };
}
