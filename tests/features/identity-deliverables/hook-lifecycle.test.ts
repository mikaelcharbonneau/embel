// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
vi.mock("server-only",()=>({}));
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import { useLogoExports, type LogoExportsController } from "@/features/identity-deliverables/components/use-logo-exports";
import type { LogoWorkspaceV2, LogoMutationReceipt, LogoStageRevision } from "@/domain/logo-workspace";
import type { LogoRequestState } from "@/domain/logo-jobs";
import type { IdentityAssetReceipt, LogoDeliverablesOverview, LogoExportIntent, LogoVariantSet } from "@/domain/logo-deliverables";
import { approvedExportFixture,id,at } from "./fixtures";
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{"content-type":"application/json"}});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
let root:Root|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;vi.restoreAllMocks();vi.unstubAllGlobals();});
async function until(check:()=>void){let error:unknown;for(let i=0;i<100;i++){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});try{check();return;}catch(e){error=e;}}throw error;}
async function mountExports(legacyExportAvailable=false){
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("crypto",webcrypto);
 const s=await approvedExportFixture(),account={status:"ready" as const,userId:s.ownerId,generation:1};let sessionOwner=s.ownerId;
 const workspace:LogoWorkspaceV2={version:2,ownerId:s.ownerId,projectId:s.projectId,approvedLogo:s.logoApproval,heads:{...s.heads,workspaceRevision:4,stageRevisions:{...s.heads.stageRevisions,concepts:0,deliverables:1}},stages:{brief_references:{stage:"brief_references",id:id(401),revision:1},concepts:null,vector:{stage:"vector",id:s.logoApproval.stageRevisionId,revision:1},refinements:null,directions:{stage:"directions",id:id(403),revision:1},deliverables:{stage:"deliverables",id:id(404),revision:1}},staleStages:[],capabilities:{save:{status:"available"},export:legacyExportAvailable?{status:"available"}:{status:"unavailable",reason:"Historical workspace capability"},upload:{status:"unavailable",reason:"Synthetic"},generate:{status:"unavailable",reason:"Synthetic"},convert:{status:"unavailable",reason:"Synthetic"}}};
 const stage=(stage:string,revisionId:string,payload:unknown)=>({version:2,id:revisionId,ownerId:s.ownerId,projectId:s.projectId,stage,revision:1,parentRevisionId:null,inputRevisions:[],inputHash:"a".repeat(64),payload,createdAt:at});
 const revisions:Record<string,unknown>={
  [id(401)]:stage("brief_references",id(401),{name:s.brandName,activity:"Design",audience:"Teams",personality:"Clear",logoTypes:["wordmark"],referenceSnapshotId:id(405),sourceProjectRevision:1}),
  [s.logoApproval.stageRevisionId]:stage("vector",s.logoApproval.stageRevisionId,{vectorRevisionId:s.logo.id,approvalId:s.logoApproval.id}),
  [id(403)]:stage("directions",id(403),{directionIds:[id(410),id(411),id(412)],selectionId:s.directionSelection.id,approvalId:s.directionApproval.id}),
  [id(404)]:stage("deliverables",id(404),{variantSetId:s.variants.id,exportManifestIds:[]}),
 };
 const overview:LogoDeliverablesOverview={ownerId:s.ownerId,projectId:s.projectId,logoApproval:s.logoApproval,directionApproval:s.directionApproval,variantSets:[s.variants],variantReviews:[s.variantReview],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
 let delayedRead:ReturnType<typeof deferred<Response>>|null=null;
 const manualResponse=deferred<Response>();let manualPost:{method:"prepare"|"review";body:Record<string,unknown>;signal:AbortSignal|null|undefined}|null=null;let manualCount=0;let manualReceipt:LogoMutationReceipt|LogoVariantSet|null=null;
 let exportRejectionState:LogoRequestState|null=null;
 const response=deferred<Response>();let post:{body:LogoExportIntent;signal:AbortSignal|null|undefined}|null=null;let postCount=0;
 let exportAvailable=true,capabilityExpiresAt=0,capabilityReads=0,exportReplay:(()=>Response)|null=null,downloadFile:IdentityAssetReceipt|null=null,downloadCount=0;
 const seen:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const path=String(input);seen.push(path);
  if(path==="/api/session")return json({user:{id:sessionOwner}});
  if(path.endsWith("/capabilities")){capabilityReads++;const now=Date.now();capabilityExpiresAt=now+20_000;return json({ownerId:s.ownerId,projectId:s.projectId,observedAt:new Date(now).toISOString(),operations:{"identity.logo_concept":{status:"unavailable"},"identity.logo_refine":{status:"unavailable"},"identity.logo_vectorize":{status:"unavailable"},"identity.logo_directions":{status:"unavailable"},"identity.logo_export":exportAvailable?{status:"available",expiresAt:new Date(capabilityExpiresAt).toISOString()}:{status:"unavailable"}}});}
  if(path.endsWith("/variants/prepare")||path.endsWith("/variants/review")){manualCount++;manualPost={method:path.endsWith("/prepare")?"prepare":"review",body:JSON.parse(String(init?.body)),signal:init?.signal};return manualResponse.promise;}
  if(path.endsWith("/exports")&&init?.method==="POST"){postCount++;post={body:JSON.parse(String(init.body)),signal:init.signal};return exportReplay?exportReplay():response.promise;}
  if(path.endsWith("/download")&&downloadFile){downloadCount++;return json({url:"https://storage.example.com/synthetic-private-download",versionId:downloadFile.reference.versionId,contentHash:downloadFile.reference.contentHash,mimeType:downloadFile.verification.mimeType,expiresInSeconds:60});}
  if(path.endsWith("/logo"))return json(workspace);
  if(path.includes("/deliverables?")){if(delayedRead){const gate=delayedRead;delayedRead=null;return gate.promise;}return json(overview);}
  if(path.includes("/reference-snapshots/"))return json({version:2,id:id(405),ownerId:s.ownerId,projectId:s.projectId,revision:1,references:[]});
  if(path.includes("/stages/"))return json(revisions[path.split("/").at(-1)!]??{},revisions[path.split("/").at(-1)!]?200:404);
  if(path.includes("/requests/")&&post&&path.includes(post.body.requestKey)&&exportRejectionState)return json(exportRejectionState);
  if(path.includes("/requests/")&&manualReceipt&&manualPost&&path.includes(String(manualPost.body.requestKey)))return json({status:"succeeded",requestKey:manualPost.body.requestKey,receipt:manualReceipt,outputs:[],billing:{status:"recorded",confirmedMicrousd:0},reason:null});
  if(path.includes("/requests/")){const match=overview.exportRequests.find(r=>path.includes(r.requestKey));return json(match?.state??{status:"not_found"});}
  return json({},503);
 };
 vi.stubGlobal("fetch",fetcher);const client=createAccountLogoClient(account,s.projectId,()=>true,()=>{},fetcher);
 let controller:LogoExportsController|undefined,memory:LogoDraftMemory|undefined,refreshSession:(()=>void)|undefined;
 function Harness(){const value=useLogoExports(client,workspace),store=useLogoDraftMemory(),session=useAccountSession();useLayoutEffect(()=>{controller=value;memory=store;refreshSession=session.refresh;});return createElement("span",null,value.canRead?value.overview?.ownerId:"Account unverified");}
 async function mount(){const container=document.createElement("div");document.body.append(container);root=createRoot(container);await act(async()=>root!.render(createElement(AccountSessionProvider,null,createElement(Harness))));await until(()=>{expect(controller?.overview,JSON.stringify({seen,error:controller?.error,canRead:controller?.canRead,workspace:controller?.workspace?.heads,memory:memory?.get(s.projectId)?.base})).not.toBeNull();expect(controller?.loading).toBe(false);expect(controller?.canExport).toBe(true);});return container;}
 const container=await mount();
 function commitAdmission(){const body=post!.body,receipt={ownerId:s.ownerId,projectId:s.projectId,requestKey:body.requestKey,operation:"identity.logo_export" as const,batchId:null,jobIds:[id(600)],inputHash:"b".repeat(64)};overview.exportRequests.push({requestKey:body.requestKey,input:body,state:{status:"admitted",requestKey:body.requestKey,receipt,outputs:[],billing:{status:"recorded",confirmedMicrousd:0},reason:null},exportManifestId:null,createdAt:at});return receipt;}
 function commitManualThenAdvance(){
  const original=manualPost!,previous=structuredClone(workspace),set=original.method==="prepare"?{...structuredClone(s.variants),id:id(651)}:s.variants;
  const committedStage={...stage("deliverables",id(650),{variantSetId:set.id,exportManifestIds:[]}),revision:2,parentRevisionId:id(404)} as LogoStageRevision<"deliverables">;
  const committedWorkspace={...previous,heads:{...previous.heads,workspaceRevision:5,stageRevisions:{...previous.heads.stageRevisions,deliverables:2}},stages:{...previous.stages,deliverables:{stage:"deliverables" as const,id:id(650),revision:2}}};
  manualReceipt=original.method==="prepare"?set:{ownerId:s.ownerId,projectId:s.projectId,requestKey:String(original.body.requestKey),workspace:committedWorkspace,revision:committedStage};
  revisions[id(650)]=committedStage;
  const latestSet={...structuredClone(s.variants),id:id(652)};overview.variantSets=[latestSet,set,...overview.variantSets.filter(item=>item.id!==set.id)];
  revisions[id(653)]={...stage("deliverables",id(653),{variantSetId:latestSet.id,exportManifestIds:[]}),revision:3,parentRevisionId:id(650)};
  workspace.heads={...previous.heads,workspaceRevision:6,stageRevisions:{...previous.heads.stageRevisions,deliverables:3}};
  workspace.stages={...previous.stages,deliverables:{stage:"deliverables",id:id(653),revision:3}};
  return {receipt:manualReceipt,committedWorkspace,currentWorkspace:structuredClone(workspace),latestSet};
 }
 function rejectExportThenAdvance(){
  const input=post!.body,rejection={status:"rejected" as const,operation:"identity.logo_export" as const,ownerId:s.ownerId,projectId:s.projectId,requestKey:input.requestKey,input};
  exportRejectionState={status:"failed",requestKey:input.requestKey,receipt:null,outputs:[],billing:{status:"recorded",confirmedMicrousd:0},reason:"admission_rejected",rejection};
  workspace.heads={...workspace.heads,workspaceRevision:5,stageRevisions:{...workspace.heads.stageRevisions,deliverables:2}};
  workspace.stages={...workspace.stages,deliverables:{stage:"deliverables",id:id(660),revision:2}};
  revisions[id(660)]={...stage("deliverables",id(660),{variantSetId:s.variants.id,exportManifestIds:[]}),revision:2,parentRevisionId:id(404)};
  return {envelope:{error:{code:"conflict",message:"Saved heads changed"},rejection},currentWorkspace:structuredClone(workspace)};
 }
 return{client,container,overview,response,mount,commitAdmission,rejectExportThenAdvance,manualResponse,commitManualThenAdvance,get manualCount(){return manualCount;},delayRead(){delayedRead=deferred<Response>();return delayedRead;},get controller(){return controller!;},get memory(){return memory!;},get post(){return post;},get postCount(){return postCount;},changeAccount(){sessionOwner=id(999);refreshSession!();},setReadiness(available:boolean){exportAvailable=available;},get capabilityExpiresAt(){return capabilityExpiresAt;},get capabilityReads(){return capabilityReads;},acceptReplay(){exportReplay=()=>json(commitAdmission());},prepareDownload(){downloadFile=s.variants.items[0]!.preview!;return downloadFile;},get downloadCount(){return downloadCount;}};
}
describe("mounted export lifecycle",()=>{
 it("uses exact live readiness when historical workspace metadata is unavailable",async()=>{
  const f=await mountExports();try{expect(f.controller.workspace!.capabilities.export.status).toBe("unavailable");expect(f.capabilityReads).toBeGreaterThan(0);expect(f.controller.canExport).toBe(true);expect(f.postCount).toBe(0);}finally{f.client.dispose();}
 });
 it("blocks a captured export click after expiry without retaining or dispatching new work",async()=>{
  let now=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>now);
  const f=await mountExports(true);let pending:Promise<void>|undefined;
  try{await act(async()=>f.controller.selectOptions({pngLongEdge:1024,socialSelections:[{kind:"avatar",presetId:"avatar-1024-contain-v1"}]}));const request=f.controller.request,record=f.memory.get(f.overview.projectId),options=f.controller.selectedOptions;now=f.capabilityExpiresAt+1;
   await act(async()=>{pending=request();});expect(f.postCount).toBe(0);await pending;expect(f.memory.get(f.overview.projectId)).toEqual(record);expect(f.controller.selectedOptions).toEqual(options);expect(f.controller.canExport).toBe(false);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("readiness changes preserve selected options and never start an export",async()=>{
  const f=await mountExports();try{const options={pngLongEdge:1024 as const,socialSelections:[{kind:"avatar" as const,presetId:"avatar-1024-contain-v1"}]};await act(async()=>f.controller.selectOptions(options));f.setReadiness(false);await act(async()=>f.controller.refresh());expect(f.controller.canExport).toBe(false);expect(f.controller.canRead).toBe(true);expect(f.controller.selectedOptions).toEqual(options);expect(f.controller.overview).not.toBeNull();expect(f.postCount).toBe(0);f.setReadiness(true);await act(async()=>f.controller.refresh());expect(f.controller.canExport).toBe(true);expect(f.controller.selectedOptions).toEqual(options);expect(f.postCount).toBe(0);}finally{f.client.dispose();}
 });
 it("reads, reconciles and downloads admitted work while export readiness is unavailable",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));await act(async()=>{f.response.resolve(json(f.commitAdmission()));await pending;});const original=f.post!.body;f.setReadiness(false);await act(async()=>f.controller.refresh());expect(f.controller.canRead).toBe(true);expect(f.controller.canExport).toBe(false);expect(f.memory.get(f.overview.projectId)!.pendingExport).toEqual(original);
   await act(async()=>{await f.controller.reconcile();await f.controller.checkRequest(original.requestKey);});expect(f.controller.requestState?.status).toBe("admitted");expect(f.memory.get(f.overview.projectId)!.pendingExport).toEqual(original);const click=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});await act(async()=>f.controller.download(f.prepareDownload()));expect(f.downloadCount).toBe(1);expect(click).toHaveBeenCalledTimes(1);expect(f.postCount).toBe(1);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("explicitly recovers an unacknowledged original with identical options while readiness is unavailable",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{f.controller.selectOptions({pngLongEdge:1024,socialSelections:[]});});await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));const original=f.post!.body;await act(async()=>{f.response.resolve(json({},503));await pending;});f.setReadiness(false);await act(async()=>f.controller.refresh());expect(f.memory.get(f.overview.projectId)!.pendingExport).toEqual(original);expect(f.postCount).toBe(1);f.acceptReplay();await act(async()=>f.controller.retryOriginalExport());expect(f.postCount).toBe(2);expect(f.post!.body).toEqual(original);expect(f.controller.requestState?.status).toBe("admitted");expect(f.memory.get(f.overview.projectId)!.pendingExport).toEqual(original);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("retaining options does not abort its own POST; repeated requests cannot duplicate admission",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{f.controller.selectOptions({pngLongEdge:1024,socialSelections:[{kind:"avatar",presetId:"avatar-1024-contain-v1"}]});});await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));expect(f.post!.signal!.aborted).toBe(false);expect(f.memory.get(f.overview.projectId)!.pendingExport).toEqual(f.post!.body);
   await act(async()=>{await f.controller.request();await f.controller.refresh();});expect(f.post!.signal!.aborted).toBe(false);expect(f.postCount).toBe(1);
   await act(async()=>{f.response.resolve(json(f.commitAdmission()));await pending;});expect(f.memory.get(f.overview.projectId)!.pendingExport?.requestKey).toBe(f.post!.body.requestKey);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("recovers an acknowledged-lost request from durable overview after a clean remount",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));const body=f.post!.body;f.commitAdmission();await act(async()=>{f.response.resolve(json({},503));await pending;});await act(async()=>{root!.unmount();root=null;});await f.mount();expect(f.controller.overview!.exportRequests[0]!.input).toEqual(body);expect(f.controller.overview!.exportRequests[0]!.state.status).toBe("admitted");expect(f.postCount).toBe(1);
   await act(async()=>{await f.controller.checkRequest(body.requestKey);});expect(f.postCount).toBe(1);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("account change aborts private work and a late old reply cannot restore it",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));await act(async()=>{f.changeAccount();});await until(()=>expect(f.controller.canRead).toBe(false));expect(f.post!.signal!.aborted).toBe(true);await act(async()=>{f.response.resolve(json(f.commitAdmission()));await pending;});expect(f.controller.overview).toBeNull();expect(f.memory.get(f.overview.projectId)).toBeNull();
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("interrupting a background read does not leave a completed request permanently busy",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined,refresh:Promise<void>|undefined;const gate=f.delayRead();
  try{await act(async()=>{refresh=f.controller.refresh();});await until(()=>expect(f.controller.loading).toBe(true));await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));await act(async()=>{f.response.resolve(json(f.commitAdmission()));await pending;gate.resolve(json(f.overview));await refresh;});await until(()=>expect(f.controller.loading).toBe(false));
  }finally{gate.resolve(json(f.overview));f.response.resolve(json({},503));await pending;await refresh;f.client.dispose();}
 });
 it("a terminal read releases only the exact retained export without another POST",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));await act(async()=>{f.response.resolve(json(f.commitAdmission()));await pending;});f.overview.exportRequests[0]!.state.status="failed";await act(async()=>{await f.controller.refresh();});await until(()=>expect(f.memory.get(f.overview.projectId)!.pendingExport).toBeNull());expect(f.postCount).toBe(1);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it.each(["prepare","review"] as const)("settles a delayed historical %s receipt without rolling back newer heads",async method=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=method==="prepare"?f.controller.prepareVariants():f.controller.reviewVariants(f.overview.variantSets[0]!.items.map(item=>item.id));});await until(()=>expect(f.manualCount).toBe(1));const committed=f.commitManualThenAdvance();await act(async()=>{f.manualResponse.resolve(json(committed.receipt));await pending;});await until(()=>expect(f.memory.get(f.overview.projectId)!.pendingMutation).toBeNull());expect(f.memory.get(f.overview.projectId)!.workspace!.heads).toEqual(committed.currentWorkspace.heads);expect(f.controller.variantSetId).toBe(committed.latestSet.id);expect(f.manualCount).toBe(1);
  }finally{f.manualResponse.resolve(json({},503));await pending;f.client.dispose();}
 });
 it.each(["prepare","review"] as const)("recovers a lost %s acknowledgement after another tab advances the head",async method=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=method==="prepare"?f.controller.prepareVariants():f.controller.reviewVariants(f.overview.variantSets[0]!.items.map(item=>item.id));});await until(()=>expect(f.manualCount).toBe(1));const committed=f.commitManualThenAdvance();await act(async()=>{f.manualResponse.resolve(json({},503));await pending;});expect(f.memory.get(f.overview.projectId)!.pendingMutation).not.toBeNull();await act(async()=>{await f.controller.reconcile();});await until(()=>expect(f.memory.get(f.overview.projectId)!.pendingMutation).toBeNull());expect(f.memory.get(f.overview.projectId)!.workspace!.heads).toEqual(committed.currentWorkspace.heads);expect(f.manualCount).toBe(1);
  }finally{f.manualResponse.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("settles historical success while preserving a newer unsaved brief",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.prepareVariants();});await until(()=>expect(f.manualCount).toBe(1));const before=f.memory.get(f.overview.projectId)!;await act(async()=>f.memory.set(f.overview.projectId,{...before,dirty:true,brief:{...before.brief,activity:"New unsaved work"}}));const committed=f.commitManualThenAdvance();await act(async()=>{f.manualResponse.resolve(json(committed.receipt));await pending;});await until(()=>expect(f.memory.get(f.overview.projectId)!.pendingMutation).toBeNull());expect(f.memory.get(f.overview.projectId)!.brief.activity).toBe("New unsaved work");expect(f.memory.get(f.overview.projectId)!.dirty).toBe(true);expect(f.memory.get(f.overview.projectId)!.base).toEqual(before.base);
  }finally{f.manualResponse.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("a delayed exact rejection clears the original attempt and reloads cross-tab heads",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));const original=f.memory.get(f.overview.projectId)!.pendingExport;expect(original).toEqual(f.post!.body);const rejected=f.rejectExportThenAdvance();await act(async()=>{f.response.resolve(json(rejected.envelope,409));await pending;});await until(()=>expect(f.memory.get(f.overview.projectId)!.pendingExport).toBeNull());expect(f.memory.get(f.overview.projectId)!.workspace!.heads).toEqual(rejected.currentWorkspace.heads);expect(f.postCount).toBe(1);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("a lost rejection acknowledgement recovers the exact tombstone with GET only",async()=>{
  const f=await mountExports();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.request();});await until(()=>expect(f.postCount).toBe(1));const rejected=f.rejectExportThenAdvance();await act(async()=>{f.response.resolve(json({},503));await pending;});expect(f.memory.get(f.overview.projectId)!.pendingExport).toEqual(f.post!.body);await act(async()=>{await f.controller.reconcile();});await until(()=>expect(f.memory.get(f.overview.projectId)!.pendingExport).toBeNull());expect(f.memory.get(f.overview.projectId)!.workspace!.heads).toEqual(rejected.currentWorkspace.heads);expect(f.postCount).toBe(1);
  }finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
});
