import { describe, expect, it } from "vitest";
import { fontPurposeAllowed } from "@/features/identity-directions/model/font-rights";
import { fontFixture } from "./fixtures";
describe("individually evidenced font purposes",()=>{
 it("free commercial use does not grant other permissions",()=>{const f=fontFixture();f.rights.permissions={render:"allowed",outline:"unknown",embed:"unknown",modify:"denied",redistribute:"denied"};expect(fontPurposeAllowed(f,"render")).toBe(true);for(const purpose of ["outline","embed","modify","redistribute"] as const)expect(fontPurposeAllowed(f,purpose)).toBe(false);});
 it("unreviewed upload declarations cannot unlock font use",()=>{const f=fontFixture();f.source="user_upload";f.rights.sourceKind="user_declaration";f.rights.reviewedAt=null;expect(fontPurposeAllowed(f,"render")).toBe(false);});
 it("changed bytes invalidate rights",()=>{const f=fontFixture();f.asset.contentHash="f".repeat(64);expect(fontPurposeAllowed(f,"outline")).toBe(false);});
});
