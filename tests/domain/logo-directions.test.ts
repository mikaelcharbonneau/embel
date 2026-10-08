import { describe, expect, it } from "vitest";
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId=id(1), projectId=id(2), at="2026-10-06T12:00:00Z", hash="a".repeat(64);
import { logoDirectionBatchSchema, colorSpecificationSchema, fontRightsEvidenceSchema, identityDirectionSelectionSchema } from "../../src/domain/logo-directions";
const color=()=>({hex:"#FF0000",rgb:[255,0,0],cmyk:{status:"unavailable",reason:"profile_unavailable"},pantone:{status:"unavailable",reason:"licensed_source_unavailable"}});
const basis=(n:number)=>({id:id(n),ownerId,projectId,approvedLogoId:id(3),inputRevisions:[]});
const batch=()=>({directions:[0,1,2].map(i=>({...basis(10+i),name:`Direction ${i}`,paletteVersionId:id(20+i),typographyVersionId:id(30+i),graphicsVersionId:id(40+i)})),palettes:[0,1,2].map(i=>({...basis(20+i),swatches:[{key:"primary",name:"Red",color:color()}],pairings:[]})),typography:[0,1,2].map(i=>({...basis(30+i),styles:[{key:"body",role:"body",sampleText:"Brand specimen",fontVersionId:id(50),weight:400,style:"normal",sizePx:16,lineHeight:1.5}]})),graphics:[0,1,2].map(i=>({...basis(40+i),elements:[{kind:"dots",paletteKey:"primary",radius:2,spacing:10}]}))});
describe("three post-logo directions",()=>{
 it("requires exactly three uniquely cross-bound directions",()=>{const b=batch();expect(logoDirectionBatchSchema.safeParse(b).success).toBe(true);expect(logoDirectionBatchSchema.safeParse({...b,directions:b.directions.slice(0,2)}).success).toBe(false);expect(logoDirectionBatchSchema.safeParse({...b,directions:b.directions.map(d=>({...d,paletteVersionId:id(20)}))}).success).toBe(false);expect(logoDirectionBatchSchema.safeParse({...b,palettes:b.palettes.map((p,i)=>i? p:{...p,ownerId:id(99)})}).success).toBe(false);});
 it("keeps color channels consistent and unavailable print sources honest",()=>{expect(colorSpecificationSchema.safeParse(color()).success).toBe(true);expect(colorSpecificationSchema.safeParse({...color(),rgb:[0,0,0]}).success).toBe(false);expect(colorSpecificationSchema.safeParse({...color(),pantone:{status:"approximate",reference:"P",sourceId:"",sourceHash:hash,limitations:[]}}).success).toBe(false);});
 it("tracks commercial use and each font permission independently",()=>{const rights={id:id(4),fontContentHash:hash,sourceKind:"user_declaration",sourceUrl:null,licenseTextHash:hash,permissions:{render:"allowed",outline:"allowed",embed:"denied",modify:"denied",redistribute:"unknown"},commercialUse:"allowed",reviewedAt:null};expect(fontRightsEvidenceSchema.safeParse(rights).success).toBe(true);expect(fontRightsEvidenceSchema.safeParse({...rights,sourceKind:"reviewed_license"}).success).toBe(false);expect(fontRightsEvidenceSchema.safeParse({...rights,paid:true}).success).toBe(false);});
 it("separates a component selection from approval",()=>{const selection={...basis(60),paletteVersionId:id(20),typographyVersionId:id(31),graphicsVersionId:id(42),sourceDirectionIds:[id(10),id(11),id(12)],consistency:{hash,status:"pass",checks:[],warnings:[],blockingReasons:[]}};expect(identityDirectionSelectionSchema.safeParse(selection).success).toBe(true);expect(identityDirectionSelectionSchema.safeParse({...selection,approved:true}).success).toBe(false);});
});

describe("direction source refinements",()=>{
 it("rejects a direction whose component input revisions differ",()=>{const b=batch();expect(logoDirectionBatchSchema.safeParse({...b,palettes:b.palettes.map((p,i)=>i?p:{...p,inputRevisions:[{stage:"brief_references",id:id(90),revision:1}]})}).success).toBe(false);});
 it("does not turn a user declaration into a reviewed license",()=>{const rights={id:id(4),fontContentHash:hash,sourceKind:"user_declaration",sourceUrl:"https://example.com/license",licenseTextHash:hash,permissions:{render:"allowed",outline:"unknown",embed:"unknown",modify:"denied",redistribute:"denied"},commercialUse:"allowed",reviewedAt:at};expect(fontRightsEvidenceSchema.safeParse(rights).success).toBe(false);expect(fontRightsEvidenceSchema.safeParse({...rights,sourceKind:"reviewed_license"}).success).toBe(true);});
});

describe("frozen typography specimen and derived consistency severity",()=>{
 it("requires an exact bounded sample on each typography style",()=>{
  const b=batch();
  for(const t of b.typography)Object.assign(t.styles[0]!,{sampleText:"Exact brand specimen"});
  expect(logoDirectionBatchSchema.safeParse(b).success).toBe(true);
  delete (b.typography[0]!.styles[0] as Record<string,unknown>).sampleText;
  expect(logoDirectionBatchSchema.safeParse(b).success).toBe(false);
 });
 it("rejects a pass label when a retained check blocks approval",()=>{
  const selection={...basis(60),paletteVersionId:id(20),typographyVersionId:id(31),graphicsVersionId:id(42),sourceDirectionIds:[id(10)],consistency:{hash,status:"blocked",checks:[{id:"font",code:"font_permission",role:"body",status:"blocked",message:"Outline permission unknown"}],warnings:[],blockingReasons:["Outline permission unknown"]}};
  expect(identityDirectionSelectionSchema.safeParse(selection).success).toBe(true);
  expect(identityDirectionSelectionSchema.safeParse({...selection,consistency:{...selection.consistency,status:"pass"}}).success).toBe(false);
 });
});
