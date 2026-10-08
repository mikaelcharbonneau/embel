import { describe, expect, it } from "vitest";
import {
  assetDetailQuerySchema, assetDetailSchema, assetFormatFromMime, assetLibraryItemSchema, assetLibraryPageSchema,
  assetLibraryQuerySchema, assetRecordSchema, assetRetentionResponseSchema, assetRevisionFreshness,
  assetSelectionResponseSchema, assetVersionDetailSchema, assetVersionPageSchema, assetVersionReferenceSchema,
  isAssetRetained, selectAssetVersionSchema, setAssetRetentionSchema,
} from "../../src/domain/asset-library";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId=id(1), projectId=id(2), assetId=id(3), versionId=id(4), at="2026-10-04T12:00:00.123456Z";
const hash="a".repeat(64);
const project=()=>({id:projectId,owner_id:ownerId,title:"Owned fixture",scope:"complete_brand",current_revision:2,created_at:at});
const version=(n=4,mimeType="image/png")=>({assetId,versionId:id(n),ownerId,projectId,contentHash:hash,versionNumber:n-3,inputRevision:1,inputHash:hash,createdAt:at,mimeType,format:assetFormatFromMime(mimeType),
  provenance:{status:"legacy_unverified"},vectorStatus:"unverified",licenseStatus:"unverified",fileState:"unverified",fileVerification:null,freshness:assetRevisionFreshness(1,2)});
const asset=()=>({id:assetId,ownerId,projectId,kind:"logo",purpose:"legacy_unknown",createdAt:at,versionCount:1,retentionRevision:0,liked:false,saved:false,usage:{active:false,legacy:true},selectionRevision:0,currentSelection:null});
const page=()=>({ownerId,projectId,assetId,format:null,items:[version()],totalCount:1,nextCursor:null});
const item=()=>({asset:asset(),project:project(),selectedVersion:null,displayedVersion:version(),matchingVersions:page()});
const selection=()=>({id:id(8),ownerId,projectId,assetId,versionId,reason:"restored",createdAt:at,receipt:{status:"recorded",projectRevision:2,acceptedStaleBasis:true,previousSelectionId:null}});

describe("owned Assets queries and mutation intents",()=>{
  it("defaults to retained logical assets and binds every cursor to the actual filter",()=>{
    expect(assetLibraryQuerySchema.parse({})).toEqual({tab:"my_selection",limit:40});
    const cursor={createdAt:at,assetId,tab:"my_selection",projectId,format:"png"};
    expect(assetLibraryQuerySchema.safeParse({projectId,format:"png",cursor}).success).toBe(true);
    expect(assetLibraryQuerySchema.safeParse({projectId,format:"jpeg",cursor}).success).toBe(false);
    expect(assetLibraryQuerySchema.safeParse({projectId,format:"png",tab:"all_generations",cursor}).success).toBe(false);
    for(const value of [{limit:101},{limit:0},{ownerId},{format:"invented"}])expect(assetLibraryQuerySchema.safeParse(value).success).toBe(false);
    const versionCursor={createdAt:at,versionId,assetId,projectId,format:"png"};
    expect(assetDetailQuerySchema.safeParse({format:"png",cursor:versionCursor}).success).toBe(true);
    expect(assetDetailQuerySchema.safeParse({cursor:versionCursor}).success).toBe(false);
  });
  it("accepts only expected revisions and the user's actual choices",()=>{
    const retention={expectedRetentionRevision:0,liked:true,saved:false};
    const restore={versionId,expectedProjectRevision:2,expectedSelectionRevision:0,acceptStaleBasis:true};
    expect(setAssetRetentionSchema.parse(retention)).toEqual(retention);
    expect(selectAssetVersionSchema.parse(restore)).toEqual(restore);
    for(const extra of [{ownerId},{used:true},{usage:{active:true,legacy:false}},{purpose:"brand_asset"},{provider:"openai"},{storagePath:"private"},{vectorStatus:"validated_paths"}]){
      expect(setAssetRetentionSchema.safeParse({...retention,...extra}).success).toBe(false);
      expect(selectAssetVersionSchema.safeParse({...restore,...extra}).success).toBe(false);
    }
    expect(selectAssetVersionSchema.safeParse({...restore,expectedProjectRevision:0}).success).toBe(false);
    expect(selectAssetVersionSchema.safeParse({...restore,acceptStaleBasis:"true"}).success).toBe(false);
  });
});

describe("legacy metadata without invented production readiness",()=>{
  it("preserves arbitrary MIME, zero-version assets, long valid legacy titles and legacy-use visibility",()=>{
    expect(assetFormatFromMime("IMAGE/PNG; charset=utf-8")).toBe("png");
    expect(assetFormatFromMime("application/x-custom-brand-format")).toBe("other");
    expect(assetFormatFromMime("constructor")).toBe("other");
    expect(assetFormatFromMime("__proto__")).toBe("other");
    expect(assetVersionDetailSchema.parse(version(4,"application/x-custom-brand-format")).format).toBe("other");
    const empty={...item(),asset:{...asset(),versionCount:0},project:{...project(),title:"x".repeat(200)},displayedVersion:null,matchingVersions:{...page(),items:[],totalCount:0}};
    expect(assetLibraryItemSchema.safeParse(empty).success).toBe(true);
    expect(isAssetRetained(asset())).toBe(true);
    expect(isAssetRetained({...asset(),usage:{active:false,legacy:false}})).toBe(false);
    expect(isAssetRetained({...asset(),liked:true,saved:true,usage:{active:false,legacy:false}})).toBe(true);
    expect(isAssetRetained({...asset(),usage:{active:true,legacy:false}})).toBe(true);
  });
  it("never trusts provider/vector/license claims without a verified creation boundary",()=>{
    const valid=version();expect(assetVersionDetailSchema.safeParse(valid).success).toBe(true);
    for(const changed of [{provenance:{status:"legacy_unverified",provider:"openai"}},{provenance:{status:"provider_generation"}},{vectorStatus:"validated_paths"},{licenseStatus:"verified"},{fileState:"verified"}]){
      expect(assetVersionDetailSchema.safeParse({...valid,...changed}).success).toBe(false);
    }
    const verified={...valid,fileState:"verified",fileVerification:{status:"verified",checkedAt:at,contentHash:hash,mimeType:"image/png",byteLength:256}};
    expect(assetVersionDetailSchema.safeParse(verified).success).toBe(true);
    expect(assetVersionDetailSchema.parse(verified).provenance.status).toBe("legacy_unverified");
    expect(assetVersionDetailSchema.safeParse({...verified,fileVerification:{...verified.fileVerification,contentHash:"b".repeat(64)}}).success).toBe(false);
    expect(assetVersionDetailSchema.safeParse({...verified,fileVerification:{...verified.fileVerification,byteLength:52_428_801}}).success).toBe(false);
    expect(assetVersionDetailSchema.safeParse({...verified,fileVerification:{...verified.fileVerification,mimeType:"image/jpeg"}}).success).toBe(false);
    expect(assetVersionDetailSchema.safeParse({...valid,fileState:"missing_or_invalid",fileVerification:{status:"missing_or_invalid",checkedAt:at}}).success).toBe(true);
    expect(assetVersionDetailSchema.safeParse({...valid,format:"pdf"}).success).toBe(false);
  });
  it("marks revision-only freshness as unknown or conservatively stale, never proven current",()=>{
    expect(assetRevisionFreshness(2,2)).toMatchObject({status:"unknown",basis:"revision_only",reasons:["material_basis_unavailable"]});
    expect(assetRevisionFreshness(1,2)).toMatchObject({status:"stale",reasons:["project_revision_changed","material_basis_unavailable"]});
    expect(()=>assetRevisionFreshness(3,2)).toThrow();
    expect(assetVersionDetailSchema.safeParse({...version(),freshness:{...assetRevisionFreshness(1,2),status:"current"}}).success).toBe(false);
    expect(assetVersionDetailSchema.safeParse({...version(),freshness:assetRevisionFreshness(2,2)}).success).toBe(false);
  });
  it("keeps the reusable immutable media reference extendable and free of paths",()=>{
    const reference={assetId,versionId,ownerId,projectId,contentHash:hash};
    expect(assetVersionReferenceSchema.parse(reference)).toEqual(reference);
    expect(assetVersionReferenceSchema.safeParse({...reference,storagePath:"forged"}).success).toBe(false);
    expect(assetVersionReferenceSchema.shape.contentHash.safeParse(hash).success).toBe(true);
  });
});

describe("version pages, selection heads and owned logical-asset cards",()=>{
  it("keeps the current selection separate from the matching format preview",()=>{
    const chosen=version(5,"image/svg+xml");
    const record={...asset(),versionCount:2,selectionRevision:1,currentSelection:{...selection(),versionId:chosen.versionId,receipt:{status:"legacy_unverified"}}};
    const value={...item(),asset:record,selectedVersion:chosen,matchingVersions:{...page(),format:"png"}};
    expect(assetLibraryItemSchema.safeParse(value).success).toBe(true);
    expect(assetLibraryItemSchema.safeParse({...value,displayedVersion:chosen}).success).toBe(false);
    expect(assetLibraryItemSchema.safeParse({...value,selectedVersion:version()}).success).toBe(false);
    expect(assetRecordSchema.safeParse({...record,selectionRevision:0}).success).toBe(false);
    expect(assetRecordSchema.safeParse({...asset(),selectionRevision:1}).success).toBe(false);
  });
  it("preserves full version history and binds continuations to the exact asset and MIME filter",()=>{
    const cursor={createdAt:at,versionId,assetId,projectId,format:null};
    expect(assetVersionPageSchema.safeParse({...page(),totalCount:2,nextCursor:cursor}).success).toBe(true);
    for(const patch of [{assetId:id(99)},{projectId:id(99)},{format:"png"},{versionId:id(99)},{createdAt:"2026-10-04T12:00:00.123457Z"}]){
      expect(assetVersionPageSchema.safeParse({...page(),totalCount:2,nextCursor:{...cursor,...patch}}).success).toBe(false);
    }
    expect(assetVersionPageSchema.safeParse({...page(),items:[version(),version()]}).success).toBe(false);
    expect(assetVersionPageSchema.safeParse({...page(),format:"pdf"}).success).toBe(false);
    expect(assetDetailSchema.safeParse({asset:asset(),project:project(),selectedVersion:null,versions:page()}).success).toBe(true);
  });
  it("rejects contradictory same-version metadata and impossible filtered counts",()=>{
    const selected={...asset(),selectionRevision:1,currentSelection:{...selection(),receipt:{status:"legacy_unverified"}}};
    expect(assetLibraryItemSchema.safeParse({...item(),asset:selected,selectedVersion:version(),displayedVersion:{...version(),inputHash:"b".repeat(64)}}).success).toBe(false);
    expect(assetDetailSchema.safeParse({asset:selected,project:project(),selectedVersion:version(),versions:{...page(),format:"png",items:[],totalCount:0}}).success).toBe(false);
    expect(assetDetailSchema.safeParse({asset:selected,project:project(),selectedVersion:{...version(),contentHash:"b".repeat(64)},versions:page()}).success).toBe(false);
    const checked={...version(),fileState:"verified",fileVerification:{status:"verified",checkedAt:at,contentHash:hash,mimeType:"image/png",byteLength:256}};
    expect(assetLibraryItemSchema.safeParse({...item(),displayedVersion:checked}).success).toBe(false);
    expect(assetDetailSchema.safeParse({asset:selected,project:project(),selectedVersion:checked,versions:page()}).success).toBe(false);
  });
  it("allows a matching selected old version outside the first four rows and preserves submillisecond timestamps",()=>{
    const older={...version(99),createdAt:"2026-10-04T11:00:00.000001Z"};
    const rows=Array.from({length:4},(_,n)=>({...version(n+10),createdAt:`2026-10-04T12:00:00.12345${9-n}Z`}));
    const last=rows.at(-1)!;
    const matchingVersions={...page(),items:rows,totalCount:5,nextCursor:{assetId,projectId,versionId:last.versionId,createdAt:last.createdAt,format:null}};
    const selected={...asset(),versionCount:5,selectionRevision:1,currentSelection:{...selection(),versionId:older.versionId,receipt:{status:"legacy_unverified"}}};
    const parsed=assetLibraryItemSchema.parse({...item(),asset:selected,selectedVersion:older,displayedVersion:older,matchingVersions});
    expect(parsed.displayedVersion!.versionId).toBe(older.versionId);
    expect(parsed.matchingVersions.nextCursor!.createdAt).toBe(last.createdAt);
    expect(assetLibraryItemSchema.safeParse({...parsed,matchingVersions:{...matchingVersions,items:[...rows,older],nextCursor:null}}).success).toBe(false);
  });
  it("requires first-page continuation exactly when matching history remains",()=>{
    const rows=Array.from({length:4},(_,n)=>version(n+10));
    const last=rows.at(-1)!;
    const cursor={assetId,projectId,versionId:last.versionId,createdAt:last.createdAt,format:null};
    const value={...item(),asset:{...asset(),versionCount:5},displayedVersion:rows[0],matchingVersions:{...page(),items:rows,totalCount:5,nextCursor:null}};
    expect(assetLibraryItemSchema.safeParse(value).success).toBe(false);
    expect(assetLibraryItemSchema.safeParse({...value,matchingVersions:{...value.matchingVersions,nextCursor:cursor}}).success).toBe(true);
    const complete={...value,asset:{...asset(),versionCount:4},matchingVersions:{...value.matchingVersions,totalCount:4}};
    expect(assetLibraryItemSchema.safeParse(complete).success).toBe(true);
    expect(assetLibraryItemSchema.safeParse({...complete,matchingVersions:{...complete.matchingVersions,nextCursor:cursor}}).success).toBe(false);
    expect(assetVersionPageSchema.safeParse({...complete.matchingVersions,nextCursor:cursor}).success).toBe(false);
    // A final detail page describes the full history count, including earlier pages.
    expect(assetDetailSchema.safeParse({asset:value.asset,project:project(),selectedVersion:null,versions:{...page(),totalCount:5}}).success).toBe(true);
  });
  it("counts a separate matching selected version among the actual distinct history",()=>{
    const rows=Array.from({length:4},(_,n)=>version(n+10));
    const chosen=version(99);
    const record={...asset(),versionCount:4,selectionRevision:1,currentSelection:{...selection(),versionId:chosen.versionId,receipt:{status:"legacy_unverified"}}};
    const value={...item(),asset:record,selectedVersion:chosen,displayedVersion:chosen,matchingVersions:{...page(),items:rows,totalCount:4}};
    expect(assetLibraryItemSchema.safeParse(value).success).toBe(false);
    expect(assetDetailSchema.safeParse({asset:record,project:project(),selectedVersion:chosen,versions:value.matchingVersions}).success).toBe(false);
    const selectedSvg={...chosen,mimeType:"image/svg+xml",format:"svg"};
    const filtered={...value,selectedVersion:selectedSvg,displayedVersion:rows[0],matchingVersions:{...value.matchingVersions,format:"png"}};
    expect(assetLibraryItemSchema.safeParse(filtered).success).toBe(false);
    expect(assetLibraryItemSchema.safeParse({...filtered,asset:{...record,versionCount:5}}).success).toBe(true);
  });
  it("rejects cross-owner/project rows, duplicate cards and reference-media library entries",()=>{
    const query=assetLibraryQuerySchema.parse({});const value={ownerId,query,items:[item()],nextCursor:null};
    expect(assetLibraryPageSchema.safeParse(value).success).toBe(true);
    expect(assetLibraryPageSchema.safeParse({...value,ownerId:id(99)}).success).toBe(false);
    expect(assetLibraryPageSchema.safeParse({...value,items:[item(),item()]}).success).toBe(false);
    expect(assetLibraryItemSchema.safeParse({...item(),asset:{...asset(),purpose:"reference_media"}}).success).toBe(false);
    expect(assetLibraryItemSchema.safeParse({...item(),displayedVersion:{...version(),projectId:id(99)}}).success).toBe(false);
    expect(assetLibraryPageSchema.safeParse({...value,items:[{...item(),asset:{...asset(),usage:{active:false,legacy:false}}}]}).success).toBe(false);
    expect(assetLibraryPageSchema.safeParse({...value,query:{...query,tab:"all_generations"},items:[{...item(),asset:{...asset(),usage:{active:false,legacy:false}}}]}).success).toBe(true);
  });
  it("returns neutral retention metadata and records new restoration acknowledgements separately",()=>{
    const metadata={asset:asset(),project:project()};
    expect(assetRetentionResponseSchema.safeParse(metadata).success).toBe(true);
    expect(assetRetentionResponseSchema.safeParse({...metadata,matchingVersions:page()}).success).toBe(false);
    const selected={...asset(),selectionRevision:1,currentSelection:selection()};
    const detail={asset:selected,project:project(),selectedVersion:version(),versions:page()};
    const parsed=assetSelectionResponseSchema.parse(detail);
    expect(parsed.asset.currentSelection!.receipt).toMatchObject({status:"recorded",acceptedStaleBasis:true,projectRevision:2});
    expect(assetSelectionResponseSchema.safeParse({...detail,asset:{...selected,currentSelection:{...selection(),receipt:{status:"recorded",projectRevision:2,acceptedStaleBasis:false,previousSelectionId:null}}}}).success).toBe(false);
    expect(assetSelectionResponseSchema.safeParse({...detail,versions:{...page(),format:"png"}}).success).toBe(false);
  });
  it("validates acknowledgment against the selection's recorded revision, preserving later staleness honestly",()=>{
    const currentProject={...project(),current_revision:3};
    const currentVersion={...version(),freshness:assetRevisionFreshness(1,3)};
    const currentPage={...page(),items:[currentVersion]};
    const receipt={status:"recorded",projectRevision:1,acceptedStaleBasis:false,previousSelectionId:null};
    const record={...asset(),selectionRevision:1,currentSelection:{...selection(),receipt}};
    const detail={asset:record,project:currentProject,selectedVersion:currentVersion,versions:currentPage};
    expect(assetDetailSchema.safeParse(detail).success).toBe(true);
    expect(assetDetailSchema.safeParse({...detail,asset:{...record,currentSelection:{...selection(),receipt:{...receipt,projectRevision:2}}}}).success).toBe(false);
    expect(assetDetailSchema.safeParse({...detail,asset:{...record,currentSelection:{...selection(),receipt:{...receipt,projectRevision:2,acceptedStaleBasis:true}}}}).success).toBe(true);
    expect(assetRecordSchema.safeParse({...record,selectionRevision:2}).success).toBe(false);
    expect(assetRecordSchema.safeParse({...record,selectionRevision:2,currentSelection:{...selection(),receipt:{...receipt,previousSelectionId:id(80)}}}).success).toBe(true);
  });
});
