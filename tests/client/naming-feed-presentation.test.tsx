// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NamingFeedResults, NamingFeedTail } from "@/components/naming/naming-feed-results";
import { ProjectNameCard } from "@/components/naming/naming-results";
import { NAMING_BRAINSTORM_CAUTION } from "@/domain/naming-brainstorm";
import { contextSnapshotSchema } from "@/domain/projects";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey, type ProjectNameEntry } from "@/domain/project-naming";
import type { useNamingFeed } from "@/components/naming/use-naming-feed";
it("keeps favorite feedback usable while generation runs and offers no ordinary regenerate control", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const context = contextSnapshotSchema.parse({ description: "Synthetic presentation fixture" }), ownerId = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001", candidateId = "c0000000-0000-4000-8000-000000000001", createdAt = "2026-10-16T12:00:00Z";
  const entry: ProjectNameEntry = { candidate: { id: candidateId, ownerId, projectId, value: "Juniper", identityKey: nameIdentityKey("Juniper"), rationale: "A synthetic creative interpretation.", contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt, origin: { kind: "local_import", ownerId, projectId, candidateId, contextRevision: 1, source: { id: candidateId, value: "Juniper", createdAt, origin: "manual", history: [] }, capturedContext: context } }, retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } };
  const feed = { entries: [{ entryId: candidateId, position: 1, entry }], state: { pending: {}, acknowledged: true, outcome: null, steering: null, error: null, status: "pending", feed: { activeRun: { state: "running" }, availability: { status: "available" } } }, canExplore: true, interacting: true, attachSentinel: () => {}, stop: vi.fn(), steer: vi.fn() } as unknown as ReturnType<typeof useNamingFeed>;
  const onRetain = vi.fn(), host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(createElement(NamingFeedResults, { feed, strategyKey: namingStrategyKey(context), pending: false, blocked: false, onRetain, onSelect: vi.fn(), onInspect: vi.fn(), onWorkshop: vi.fn(), onModify: vi.fn(), onHistory: vi.fn() })));
    const favorite = host.querySelector<HTMLButtonElement>('[aria-label="Favorite Juniper"]')!;
    expect(favorite.disabled).toBe(false); await act(async () => favorite.click()); expect(onRetain).toHaveBeenCalledWith(entry, "favorite");
    expect(host.textContent).toContain("Exploring your next names"); expect(host.textContent).not.toMatch(/Generate \d+|Regenerate|Load more/);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
it("keeps compact cards to the name while full cards label brainstorm results honestly, retaining favorite controls",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const context=contextSnapshotSchema.parse({description:"Synthetic unchecked presentation"}),ownerId="a0000000-0000-4000-8000-000000000001",projectId="b0000000-0000-4000-8000-000000000001",candidateId="c0000000-0000-4000-8000-000000000001",createdAt="2026-10-29T18:00:00Z";
 const entry:ProjectNameEntry={candidate:{id:candidateId,ownerId,projectId,value:"Juniper",identityKey:nameIdentityKey("Juniper"),rationale:"A proposed nature association.",caution:NAMING_BRAINSTORM_CAUTION,verificationNotes:[],contextRevision:1,strategyBasis:namingStrategyBasis(context),strategyKey:namingStrategyKey(context),createdAt,origin:{kind:"brainstorm",version:1,profile:"brainstorm_v1",ownerId,projectId,candidateId,contextRevision:1,value:"Juniper",batchId:candidateId,jobId:candidateId,runId:candidateId,callId:candidateId,responseId:"resp_synthetic",requestId:null,model:"synthetic-model",generatedAt:createdAt}},retention:{ownerId,projectId,candidateId,revision:0,favorite:false,saved:false,updatedAt:null}};
 const favorite=vi.fn(),host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
  for(const compact of [true,false]){
   await act(async()=>root.render(createElement(ProjectNameCard,{entry,compact,selected:false,earlierContext:false,pending:false,blockSelection:false,onFavorite:favorite,onSave:vi.fn(),onSelect:vi.fn(),onWorkshop:vi.fn(),onInspect:vi.fn()})));
   // Compact cards show only the name, its .com status and the heart (user request,
   // 2026-11-06); the full card and the Details dialog keep the unchecked label.
   if(compact)expect(host.textContent).not.toContain("Unchecked brainstorm");else expect(host.textContent).toContain("Unchecked brainstorm");
   expect(host.textContent).not.toMatch(/Verified origin|Researched etymology|Curator approved/);
   await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Favorite Juniper"]')!.click());
  }
  expect(favorite).toHaveBeenCalledTimes(2);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it("shows the saved initial set and honest approach shortfall without promising automatic further generation",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const feed={entries:[{}],state:{status:"ready",feed:{activeRun:{generationProfile:"brainstorm_v1",state:"succeeded",progress:100,fulfillment:{acceptedCount:100,coverageSatisfied:false}},availability:{status:"available"}}}}as unknown as ReturnType<typeof useNamingFeed>;
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(NamingFeedTail,{feed,blocked:false,onModify:vi.fn()})));
  expect(host.textContent).toContain("100 names are saved");
  // The names are not cleared for use: the reader is told plainly to check them.
  expect(host.textContent).toContain("haven’t been checked for trademarks yet");
  expect(host.textContent).toContain("This set covers fewer of your chosen approaches than planned");
  expect(host.textContent).not.toMatch(/Keep scrolling|Regenerate|Verified/);
  expect(host.querySelectorAll("button")).toHaveLength(0);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
