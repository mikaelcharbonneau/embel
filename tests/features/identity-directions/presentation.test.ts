import { describe,expect,it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectionCard } from "@/features/identity-directions/components/direction-card";
import { IdentityDirectionsView } from "@/features/identity-directions/components/identity-directions-panel";
import type { IdentityDirectionsController } from "@/features/identity-directions/components/use-identity-directions";
import { separatedLogoDocument } from "../logo-vector/fixtures";
import { syntheticLogoWorkspace } from "../../fixtures/logo-creation";
import { directionFixture, id } from "./fixtures";
describe("identity direction presentation",()=>{
 it("shows actual unchanged logo geometry, exact colors and explicit print limits",()=>{const o=directionFixture();const markup=renderToStaticMarkup(createElement(DirectionCard,{direction:o.directions[0]!,palette:o.palettes[0]!,typography:o.typography[0]!,graphics:o.graphics[0]!,fonts:o.fonts,selectedParts:[],stale:false,approvedLogoDocument:separatedLogoDocument(),onChoose:()=>{}}));expect(markup).toContain("Approved logo, unchanged");expect(markup).toContain("<path");expect(markup).toContain("Choose Synthetic direction 1");expect(markup).toContain("RGB 25, 25, 25");expect(markup).toContain("CMYK unavailable");expect(markup).toContain("Pantone unavailable");expect(markup).toContain("Fluid studio 123");});
 it("links the logo approval gate to vector review without exposing generation or mix controls",()=>{const workspace={...syntheticLogoWorkspace(),approvedLogo:null,staleStages:[]};const controller={workspace,canRead:true,loading:false,overview:null,draft:null,pendingRequestKey:null,directionIds:[],error:null} as unknown as IdentityDirectionsController;const markup=renderToStaticMarkup(createElement(IdentityDirectionsView,{controller}));expect(markup).toContain("Start with an approved logo");expect(markup).toContain("Selecting an image preview does not approve it");expect(markup).toContain(`href="/brands/account/${workspace.projectId}/logo/vector"`);expect(markup).toContain("Review vector logo");expect(markup).not.toContain("/logo/editor");expect(markup).not.toContain("Generate directions");expect(markup).not.toContain("Save mix");});
 it("does not expose the approval link before the workspace is readable",()=>{
  const workspace={...syntheticLogoWorkspace(),approvedLogo:null,staleStages:[]};const controller={workspace,canRead:false,loading:false,overview:null,draft:null,pendingRequestKey:null,directionIds:[],error:null} as unknown as IdentityDirectionsController;
  const markup=renderToStaticMarkup(createElement(IdentityDirectionsView,{controller}));
  expect(markup).toContain("Sign in to view your identity directions");expect(markup).not.toContain("/logo/vector");expect(markup).not.toContain("Review vector logo");
 });
 it("does not render a new approval's logo as the artwork for an older direction",()=>{
  const overview=directionFixture();
  const controller={workspace:{...syntheticLogoWorkspace(),approvedLogo:{...overview.currentApprovedLogo!,id:id(999)},staleStages:[{stage:"directions"}]},canRead:true,loading:false,overview,draft:null,pendingRequestKey:null,directionIds:overview.directions.map(d=>d.id),error:null,approvedLogoDocument:separatedLogoDocument(),generation:null,history:{overview:null,loading:false,error:null,canLoadMore:false,canLoadPrevious:false}} as unknown as IdentityDirectionsController;
  const markup=renderToStaticMarkup(createElement(IdentityDirectionsView,{controller}));
  expect(markup).toContain("Earlier inputs");expect(markup).not.toContain("<path");expect(markup).toContain("Logo preview unavailable");
 });
 it("offers a separate explicit original save retry beside the read-only check",()=>{
  const overview=directionFixture();
  const controller={workspace:{...syntheticLogoWorkspace(),approvedLogo:overview.currentApprovedLogo,staleStages:[]},canRead:true,loading:false,overview,draft:null,pendingRequestKey:id(100),pendingRequestKind:"save",canRetryRequest:true,directionIds:[],error:null,generation:null,history:{overview:null,loading:false,error:null,canLoadMore:false,canLoadPrevious:false}} as unknown as IdentityDirectionsController;
  const markup=renderToStaticMarkup(createElement(IdentityDirectionsView,{controller}));
  expect(markup).toContain("Check saved request");expect(markup).toContain("Retry original save");expect(markup).toContain("same request");
 });
 it("retains recovery controls even if the current logo was removed",()=>{
  const controller={workspace:{...syntheticLogoWorkspace(),approvedLogo:null,staleStages:[]},canRead:true,loading:false,overview:null,draft:null,pendingRequestKey:id(100),pendingRequestKind:"approval",canRetryRequest:true,directionIds:[],error:null} as unknown as IdentityDirectionsController;
  const markup=renderToStaticMarkup(createElement(IdentityDirectionsView,{controller}));
  expect(markup).toContain("Check saved request");expect(markup).toContain("Retry original approval");
 });
});
