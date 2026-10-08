// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from "vitest";
import { act,createElement,useLayoutEffect } from "react";
import { createRoot,type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { AccountSessionProvider } from "@/components/workspace/account-session";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import { useIdentityDirections,type IdentityDirectionsController } from "@/features/identity-directions/components/use-identity-directions";
import { IdentityDirectionsView } from "@/features/identity-directions/components/identity-directions-panel";
import { fontCheckBinding } from "@/features/identity-directions/model/font-check-binding";
import type { LogoMutationReceipt,LogoStageRevision,LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { directionFixture,id } from "./fixtures";
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
let mounted:Root|null=null;
afterEach(async()=>{if(mounted){await act(async()=>mounted!.unmount());mounted=null;}vi.unstubAllGlobals();});
async function until(check:()=>void){let error:unknown;for(let i=0;i<100;i++){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});try{check();return;}catch(e){error=e;}}throw error;}
async function mountDirections(){
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("crypto",webcrypto);
 const overview=directionFixture(),account={status:"ready" as const,userId:overview.ownerId,generation:1},font=overview.fonts[0]!;
 overview.fontChecks=await Promise.all(overview.typography.flatMap(t=>t.styles.map(async s=>({typographyVersionId:t.id,styleKey:s.key,role:s.role,fontVersionId:font.id,fontContentHash:font.asset.contentHash,...await fontCheckBinding({text:s.sampleText,fontVersionId:font.id,fontContentHash:font.asset.contentHash,weight:s.weight,style:s.style}),missingCodePoints:[],styleSupported:true}))));
 let workspace:LogoWorkspaceV2={version:2,ownerId:overview.ownerId,projectId:overview.projectId,approvedLogo:overview.currentApprovedLogo,heads:{projectRevision:1,referenceRevision:0,preferencesRevision:0,workspaceRevision:3,stageRevisions:{brief_references:1,concepts:0,vector:1,refinements:0,directions:1,deliverables:0}},stages:{brief_references:{stage:"brief_references",id:id(6),revision:1},concepts:null,vector:{stage:"vector",id:id(5),revision:1},refinements:null,directions:{stage:"directions",id:id(8),revision:1},deliverables:null},staleStages:[],capabilities:{save:{status:"available"},upload:{status:"unavailable",reason:"Local fixture"},generate:{status:"unavailable",reason:"Local fixture"},convert:{status:"unavailable",reason:"Local fixture"},export:{status:"unavailable",reason:"Local fixture"}}};
 const stage=(stage:string,revisionId:string,payload:unknown)=>({version:2,id:revisionId,ownerId:overview.ownerId,projectId:overview.projectId,stage,revision:1,parentRevisionId:null,inputRevisions:[],inputHash:"a".repeat(64),payload,createdAt:"2026-10-07T00:00:00Z"});
 const revisions:Record<string,unknown>={
  [id(6)]:stage("brief_references",id(6),{name:"Fluid",activity:"Design",audience:"Teams",personality:"Clear",logoTypes:["wordmark"],referenceSnapshotId:id(9),sourceProjectRevision:1}),
  [id(5)]:stage("vector",id(5),{vectorRevisionId:id(4),approvalId:id(3)}),
  [id(8)]:stage("directions",id(8),{directionIds:overview.directions.map(d=>d.id),selectionId:null,approvalId:null}),
 };
 const response=deferred<Response>(),retryResponse=deferred<Response>();const bodies:Record<string,unknown>[]=[];const lookup=vi.fn(async()=>json({status:"not_found"}));let post:{body:Record<string,unknown>;signal:AbortSignal|null|undefined}|null=null;let postCount=0;
 const fetcher:typeof fetch=async(input,init)=>{
  const path=String(input);
  if(path==="/api/session")return json({user:{id:overview.ownerId}});
  if(path.endsWith("/directions/selection")){postCount++;post={body:JSON.parse(String(init?.body)),signal:init?.signal};bodies.push(post.body);return postCount===1?response.promise:retryResponse.promise;}
  if(path.includes("/requests/"))return lookup();
  if(path.endsWith(`/logo`))return json(workspace);
  if(path.includes("/directions?"))return json(overview);
  if(path.includes("/reference-snapshots/"))return json({version:2,id:id(9),ownerId:overview.ownerId,projectId:overview.projectId,revision:1,references:[]});
  if(path.includes("/stages/")){const row=revisions[path.split("/").at(-1)!];return row?json(row):json({},404);}
  return json({},503);
 };
 vi.stubGlobal("fetch",fetcher);
 const client=createAccountLogoClient(account,overview.projectId,()=>true,()=>{},fetcher);
 let controller:IdentityDirectionsController|undefined,memory:LogoDraftMemory|undefined;
 function Harness(){const value=useIdentityDirections(client,workspace),store=useLogoDraftMemory();useLayoutEffect(()=>{controller=value;memory=store;});return createElement(IdentityDirectionsView,{controller:value});}
 const container=document.createElement("div");document.body.appendChild(container);mounted=createRoot(container);
 await act(async()=>{mounted!.render(createElement(AccountSessionProvider,null,createElement(Harness)));});
 await until(()=>{expect(controller?.overview).not.toBeNull();expect(controller?.loading).toBe(false);expect(controller?.directionIds).toHaveLength(3);});
 const initial={paletteVersionId:overview.palettes[0]!.id,typographyVersionId:overview.typography[0]!.id,graphicsVersionId:overview.graphics[0]!.id};
 await act(async()=>{await controller!.preview(initial);});await until(()=>expect(controller?.draft?.consistency.status).toBe("pass"));
 return {container,client,overview,get controller(){return controller!;},get memory(){return memory!;},get post(){return post;},get postCount(){return postCount;},response,retryResponse,bodies,lookup,
  finish(){const original=post!;const currentPreview=controller!.draft!;const revision={...stage("directions",id(80),{directionIds:overview.directions.map(d=>d.id),selectionId:id(81),approvalId:null}),revision:2,parentRevisionId:id(8)} as LogoStageRevision<"directions">;
   overview.selection={id:id(81),ownerId:overview.ownerId,projectId:overview.projectId,approvedLogoId:id(3),inputRevisions:[],...initial,sourceDirectionIds:[overview.directions[0]!.id],consistency:currentPreview.consistency};
   workspace={...workspace,heads:{...workspace.heads,workspaceRevision:4,stageRevisions:{...workspace.heads.stageRevisions,directions:2}},stages:{...workspace.stages,directions:{stage:"directions",id:id(80),revision:2}}};revisions[id(80)]=revision;
   const receipt:LogoMutationReceipt={ownerId:overview.ownerId,projectId:overview.projectId,requestKey:String(original.body.requestKey),workspace,revision};(postCount===1?response:retryResponse).resolve(json(receipt));
  },
 };
}
describe("mounted direction request lifecycle with local React DOM",()=>{
 it("retaining an exact pending command does not abort its own delayed save",async()=>{
  const f=await mountDirections();let pending:Promise<void>|undefined;
  try{
   await act(async()=>{pending=f.controller.saveMix();});
   await until(()=>expect(f.postCount).toBe(1));
   expect(f.memory.get(f.overview.projectId)?.pendingMutation?.requestKey).toBe(f.post!.body.requestKey);
   expect(f.post!.signal!.aborted).toBe(false);
   await act(async()=>{await f.controller.refresh();});expect(f.post!.signal!.aborted).toBe(false);
   await act(async()=>{f.finish();await pending;});
   await until(()=>{expect(f.memory.get(f.overview.projectId)?.pendingMutation).toBeNull();expect(f.controller.overview?.selection?.id).toBe(id(81));expect(f.controller.directionIds).toHaveLength(3);});
   expect(f.postCount).toBe(1);expect(f.container.querySelectorAll("select")[1]!.querySelector(`option[value="${f.overview.typography[1]!.id}"]`)).not.toBeNull();
   await act(async()=>{await f.controller.preview({paletteVersionId:f.overview.palettes[0]!.id,typographyVersionId:f.overview.typography[1]!.id,graphicsVersionId:f.overview.graphics[0]!.id});});
   await until(()=>expect(f.controller.draft?.components.typographyVersionId).toBe(f.overview.typography[1]!.id));
  }finally{f.response.resolve(json({},503));await act(async()=>{await pending;});f.client.dispose();}
 });
 it("unmount aborts a real pending request without discarding its recovery key",async()=>{
  const f=await mountDirections();let pending:Promise<void>|undefined;
  try{await act(async()=>{pending=f.controller.saveMix();});await until(()=>expect(f.postCount).toBe(1));const key=f.post!.body.requestKey;await act(async()=>{mounted!.unmount();mounted=null;});expect(f.post!.signal!.aborted).toBe(true);expect(f.memory.get(f.overview.projectId)?.pendingMutation?.requestKey).toBe(key);}finally{f.response.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("explicit mounted retry checks first and sends the exact retained body once on repeated clicks",async()=>{
  const f=await mountDirections();let pending:Promise<void>|undefined;
  try {
   await act(async()=>{pending=f.controller.saveMix();});await until(()=>expect(f.postCount).toBe(1));
   await act(async()=>{f.response.resolve(json({},503));await pending;});
   expect(f.controller.pendingRequestKey).toBe(f.post!.body.requestKey);expect(f.controller.canSave).toBe(false);
   const button=Array.from(f.container.querySelectorAll("button")).find(item=>item.textContent==="Retry original save");expect(button).toBeDefined();
   await act(async()=>{button!.click();button!.click();});await until(()=>expect(f.postCount).toBe(2));
   expect(f.lookup).toHaveBeenCalledTimes(1);expect(f.bodies[1]).toEqual(f.bodies[0]);
   await act(async()=>{f.finish();});await until(()=>expect(f.memory.get(f.overview.projectId)?.pendingMutation).toBeNull());
   expect(f.postCount).toBe(2);
  } finally {f.response.resolve(json({},503));f.retryResponse.resolve(json({},503));await pending;f.client.dispose();}
 });
 it("mounted check stays read-only, and unmount during a retry lookup prevents POST",async()=>{
  const f=await mountDirections();let pending:Promise<void>|undefined;const lookup=deferred<Response>();
  try {
   await act(async()=>{pending=f.controller.saveMix();});await until(()=>expect(f.postCount).toBe(1));
   await act(async()=>{f.response.resolve(json({},503));await pending;});
   await act(async()=>{await f.controller.reconcile();});expect(f.postCount).toBe(1);expect(f.controller.pendingRequestKey).not.toBeNull();
   f.lookup.mockReturnValue(lookup.promise);
   await act(async()=>{pending=f.controller.retryOriginal();});await until(()=>expect(f.lookup).toHaveBeenCalledTimes(2));
   await act(async()=>{mounted!.unmount();mounted=null;});lookup.resolve(json({status:"not_found"}));await pending;
   expect(f.postCount).toBe(1);expect(f.memory.get(f.overview.projectId)?.pendingMutation).not.toBeNull();
  } finally {lookup.resolve(json({status:"not_found"}));f.response.resolve(json({},503));f.retryResponse.resolve(json({},503));await pending;f.client.dispose();}
 });
});
