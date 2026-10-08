import { describe, expect, it, vi } from "vitest";
import { buildLogoExportIntent, dispatchLogoExport, checkLogoExport, replayLogoExport } from "@/features/identity-deliverables/components/export-actions";
import { createLogoDraftMemory, type LogoDraftRecord } from "@/components/identity/logo-draft-memory";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoWorkspaceV2 } from "@/domain/logo-workspace";
import type { LogoDeliverablesOverview } from "@/domain/logo-deliverables";
import { approvedExportFixture,id } from "./fixtures";
vi.mock("server-only",()=>({}));
async function fixture() {
 const s=await approvedExportFixture();
 const workspace:LogoWorkspaceV2={version:2,ownerId:s.ownerId,projectId:s.projectId,heads:s.heads,approvedLogo:s.logoApproval,stages:{brief_references:{stage:"brief_references",id:id(400),revision:1},concepts:{stage:"concepts",id:id(401),revision:1},vector:{stage:"vector",id:s.logoApproval.stageRevisionId,revision:1},refinements:null,directions:{stage:"directions",id:id(402),revision:1},deliverables:null},staleStages:[],capabilities:{save:{status:"available"},export:{status:"available"},upload:{status:"unavailable",reason:"Fixture"},generate:{status:"unavailable",reason:"Fixture"},convert:{status:"unavailable",reason:"Fixture"}}};
 const overview:LogoDeliverablesOverview={ownerId:s.ownerId,projectId:s.projectId,logoApproval:s.logoApproval,directionApproval:s.directionApproval,variantSets:[s.variants],variantReviews:[s.variantReview],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
 const record:LogoDraftRecord={workspace,base:workspace.heads,brief:{name:s.brandName,activity:"Studio",audience:"Teams",personality:"Precise",logoTypes:["wordmark"]},references:[],dirty:false,conflict:false,pendingIntent:null,pendingCreation:null,pendingExport:null,pendingMutation:null};
 const memory=createLogoDraftMemory();memory.bind({ownerId:s.ownerId,generation:1});memory.set(s.projectId,record);
 const intent=buildLogoExportIntent(record,overview,s.variants.id,{pngLongEdge:2048,socialSelections:[]},id(500));
 const receipt={ownerId:s.ownerId,projectId:s.projectId,requestKey:intent.requestKey,operation:"identity.logo_export" as const,batchId:null,jobIds:[id(600)],inputHash:"c".repeat(64)};
 const state={status:"admitted" as const,requestKey:intent.requestKey,receipt,outputs:[],billing:{status:"recorded" as const,confirmedMicrousd:0},reason:null};
 const client={requestLogoExport:vi.fn(async()=>{expect(memory.get(s.projectId)!.pendingExport).toEqual(intent);return receipt;}),readLogoRequest:vi.fn(async()=>state),reconcileLogoRequest:vi.fn(async()=>state)} as unknown as AccountLogoClient;
 let current=true;const context={client,memory,projectId:s.projectId,signal:new AbortController().signal,current:()=>current};
 return{s,record,overview,intent,receipt,state,context,client,memory,unverify:()=>{current=false;}};
}
describe("owner-bound durable export intent recovery",()=>{
 it("uses exact live export readiness rather than an immutable workspace capability",async()=>{
  const f=await fixture(),record={...f.record,workspace:{...f.record.workspace!,capabilities:{...f.record.workspace!.capabilities,export:{status:"unavailable" as const,reason:"Historical snapshot"}}}};
  const available=(operation:string)=>operation==="identity.logo_export";
  expect(buildLogoExportIntent(record,f.overview,f.s.variants.id,{pngLongEdge:2048,socialSelections:[]},f.intent.requestKey,available)).toEqual(f.intent);
  expect(()=>buildLogoExportIntent(f.record,f.overview,f.s.variants.id,{pngLongEdge:2048,socialSelections:[]},f.intent.requestKey,()=>false)).toThrow();
 });
 it("checks export readiness again at dispatch before retaining a new intent",async()=>{
  const f=await fixture();let available=true;const isAvailable=(operation:string)=>operation==="identity.logo_export"&&available;
  const intent=buildLogoExportIntent(f.record,f.overview,f.s.variants.id,{pngLongEdge:2048,socialSelections:[]},f.intent.requestKey,isAvailable);
  available=false;
  await expect(dispatchLogoExport({...f.context,isAvailable},intent)).rejects.toMatchObject({status:503});
  expect(f.client.requestLogoExport).not.toHaveBeenCalled();expect(f.memory.get(f.s.projectId)!.pendingExport).toBeNull();expect(f.memory.get(f.s.projectId)).toEqual(f.record);
 });
 it("reads and explicitly replays only the retained original while readiness is unavailable",async()=>{
  const f=await fixture(),context={...f.context,isAvailable:()=>false};f.memory.set(f.s.projectId,{...f.record,pendingExport:f.intent});
  expect((await dispatchLogoExport(context,f.intent))?.status).toBe("admitted");expect(f.client.requestLogoExport).not.toHaveBeenCalled();
  vi.mocked(f.client.readLogoRequest).mockResolvedValueOnce({status:"not_found"});
  expect((await replayLogoExport(context))?.status).toBe("admitted");expect(f.client.requestLogoExport).toHaveBeenCalledTimes(1);expect(f.client.requestLogoExport).toHaveBeenCalledWith(f.intent,f.context.signal);expect(f.memory.get(f.s.projectId)!.pendingExport).toEqual(f.intent);
 });
 it("persists exact options before POST and double clicks read the same key",async()=>{const f=await fixture();await Promise.all([dispatchLogoExport(f.context,f.intent),dispatchLogoExport(f.context,f.intent)]);expect(f.client.requestLogoExport).toHaveBeenCalledTimes(1);expect(f.memory.get(f.s.projectId)!.pendingExport).toEqual(f.intent);});
 it("keeps unknown admission without replaying from a read or changing options",async()=>{const f=await fixture();vi.mocked(f.client.requestLogoExport).mockRejectedValueOnce(new Error("Lost acknowledgement"));await expect(dispatchLogoExport(f.context,f.intent)).rejects.toThrow();await checkLogoExport(f.context);await checkLogoExport(f.context);expect(f.client.reconcileLogoRequest).not.toHaveBeenCalled();expect(f.client.requestLogoExport).toHaveBeenCalledTimes(1);expect(f.memory.get(f.s.projectId)!.pendingExport).toEqual(f.intent);});
 it("only explicitly replays a confirmed not-found original and fences late owner changes",async()=>{const f=await fixture();f.memory.set(f.s.projectId,{...f.record,pendingExport:f.intent});vi.mocked(f.client.readLogoRequest).mockResolvedValueOnce({status:"not_found"});await replayLogoExport(f.context);expect(f.client.requestLogoExport).toHaveBeenCalledWith(f.intent,f.context.signal);f.unverify();expect(await checkLogoExport(f.context)).toBeNull();});
 it("rejects stale, unapproved or unsaved sources and never treats a fenced null as success",async()=>{const f=await fixture();for(const record of [{...f.record,dirty:true},{...f.record,vectorDraft:{baseVectorRevisionId:f.s.logo.id,edit:{kind:"color"}}},{...f.record,workspace:{...f.record.workspace!,approvedLogo:null}}])expect(()=>buildLogoExportIntent(record as LogoDraftRecord,f.overview,f.s.variants.id,{pngLongEdge:512,socialSelections:[]},id(501))).toThrow();vi.mocked(f.client.requestLogoExport).mockResolvedValue(null);expect(await dispatchLogoExport(f.context,f.intent)).toBeNull();expect(f.memory.get(f.s.projectId)!.pendingExport).toEqual(f.intent);});
 it("terminal owned receipts clear only the original pending export",async()=>{const f=await fixture();f.memory.set(f.s.projectId,{...f.record,pendingExport:f.intent});vi.mocked(f.client.readLogoRequest).mockResolvedValue({...f.state,status:"succeeded"});expect((await checkLogoExport(f.context))?.status).toBe("succeeded");expect(f.memory.get(f.s.projectId)!.pendingExport).toBeNull();});
});
