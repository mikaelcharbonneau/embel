// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NamingFeedResults, NamingFeedStatus } from "@/components/naming/naming-feed-results";
import { ProjectNameCard } from "@/components/naming/naming-results";
import { NAMING_BRAINSTORM_CAUTION } from "@/domain/naming-brainstorm";
import { contextSnapshotSchema } from "@/domain/projects";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey, type ProjectNameEntry } from "@/domain/project-naming";
import type { NamingFeed } from "@/components/naming/use-naming-feed";
it("keeps favorite feedback usable while generation runs and offers no ordinary regenerate control", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const context = contextSnapshotSchema.parse({ description: "Synthetic presentation fixture" }), ownerId = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001", candidateId = "c0000000-0000-4000-8000-000000000001", createdAt = "2026-10-16T12:00:00Z";
  const entry: ProjectNameEntry = { candidate: { id: candidateId, ownerId, projectId, value: "Juniper", identityKey: nameIdentityKey("Juniper"), rationale: "A synthetic creative interpretation.", contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt, origin: { kind: "local_import", ownerId, projectId, candidateId, contextRevision: 1, source: { id: candidateId, value: "Juniper", createdAt, origin: "manual", history: [] }, capturedContext: context } }, retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } };
  const stop = vi.fn(async () => true);
  const feed = { status: { kind: "active", message: "Generating names… 40 of 100", savedCount: 40 }, canStop: true, stop, retry: vi.fn(), refresh: vi.fn() } as unknown as NamingFeed;
  const onRetain = vi.fn(), host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(createElement(NamingFeedResults, { entries: [entry], feed, strategyKey: namingStrategyKey(context), pending: false, blocked: false, onRetain, onSelect: vi.fn(), onInspect: vi.fn() })));
    const favorite = host.querySelector<HTMLButtonElement>('[aria-label="Favorite Juniper"]')!;
    expect(favorite.disabled).toBe(false); await act(async () => favorite.click()); expect(onRetain).toHaveBeenCalledWith(entry, "favorite");
    expect(host.textContent).toContain("Generating names… 40 of 100"); expect(host.textContent).not.toMatch(/Generate \d+|Regenerate|Load more|\$/);
    const stopButton = [...host.querySelectorAll("button")].find(button => button.textContent === "Stop")!;
    await act(async () => stopButton.click()); expect(stop).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
it("keeps compact cards to the name while full cards label brainstorm results honestly, retaining favorite controls",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const context=contextSnapshotSchema.parse({description:"Synthetic unchecked presentation"}),ownerId="a0000000-0000-4000-8000-000000000001",projectId="b0000000-0000-4000-8000-000000000001",candidateId="c0000000-0000-4000-8000-000000000001",createdAt="2026-10-29T18:00:00Z";
 const entry:ProjectNameEntry={candidate:{id:candidateId,ownerId,projectId,value:"Juniper",identityKey:nameIdentityKey("Juniper"),rationale:"A proposed nature association.",caution:NAMING_BRAINSTORM_CAUTION,verificationNotes:[],contextRevision:1,strategyBasis:namingStrategyBasis(context),strategyKey:namingStrategyKey(context),createdAt,origin:{kind:"brainstorm",version:1,profile:"brainstorm_v1",ownerId,projectId,candidateId,contextRevision:1,value:"Juniper",batchId:candidateId,jobId:candidateId,runId:candidateId,callId:candidateId,responseId:"resp_synthetic",requestId:null,model:"synthetic-model",generatedAt:createdAt}},retention:{ownerId,projectId,candidateId,revision:0,favorite:false,saved:false,updatedAt:null}};
 const favorite=vi.fn(),host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
  for(const compact of [true,false]){
   await act(async()=>root.render(createElement(ProjectNameCard,{entry,compact,selected:false,earlierContext:false,pending:false,blockSelection:false,onFavorite:favorite,onSave:vi.fn(),onSelect:vi.fn(),onInspect:vi.fn()})));
   // Compact cards show only the name, its .com status and the heart (user request,
   // 2026-11-06); the full card and the Details dialog keep the unchecked label.
   if(compact)expect(host.textContent).not.toContain("Unchecked brainstorm");else expect(host.textContent).toContain("Unchecked brainstorm");
   expect(host.textContent).not.toMatch(/Verified origin|Researched etymology|Curator approved/);
   await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Favorite Juniper"]')!.click());
  }
  expect(favorite).toHaveBeenCalledTimes(2);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it.each([
 [{kind:"stopped",message:"Stopped. 40 names saved."},"Stopped. 40 names saved.",[]],
 [{kind:"failed",message:"Name generation was interrupted before it started. Try again."},"Name generation was interrupted before it started. Try again.",["Try again"]],
 [{kind:"error",message:"Name generation couldn’t be confirmed. Try again."},"Name generation couldn’t be confirmed. Try again.",["Try again"]],
 [{kind:"unavailable",message:"AI name generation is unavailable right now."},"AI name generation is unavailable right now.",["Check again"]],
 [{kind:"idle"},"",[]],
] as const)("shows plain generation status %# with only its own action",async(status,text,buttons)=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const retry=vi.fn(async()=>true),feed={status,canStop:false,stop:vi.fn(),retry,refresh:vi.fn()} as unknown as NamingFeed;
 const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(NamingFeedStatus,{feed,blocked:false})));
  expect(host.textContent).toBe(text+buttons.join(""));
  expect([...host.querySelectorAll("button")].map(button=>button.textContent)).toEqual(buttons);
  if(buttons[0]==="Try again"){await act(async()=>host.querySelector("button")!.click());expect(retry).toHaveBeenCalledOnce();}
  expect(host.textContent).not.toMatch(/\$|reconciliation|prepared|unresolved|Resume/);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
