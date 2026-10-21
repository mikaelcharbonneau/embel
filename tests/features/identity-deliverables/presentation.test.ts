// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
vi.mock("server-only",()=>({}));
import { approvedExportFixture, id } from "./fixtures";
import { DeliverablesView } from "@/features/identity-deliverables/components/deliverables-panel";
import type { LogoExportsController } from "@/features/identity-deliverables/components/use-logo-exports";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoDeliverablesOverview } from "@/domain/logo-deliverables";
import { syntheticLogoWorkspace } from "../../fixtures/logo-creation";
import { installDialogMethods } from "../../helpers/dialog-methods";
let restoreDialogs: () => void;
beforeEach(() => { restoreDialogs = installDialogMethods(); });
let root:Root|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;restoreDialogs();document.body.replaceChildren();vi.unstubAllGlobals();});
function controller(extra:Partial<LogoExportsController>={}):LogoExportsController {return {workspace:null,overview:null,variantSetId:null,selectedOptions:{pngLongEdge:2048,socialSelections:[]},pendingRequestKey:null,requestState:null,loading:false,error:null,canRead:true,canPrepare:false,canExport:false,blockedReason:"Approve a logo and identity direction first.",downloadMessage:null,refresh:vi.fn(async()=>{}),prepareVariants:vi.fn(async()=>{}),reviewVariants:vi.fn(async()=>{}),request:vi.fn(async()=>{}),retryOriginalExport:vi.fn(async()=>{}),reconcile:vi.fn(async()=>{}),download:vi.fn(async()=>{}),selectOptions:vi.fn(),checkRequest:vi.fn(async()=>{}),loadMore:vi.fn(async()=>{}),...extra};}
async function mount(c:LogoExportsController){vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const container=document.createElement("div");document.body.append(container);root=createRoot(container);await act(async()=>{root!.render(createElement(DeliverablesView,{controller:c,client:{previewAsset:async()=>null} as unknown as AccountLogoClient}));});return container;}
describe("deliverables mounted controls",()=>{
 it.each(["loading","error"] as const)("qualifies retained file approvals during %s",async state=>{
  const snapshot=await approvedExportFixture();
  const workspace={...syntheticLogoWorkspace(),ownerId:snapshot.ownerId,projectId:snapshot.projectId,approvedLogo:snapshot.logoApproval,staleStages:[]};
  const overview:LogoDeliverablesOverview={ownerId:snapshot.ownerId,projectId:snapshot.projectId,logoApproval:snapshot.logoApproval,directionApproval:snapshot.directionApproval,variantSets:[snapshot.variants],variantReviews:[snapshot.variantReview],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
  const c=controller({workspace,overview,variantSetId:snapshot.variants.id,loading:state==="loading",error:state==="error"?"Synthetic check failed":null}),container=await mount(c);
  const summary=container.querySelector("h3")!.closest("section")!;
  expect(summary.textContent).toContain("Check saved brand file approvals");
  expect(summary.textContent).toContain("Approved at last check");
  expect(summary.textContent).not.toContain("Ready to create brand files");
  expect(summary.querySelector("a")).toBeNull();expect(c.request).not.toHaveBeenCalled();
 });
 it("shows missing approvals and the direct review route before the export options sheet",async()=>{
  const workspace={...syntheticLogoWorkspace(),approvedLogo:null,staleStages:[]};
  const overview:LogoDeliverablesOverview={ownerId:workspace.ownerId,projectId:workspace.projectId,logoApproval:null,directionApproval:null,variantSets:[],variantReviews:[],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
  const c=controller({workspace,overview}),container=await mount(c);
  expect(container.querySelector("h3")!.textContent).toBe("Start with an approved logo");
  const review=container.querySelector<HTMLAnchorElement>(`a[href="/brands/account/${workspace.projectId}/logo/vector"]`);
  expect(review?.textContent).toBe("Review vector logo");
  const options=container.querySelector("select")!,disclosure=options.closest("dialog")!;
  expect(disclosure.open).toBe(false);expect(disclosure.querySelector("h2")!.textContent).toBe("Preview formats and export options");
  expect(container.querySelector("details,summary")).toBeNull();
  expect(review!.compareDocumentPosition(disclosure)&Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(container.textContent).toContain("A selected image preview is separate from approval");
  expect(c.prepareVariants).not.toHaveBeenCalled();expect(c.request).not.toHaveBeenCalled();
 });
 it("keeps initial unknown approvals honest and retains the mounted option controls during refresh",async()=>{
  const c=controller({loading:true}),container=await mount(c);
  expect(container.querySelector("h3")!.textContent).toBe("Check your brand file prerequisites");
  const summary=container.querySelector("h3")!.closest("section")!;
  expect(summary.textContent).toContain("Checking saved approvals");expect(summary.textContent).not.toContain("Not approved");
  const select=container.querySelector("select"),disclosure=select!.closest("dialog")!;
  await act(async()=>container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click());
  await act(async()=>root!.render(createElement(DeliverablesView,{controller:{...c,loading:false,error:"Synthetic read failed"},client:{previewAsset:async()=>null} as unknown as AccountLogoClient})));
  expect(container.querySelector("select")).toBe(select);expect(select!.closest("dialog")).toBe(disclosure);expect(disclosure.open).toBe(true);
  expect(summary.textContent).toContain("Saved approval status has not been confirmed");expect(summary.textContent).not.toContain("Ready to create");
  expect(c.request).not.toHaveBeenCalled();
 });
 it("routes an approved logo to identity review and keeps export gates unchanged",async()=>{
  const snapshot=await approvedExportFixture();
  const workspace={...syntheticLogoWorkspace(),ownerId:snapshot.ownerId,projectId:snapshot.projectId,approvedLogo:snapshot.logoApproval,staleStages:[]};
  const overview:LogoDeliverablesOverview={ownerId:snapshot.ownerId,projectId:snapshot.projectId,logoApproval:snapshot.logoApproval,directionApproval:null,variantSets:[],variantReviews:[],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
  const c=controller({workspace,overview}),container=await mount(c);
  expect(container.querySelector("h3")!.textContent).toBe("Approve an identity direction");
  expect(container.querySelector(`a[href="/brands/account/${snapshot.projectId}/logo/directions"]`)?.textContent).toBe("Review identity direction");
  expect([...container.querySelectorAll("button")].find(b=>b.textContent==="Create brand files")?.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].find(b=>b.textContent==="Prepare variants")?.disabled).toBe(true);
 });
 it.each(["vector","directions"] as const)("puts a stale %s approval before retained variant review without enabling export",async stage=>{
  const snapshot=await approvedExportFixture();
  const workspace={...syntheticLogoWorkspace(),ownerId:snapshot.ownerId,projectId:snapshot.projectId,approvedLogo:snapshot.logoApproval,staleStages:[{stage,reasons:["Synthetic changed inputs"]}]};
  const overview:LogoDeliverablesOverview={ownerId:snapshot.ownerId,projectId:snapshot.projectId,logoApproval:snapshot.logoApproval,directionApproval:snapshot.directionApproval,variantSets:[snapshot.variants],variantReviews:[snapshot.variantReview],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
  const c=controller({workspace,overview,variantSetId:snapshot.variants.id}),container=await mount(c);
  expect(container.querySelector("h3")!.textContent).toBe(stage==="vector"?"Review your changed logo":"Review your identity direction");
  expect(container.textContent).toContain("Not prepared for current approvals");
  expect(container.textContent).toContain("Review logo variants");
  expect([...container.querySelectorAll("button")].find(b=>b.textContent==="Create brand files")?.disabled).toBe(true);
  expect(c.prepareVariants).not.toHaveBeenCalled();expect(c.request).not.toHaveBeenCalled();
 });
 it("only describes files as ready to create when the authoritative export gate is open",async()=>{
  const snapshot=await approvedExportFixture();
  const workspace={...syntheticLogoWorkspace(),ownerId:snapshot.ownerId,projectId:snapshot.projectId,approvedLogo:snapshot.logoApproval,staleStages:[]};
  const overview:LogoDeliverablesOverview={ownerId:snapshot.ownerId,projectId:snapshot.projectId,logoApproval:snapshot.logoApproval,directionApproval:snapshot.directionApproval,variantSets:[snapshot.variants],variantReviews:[snapshot.variantReview],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
  const c=controller({workspace,overview,variantSetId:snapshot.variants.id,canPrepare:true,canExport:true,blockedReason:null}),container=await mount(c);
  expect(container.querySelector("h3")!.textContent).toBe("Ready to create brand files");
  expect(container.textContent).toContain("Creating files is a separate action below");
  expect(c.request).not.toHaveBeenCalled();
  await act(async()=>root!.render(createElement(DeliverablesView,{controller:{...c,canExport:false,blockedReason:"Synthetic export service unavailable"},client:{previewAsset:async()=>null} as unknown as AccountLogoClient})));
  expect(container.querySelector("h3")!.textContent).toBe("Check brand file preparation");
  expect(container.querySelector("h3")!.closest("section")!.textContent).toContain("Synthetic export service unavailable");
  expect([...container.querySelectorAll("button")].find(b=>b.textContent==="Create brand files")?.disabled).toBe(true);
 });
 it("lists real required formats, default guidelines and initially unchecked social choices",async()=>{const c=controller(),container=await mount(c);expect(container.textContent).toContain("SVG, vector PDF and transparent PNG");expect(container.textContent).toContain("Brand guidelines PDF");expect(container.textContent).toContain(c.blockedReason);const checks=[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];expect(checks).toHaveLength(2);expect(checks.every(input=>!input.checked)).toBe(true);expect([...container.querySelectorAll('button')].find(b=>b.textContent==="Create brand files")?.disabled).toBe(true);});
 it("retains the original recovery identity and has no automatic request",async()=>{const c=controller({pendingRequestKey:"96000000-0000-4000-8000-000000000005"}),container=await mount(c);expect(container.textContent).toContain("original request");expect(c.request).not.toHaveBeenCalled();await act(async()=>{[...container.querySelectorAll('button')].find(b=>b.textContent==="Check original export")!.click();});expect(c.reconcile).toHaveBeenCalledOnce();expect(c.request).not.toHaveBeenCalled();});
 it("hides all private controls until the matching account is verified",async()=>{const container=await mount(controller({canRead:false}));expect(container.textContent).toContain("Sign in");expect(container.querySelectorAll('input,select')).toHaveLength(0);});
 it.each(["logo","direction"] as const)("offers replacement variants after a changed %s approval without removing history",async changed=>{
  const snapshot=await approvedExportFixture(),historical=JSON.stringify(snapshot.variants);
  const logoApproval=changed==="logo"?{...snapshot.logoApproval,id:id(701)}:snapshot.logoApproval;
  const directionApproval={...snapshot.directionApproval,id:id(702),approvedLogoId:logoApproval.id};
  const overview={ownerId:snapshot.ownerId,projectId:snapshot.projectId,logoApproval,directionApproval,variantSets:[snapshot.variants],variantReviews:[snapshot.variantReview],exports:[],exportRequests:[],nextCursor:null,nextRequestCursor:null};
  const c=controller({overview,variantSetId:snapshot.variants.id,canPrepare:true,blockedReason:"The saved approvals changed."}),container=await mount(c);
  const replacement=[...container.querySelectorAll('button')].find(button=>button.textContent==="Prepare replacement variants");
  expect(replacement).toBeDefined();expect(replacement!.disabled).toBe(false);expect(container.textContent).toContain("Review logo variants");
  await act(async()=>replacement!.click());expect(c.prepareVariants).toHaveBeenCalledOnce();expect(c.request).not.toHaveBeenCalled();expect(JSON.stringify(snapshot.variants)).toBe(historical);
 });
});
