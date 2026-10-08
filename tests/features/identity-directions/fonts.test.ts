import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { inspectFontBytes, inspectTypographySamples } from "@/features/identity-directions/server/font-inspection";
import { createFontResolver, listFreeFontCatalog, readFreeCatalogFont } from "@/features/identity-directions/server/fonts";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { AuthenticatedContext } from "@/server/auth/context";
import { fontFixture,fontBytes,directionFixture,id,licenseText } from "./fixtures";
const auth={userId:id(1)} as AuthenticatedContext;
function resolver(overrides:{bytes?:Uint8Array;license?:string}={}){
 const f=fontFixture(),bytes=overrides.bytes??fontBytes();
 const store={readOwnedAsset:vi.fn(async()=>({reference:f.asset,bytes,mimeType:"font/ttf",verification:{status:"verified",checkedAt:"2026-10-07T00:00:00Z",contentHash:f.asset.contentHash,mimeType:"font/ttf",byteLength:bytes.byteLength}}))} as unknown as IdentityAssetStore;
 return {store,resolve:createFontResolver({loadRecord:async()=>f,store,loadRightsEvidence:async()=>({licenseText:overrides.license??licenseText(),sourceUrl:f.rights.sourceUrl!})})};
}
describe("real licensed font inspection and resolution",()=>{
 it("inspects actual TTF metadata and exact specimen without fallback",async()=>{const data=await inspectFontBytes(fontBytes(),"font/ttf");expect(data.family).toMatch(/Geist/);expect(data.codePoints).toContain(65);expect(data.variations.wght).toMatchObject({min:100,max:900});const t=directionFixture().typography[0]!;const checks=await inspectTypographySamples({record:fontFixture(),bytes:fontBytes(),contentHash:fontFixture().asset.contentHash,purpose:"render"},t.styles.map(s=>({...s,typographyVersionId:t.id,styleKey:s.key,text:s.sampleText+String.fromCodePoint(0x10ffff)})));expect(checks[0]).toMatchObject({styleSupported:true,missingCodePoints:[0x10ffff]});expect(checks[0]!.sampleHash).toMatch(/^[a-f0-9]{64}$/);});
 it("rejects malformed oversized and unsupported font containers",async()=>{await expect(inspectFontBytes(new Uint8Array(10_485_761),"font/ttf")).rejects.toThrow();await expect(inspectFontBytes(new Uint8Array([0,1,0,0,0]),"font/ttf")).rejects.toThrow();await expect(inspectFontBytes(fontBytes(),"font/woff2")).rejects.toThrow();});
 it("foreign or hash changed font never reaches the shaper",async()=>{const foreign=resolver();await expect(foreign.resolve({...auth,userId:id(99)},id(50),"outline")).rejects.toMatchObject({code:"not_found"});expect(foreign.store.readOwnedAsset).not.toHaveBeenCalled();await expect(resolver({bytes:new Uint8Array([1,2,3])}).resolve(auth,id(50),"outline")).rejects.toMatchObject({code:"not_found"});});
 it("verifies actual license bytes before allowing any purpose",async()=>{await expect(resolver({license:"different license"}).resolve(auth,id(50),"render")).rejects.toMatchObject({code:"not_found"});const f=await resolver().resolve(auth,id(50),"outline");expect(f.contentHash).toBe(fontFixture().asset.contentHash);expect(f.purpose).toBe("outline");});
 it("catalog returns exact reviewed font and license hashes",async()=>{const catalog=await listFreeFontCatalog();expect(catalog.length).toBeGreaterThanOrEqual(2);for(const item of catalog){const f=await readFreeCatalogFont(item.id);expect(f.contentHash).toBe(item.rights.fontContentHash);expect(f.licenseText.length).toBeGreaterThan(4000);expect(item.rights.permissions.redistribute).toBe("allowed");expect(f.conditions).toContain("Include the copyright notice and OFL license with redistributed font software.");}});
});
