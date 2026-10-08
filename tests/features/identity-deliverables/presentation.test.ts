// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
vi.mock("server-only",()=>({}));
import { approvedExportFixture, id } from "./fixtures";
import { DeliverablesView } from "@/features/identity-deliverables/components/deliverables-panel";
import type { LogoExportsController } from "@/features/identity-deliverables/components/use-logo-exports";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
let root:Root|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;vi.unstubAllGlobals();});
function controller(extra:Partial<LogoExportsController>={}):LogoExportsController {return {workspace:null,overview:null,variantSetId:null,selectedOptions:{pngLongEdge:2048,socialSelections:[]},pendingRequestKey:null,requestState:null,loading:false,error:null,canRead:true,canPrepare:false,canExport:false,blockedReason:"Approve a logo and identity direction first.",downloadMessage:null,refresh:vi.fn(async()=>{}),prepareVariants:vi.fn(async()=>{}),reviewVariants:vi.fn(async()=>{}),request:vi.fn(async()=>{}),retryOriginalExport:vi.fn(async()=>{}),reconcile:vi.fn(async()=>{}),download:vi.fn(async()=>{}),selectOptions:vi.fn(),checkRequest:vi.fn(async()=>{}),loadMore:vi.fn(async()=>{}),...extra};}
async function mount(c:LogoExportsController){vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const container=document.createElement("div");document.body.append(container);root=createRoot(container);await act(async()=>{root!.render(createElement(DeliverablesView,{controller:c,client:{previewAsset:async()=>null} as unknown as AccountLogoClient}));});return container;}
describe("deliverables mounted controls",()=>{
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
