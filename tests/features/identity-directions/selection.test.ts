import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { verifyDirectionSelection } from "@/features/identity-directions/server/selection";
import { directionFixture,id,fontBytes } from "./fixtures";
import { inspectTypographySamples } from "@/features/identity-directions/server/font-inspection";
const expected={projectRevision:1,referenceRevision:1,preferencesRevision:0,workspaceRevision:3,stageRevisions:{brief_references:1,concepts:1,vector:1,refinements:0,directions:0,deliverables:0}};
it("the server recomputes exact component checks and rejects stale logo basis",async()=>{const o=directionFixture(),f=o.fonts[0]!;o.fontChecks=[...await inspectTypographySamples({record:f,bytes:fontBytes(),contentHash:f.asset.contentHash,purpose:"render"},o.typography.flatMap(t=>t.styles.map(s=>({...s,typographyVersionId:t.id,styleKey:s.key,text:s.sampleText}))))];const request={requestKey:id(100),expected,approvedLogoId:id(3),paletteVersionId:id(20),typographyVersionId:id(31),graphicsVersionId:id(42)};expect((await verifyDirectionSelection({overview:o,request})).status).toBe("pass");await expect(verifyDirectionSelection({overview:o,request:{...request,approvedLogoId:id(99)}})).rejects.toMatchObject({code:"conflict"});o.fontChecks=[];await expect(verifyDirectionSelection({overview:o,request})).rejects.toMatchObject({code:"integration_unavailable"});});
