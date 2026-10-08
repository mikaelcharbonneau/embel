"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { useLogoCapabilities } from "@/components/identity/use-logo-capabilities";
import { useAccountSession } from "@/components/workspace/account-session";
import { AccountRequestError, accountErrorMessage } from "@/components/workspace/account-api";
import { logoVariantSetSchema, type LogoDeliverablesOverview, type IdentityAssetReceipt, type LogoVariantSet } from "@/domain/logo-deliverables";
import { logoMutationReceiptSchema, type LogoManualCommand, type LogoMutationReceipt, type LogoWorkspaceV2 } from "@/domain/logo-workspace";
import type { LogoRequestState } from "@/domain/logo-jobs";
import { buildLogoExportIntent, checkLogoExport, dispatchLogoExport, replayLogoExport, type ExportActionContext, type LogoExportOptions } from "./export-actions";
export interface LogoExportsController {
 workspace:LogoWorkspaceV2|null;overview:LogoDeliverablesOverview|null;variantSetId:string|null;selectedOptions:LogoExportOptions;pendingRequestKey:string|null;requestState:LogoRequestState|null;
 loading:boolean;error:string|null;canRead:boolean;canPrepare:boolean;canExport:boolean;blockedReason:string|null;downloadMessage:string|null;
 refresh():Promise<void>;prepareVariants():Promise<void>;reviewVariants(ids:readonly string[]):Promise<void>;request():Promise<void>;retryOriginalExport():Promise<void>;reconcile():Promise<void>;download(file:IdentityAssetReceipt):Promise<void>;selectOptions(options:LogoExportOptions):void;checkRequest(key:string):Promise<void>;loadMore():Promise<void>;
}
type State={key:string;client:AccountLogoClient;overview:LogoDeliverablesOverview|null;variantSetId:string|null;loading:boolean;error:string|null;requestState:LogoRequestState|null;downloadMessage:string|null};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const defaultOptions:LogoExportOptions={pngLongEdge:2048,socialSelections:[]};
export function useLogoExports(client:AccountLogoClient,workspace:LogoWorkspaceV2):LogoExportsController {
 const memory=useLogoDraftMemory(),baseline=useLogoWorkspace({projectId:workspace.projectId,memory,client});
 const {session,isCurrent}=useAccountSession(),account=session.status==="ready"?session:null;
 const active=account&&isCurrent(account)&&baseline.client===client&&isAccountLogoClientCurrent(client,account,workspace.projectId)&&baseline.workspace?.ownerId===account.userId&&baseline.workspace.ownerId===workspace.ownerId&&baseline.workspace.projectId===workspace.projectId?baseline.workspace:null;
 const projectId=active?.projectId??null,revision=active?.heads.workspaceRevision??null;
 const readiness=useLogoCapabilities(active?client:null,projectId);
 const exportAvailable=readiness.isAvailable("identity.logo_export"),exportUnavailableReason=readiness.status==="loading"?"Checking export availability.":"Export is unavailable. Refresh availability before creating new brand files.";
 const scopeKey=account&&projectId?`${account.userId}:${account.generation}:${projectId}`:"",key=scopeKey&&revision!==null?`${scopeKey}:${revision}`:"";
 const [state,setState]=useState<State|null>(null),[options,setOptions]=useState<{scope:string;client:AccountLogoClient;value:LogoExportOptions}|null>(null),[mutating,setMutating]=useState<{scope:string;client:AccountLogoClient}|null>(null);
 const reloadBaseline=useRef(baseline.reload);
 useLayoutEffect(()=>{reloadBaseline.current=baseline.reload;},[baseline.reload]);
 const lastState=useRef<State|null>(null);
 useLayoutEffect(()=>{lastState.current=state;},[state]);
 const readSequence=useRef(0);
 const scope=useRef<{key:string;client:AccountLogoClient}|null>(null),reading=useRef<AbortController|null>(null),writing=useRef<AbortController|null>(null);
 useLayoutEffect(()=>{const captured={key:scopeKey,client};scope.current=captured;return()=>{if(scope.current===captured)scope.current=null;reading.current?.abort();reading.current=null;writing.current?.abort();writing.current=null;};},[scopeKey,client]);
 const current=useCallback(()=>!!(account&&projectId&&scope.current?.key===scopeKey&&scope.current.client===client&&isCurrent(account)&&isAccountLogoClientCurrent(client,account,projectId)),[account,client,isCurrent,projectId,scopeKey]);
 const visible=active&&state?.key===key&&state.client===client?state:null;
 const selectedOptions=options?.scope===scopeKey&&options.client===client?options.value:defaultOptions;
 const read=useCallback(async(append=false)=>{
  if(!projectId||revision===null||!current()||writing.current)return;
  reading.current?.abort();const controller=new AbortController(),sequence=++readSequence.current;reading.current=controller;
  const valid=()=>readSequence.current===sequence&&!controller.signal.aborted&&current()&&memory.get(projectId)?.workspace?.heads.workspaceRevision===revision;
  const candidate=lastState.current,previous=candidate?.key===key&&candidate.client===client?candidate:null;
  setState(previous?{...previous,loading:true,error:null}:{key,client,overview:null,variantSetId:null,loading:true,error:null,requestState:null,downloadMessage:null});
  try {
   const prior=append?previous?.overview:null;
   const result=await client.getLogoDeliverables({limit:50,...(prior?.nextCursor?{cursor:prior.nextCursor}:{}),...(prior?.nextRequestCursor?{requestCursor:prior.nextRequestCursor}:{})},controller.signal);
   if(!result||!valid())return;
   const stageId=memory.get(projectId)?.workspace?.stages.deliverables?.id;
   const stage=stageId?await client.getLogoStageRevision("deliverables",stageId,controller.signal):null;
   if(!valid()||stageId&&!stage)return;
   const variantSetId=stage?.stage==="deliverables"?stage.payload.variantSetId:null;
   let requestState:LogoRequestState|null=null;
   if(memory.get(projectId)?.pendingExport){
    requestState=await checkLogoExport({memory,client,projectId,signal:controller.signal,current:valid});
    if(!valid())return;
    if(!memory.get(projectId)?.pendingExport)await reloadBaseline.current(false);
    if(!valid())return;
   }
   setState(value=>{if(!valid())return value;const old=append&&value?.key===key&&value.client===client?value.overview:null;return {key,client,overview:old?{...result,exports:[...old.exports,...result.exports.filter(item=>!old.exports.some(existing=>existing.manifest.id===item.manifest.id))],exportRequests:[...old.exportRequests,...result.exportRequests.filter(item=>!old.exportRequests.some(existing=>existing.requestKey===item.requestKey))]}:result,variantSetId,loading:false,error:null,requestState:requestState??(value?.key===key?value.requestState:null),downloadMessage:value?.key===key?value.downloadMessage:null};});
  }catch(error){if(valid())setState(value=>({key,client,overview:value?.key===key?value.overview:null,variantSetId:value?.key===key?value.variantSetId:null,loading:false,error:accountErrorMessage(error),requestState:null,downloadMessage:null}));}
  finally {if(reading.current===controller){reading.current=null;if(current())setState(value=>value?.key===key?{...value,loading:false}:value);}}
 },[client,current,key,memory,projectId,revision]);
 useEffect(()=>{if(!projectId)return;const timer=setTimeout(()=>{void read();},0);return()=>{clearTimeout(timer);reading.current?.abort();reading.current=null;};},[projectId,read]);
 const pendingExport=baseline.draft?.pendingExport,pendingManual=baseline.draft?.pendingMutation;
 const hasActive=!!pendingExport||!!visible?.overview?.exportRequests.some(item=>item.state.status==="admitted"||item.state.status==="running");
 useEffect(()=>{
  if(!hasActive||!current()||mutating)return;
  let cancelled=false,timer:ReturnType<typeof setTimeout>;
  const tick=async()=>{await read();if(!cancelled)timer=setTimeout(()=>{void tick();},2500);};
  timer=setTimeout(()=>{void tick();},2500);return()=>{cancelled=true;clearTimeout(timer);};
 },[hasActive,read,current,mutating]);
 const ownPendingManual=pendingManual&&["prepareLogoVariants","reviewLogoVariants"].includes(pendingManual.command.method)?pendingManual:null;
 async function operation(run:(context:ExportActionContext)=>Promise<void>){
  if(!projectId||!current()||writing.current)return;
  reading.current?.abort();reading.current=null;const controller=new AbortController();writing.current=controller;setMutating({scope:scopeKey,client});
  setState(value=>value?.key===key&&value.client===client?{...value,loading:false,error:null}:value);
  const c:ExportActionContext={memory,client,projectId,signal:controller.signal,current:()=>writing.current===controller&&current(),isAvailable:readiness.isAvailable};
  try {await run(c);}catch(error){if(c.current())setState(value=>value?.key===key&&value.client===client?{...value,loading:false,error:accountErrorMessage(error)}:value);}
  finally{if(writing.current===controller){writing.current=null;if(current())setMutating(null);}}
 }
 async function exportOperation(kind:"request"|"retry"|"check"){
  await operation(async c=>{
   const record=memory.get(c.projectId);if(!record||!visible?.overview)return;
   if(kind==="request"&&!readiness.isAvailable("identity.logo_export")){setState(value=>value?.key===key&&value.client===client?{...value,error:exportUnavailableReason}:value);return;}
   const result=kind==="request"?await dispatchLogoExport(c,buildLogoExportIntent(record,visible.overview,visible.variantSetId??"",selectedOptions,crypto.randomUUID(),readiness.isAvailable)):kind==="retry"?await replayLogoExport(c):await checkLogoExport(c);
   if(!result||!c.current())return;
   setState(value=>value?.key===key?{...value,requestState:result,error:null}:value);
   if(!memory.get(c.projectId)?.pendingExport)await baseline.reload(false);
  });
 }
 async function acceptManual(c:ExportActionContext,result:LogoMutationReceipt|LogoVariantSet){
  const before=memory.get(c.projectId),pending=before?.pendingMutation,command=pending?.command;
  if(!before?.workspace||!command||!c.current())return;
  if(command.method!=="prepareLogoVariants"&&command.method!=="reviewLogoVariants")throw new AccountRequestError(502);
  if(result.ownerId!==before.workspace.ownerId||result.projectId!==c.projectId)throw new AccountRequestError(502);
  // Verify the result at its own immutable commit, never against a newer head.
  if(command.method==="prepareLogoVariants"){
   const set=logoVariantSetSchema.parse(result);
   if(set.approvedLogoId!==command.body.approvedLogoId||set.directionApprovalId!==command.body.directionApprovalId)throw new AccountRequestError(502);
  }else{
   const receipt=logoMutationReceiptSchema.parse(result);
   if(receipt.requestKey!==command.body.requestKey||receipt.revision.stage!=="deliverables"||receipt.revision.payload.variantSetId!==command.body.variantSetId||receipt.revision.revision!==command.body.expected.stageRevisions.deliverables+1||receipt.workspace.heads.workspaceRevision!==command.body.expected.workspaceRevision+1||receipt.workspace.approvedLogo?.id!==command.body.approvedLogoId)throw new AccountRequestError(502);
  }
  const recorded=await client.readLogoRequest(command.body.requestKey,c.signal);
  if(!recorded||!c.current())return;
  if(recorded.status!=="succeeded"||recorded.requestKey!==command.body.requestKey||!recorded.receipt||!same(recorded.receipt,result))throw new AccountRequestError(409);
  const latest=memory.get(c.projectId);if(!latest||!same(latest.pendingMutation,pending))return;
  // A newer draft or conflict remains untouched. The shared loader may refuse a
  // refresh for that draft, but a verified historical success no longer traps it.
  memory.set(c.projectId,{...latest,pendingMutation:null});
  await baseline.reload(false);
 }
 async function manual(kind:"prepare"|"review",ids:readonly string[]=[]){
  await operation(async c=>{
   const record=memory.get(c.projectId),overview=visible?.overview;
   if(!record?.workspace||!record.base||!overview?.logoApproval||!overview.directionApproval||record.workspace.capabilities.save.status!=="available")throw new AccountRequestError(503);
   if(record.dirty||record.conflict||record.vectorDraft||record.directionDraft||record.pendingExport||record.pendingIntent||record.pendingMutation)throw new AccountRequestError(409);
   const common={requestKey:crypto.randomUUID(),expected:record.base,approvedLogoId:overview.logoApproval.id,directionApprovalId:overview.directionApproval.id};
   const command:LogoManualCommand=kind==="prepare"?{method:"prepareLogoVariants",body:common}:{method:"reviewLogoVariants",body:{...common,variantSetId:visible?.variantSetId??"",acceptedVariantIds:[...ids]}};
   memory.set(c.projectId,{...record,pendingMutation:{requestKey:common.requestKey,command}});
   const result=command.method==="prepareLogoVariants"?await client.prepareLogoVariants(command.body,c.signal):command.method==="reviewLogoVariants"?await client.reviewLogoVariants(command.body,c.signal):null;
   if(result&&c.current())await acceptManual(c,result);
  });
 }
 async function reconcile(){
  if(pendingExport)return exportOperation("check");
  if(ownPendingManual)await operation(async c=>{const state=await client.readLogoRequest(ownPendingManual.requestKey,c.signal);if(state&&c.current()&&state.status==="succeeded"&&state.receipt&&!("operation"in state.receipt))await acceptManual(c,state.receipt);});
 }
 async function retryOriginal(){
  if(!ownPendingManual)return exportOperation("retry");
  await operation(async c=>{
   const original=memory.get(c.projectId)?.pendingMutation;if(!original)return;
   const state=await client.readLogoRequest(original.requestKey,c.signal);if(!state||!c.current()||!same(memory.get(c.projectId)?.pendingMutation,original))return;
   if(state.status==="succeeded"&&state.receipt&&!("operation"in state.receipt)){await acceptManual(c,state.receipt);return;}
   if(state.status!=="not_found")return;
   const command=original.command,result=command.method==="prepareLogoVariants"?await client.prepareLogoVariants(command.body,c.signal):command.method==="reviewLogoVariants"?await client.reviewLogoVariants(command.body,c.signal):null;
   if(result&&c.current())await acceptManual(c,result);
  });
 }
 async function download(file:IdentityAssetReceipt){await operation(async c=>{const result=await client.downloadAsset(file,c.signal);if(!result||!c.current())return;const anchor=document.createElement("a");anchor.href=result.url;anchor.rel="noopener noreferrer";anchor.referrerPolicy="no-referrer";anchor.target="_blank";document.body.append(anchor);anchor.click();anchor.remove();setState(value=>value?.key===key?{...value,downloadMessage:"File checked. Download requested with a private link that expires in 60 seconds."}:value);});}
 async function checkRequest(requestKey:string){await operation(async c=>{if(!visible?.overview?.exportRequests.some(item=>item.requestKey===requestKey))return;const result=await client.readLogoRequest(requestKey,c.signal);if(result&&c.current())setState(value=>value?.key===key?{...value,requestState:result}:value);});await read();}
 let blockedReason:string|null=null;
 if(!active?.approvedLogo||!visible?.overview?.directionApproval)blockedReason="Approve a logo and identity direction first.";
 else if(active.staleStages.some(item=>item.stage==="vector"||item.stage==="directions"))blockedReason="Review the changed logo and identity before refreshing brand files.";
 else if(baseline.dirty||baseline.draft?.conflict)blockedReason="Save or resolve your workspace changes first.";
 else if(pendingExport||pendingManual||baseline.draft?.pendingIntent)blockedReason="Check the original request before starting another.";
 else if(!visible?.variantSetId)blockedReason="Prepare and review the logo variants first.";
 else if(!visible.overview.variantReviews.some(item=>item.variantSetId===visible.variantSetId))blockedReason="Visually review every applicable logo variant first.";
 else if(!exportAvailable)blockedReason=exportUnavailableReason;
 let canExport=false;try{if(active&&baseline.draft&&visible?.overview&&visible.variantSetId&&!blockedReason){buildLogoExportIntent(baseline.draft,visible.overview,visible.variantSetId,selectedOptions,"00000000-0000-4000-8000-000000000001",readiness.isAvailable);canExport=true;}}catch{blockedReason="The saved approvals or variant review changed. Refresh saved work.";}
 const canPrepare=!!(active?.approvedLogo&&visible?.overview?.directionApproval&&active.capabilities.save.status==="available"&&!baseline.dirty&&!baseline.draft?.conflict&&!pendingExport&&!pendingManual&&!baseline.draft?.pendingIntent&&!active.staleStages.some(item=>item.stage==="vector"||item.stage==="directions"));
 return {workspace:active,overview:visible?.overview??null,variantSetId:visible?.variantSetId??null,selectedOptions:pendingExport?{pngLongEdge:pendingExport.pngLongEdge,socialSelections:pendingExport.socialSelections}:selectedOptions,pendingRequestKey:pendingExport?.requestKey??ownPendingManual?.requestKey??null,requestState:visible?.requestState??null,loading:!!visible?.loading||!!(mutating&&mutating.scope===scopeKey&&mutating.client===client),error:visible?.error??null,canRead:!!active,canPrepare,canExport,blockedReason,downloadMessage:visible?.downloadMessage??null,
  refresh:async()=>{await Promise.all([read(),readiness.refresh()]);if(!pendingExport&&!pendingManual)await baseline.reload(false);},prepareVariants:()=>manual("prepare"),reviewVariants:ids=>manual("review",ids),request:()=>exportOperation("request"),retryOriginalExport:retryOriginal,reconcile,download,selectOptions:value=>{if(current()&&!pendingExport&&!writing.current)setOptions({scope:scopeKey,client,value});},checkRequest,loadMore:()=>read(true)};
}
