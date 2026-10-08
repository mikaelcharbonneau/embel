import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FontRecord, IdentityDirectionsOverview } from "@/domain/logo-directions";
export const id = (n: number) => `64000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ownerId = id(1), projectId = id(2);
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const fontBytes = () => new Uint8Array(readFileSync("node_modules/geist/dist/fonts/geist-sans/Geist-Variable.ttf"));
export const licenseText = () => readFileSync("node_modules/geist/LICENSE.txt", "utf8");
export function fontFixture(): FontRecord {
 const hash=digest(fontBytes());
 return {id:id(50),asset:{ownerId,projectId,assetId:id(51),versionId:id(52),contentHash:hash},family:"Geist",source:"free_catalog",rights:{id:id(53),fontContentHash:hash,sourceKind:"reviewed_license",sourceUrl:"https://github.com/vercel/geist-font/blob/main/OFL.txt",licenseTextHash:digest(licenseText()),commercialUse:"allowed",permissions:{render:"allowed",outline:"allowed",embed:"allowed",modify:"allowed",redistribute:"allowed"},reviewedAt:"2026-10-07T00:00:00Z"}};
}
const color=(hex:string)=>({hex,rgb:[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)] as [number,number,number],cmyk:{status:"unavailable" as const,reason:"profile_unavailable" as const},pantone:{status:"unavailable" as const,reason:"licensed_source_unavailable" as const}});
export function directionFixture(): IdentityDirectionsOverview {
 const basis=(n:number)=>({id:id(n),ownerId,projectId,approvedLogoId:id(3),inputRevisions:[]});
 return {ownerId,projectId,currentApprovedLogo:{id:id(3),ownerId,projectId,vectorRevisionId:id(4),stageRevisionId:id(5),approvedAt:"2026-10-06T12:00:00Z"},directions:[0,1,2].map(n=>({...basis(10+n),name:`Synthetic direction ${n+1}`,paletteVersionId:id(20+n),typographyVersionId:id(30+n),graphicsVersionId:id(40+n)})),palettes:[0,1,2].map(n=>({...basis(20+n),swatches:[{key:"ink",name:"Ink",color:color("#191919")},{key:"paper",name:"Paper",color:color("#FFFFFF")}],pairings:[{foregroundKey:"ink",backgroundKey:"paper",role:"body"}]})),typography:[0,1,2].map(n=>({...basis(30+n),styles:[{key:"body",role:"body",fontVersionId:id(50),sampleText:"Fluid studio 123",weight:400,style:"normal",sizePx:16,lineHeight:1.5}]})),graphics:[0,1,2].map(n=>({...basis(40+n),elements:[{kind:"dots",paletteKey:"ink",radius:2,spacing:12}]})),fonts:[fontFixture()],fontChecks:[],selection:null,approval:null,stale:false,nextCursor:null};
}
