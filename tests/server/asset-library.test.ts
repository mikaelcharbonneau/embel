import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { listAccountAssets,getAssetDetail,setAssetRetention,selectAssetVersion } from "../../src/server/data/assets";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { asRole,HASH,OWNER_A,OWNER_B,resetFixture,seedProject,type TestDatabase } from "../database/local-supabase";
import { createAssetLibraryTestDatabase,seedLibraryAsset,seedLibraryVersion } from "../database/asset-library-fixture";

describe("Assets DAL with actual local database boundaries",()=>{
 let db:TestDatabase;let projectId:string;let assetId:string;let versionId:string;let auth:AuthenticatedContext;
 beforeAll(async()=>{db=await createAssetLibraryTestDatabase();},30_000);afterAll(async()=>{await db?.close();});
 function context(ownerId=OWNER_A):AuthenticatedContext{return {userId:ownerId,client:{rpc:async(name:string,args:Record<string,unknown>)=>{
  try{if(!/^[a-z_]+$/.test(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error("Unexpected local SQL");
   const result=await asRole(db,"authenticated",ownerId,()=>db.query<{result:unknown}>(`select public.${name}(${Object.keys(args).map((key,i)=>`${key}=>$${i+1}`).join(",")}) result`,Object.values(args).map(value=>value&&typeof value==="object"?JSON.stringify(value):value)));return {data:result.rows[0]!.result,error:null};
  }catch(error){return {data:null,error:{code:(error as {code:string}).code}};}
 }}} as unknown as AuthenticatedContext;}
 beforeEach(async()=>{await resetFixture(db);projectId=(await seedProject(db)).id;assetId=await seedLibraryAsset(db,projectId,{liked:true});versionId=await seedLibraryVersion(db,projectId,assetId,{stored:true});auth=context();});
 it("reads only owned metadata without upgrading unverified files or legacy provenance",async()=>{
  const page=await listAccountAssets(auth);expect(page.items[0]!.asset.id).toBe(assetId);expect(page.items[0]!.displayedVersion).toMatchObject({fileState:"unverified",fileVerification:null,provenance:{status:"legacy_unverified"}});
  expect((await listAccountAssets(context(OWNER_B))).items).toEqual([]);await expect(getAssetDetail(context(OWNER_B),assetId)).rejects.toMatchObject({code:"not_found"});
  expect(JSON.stringify(page)).not.toContain("storage_path");expect(JSON.stringify(page)).not.toContain("signedUrl");
 });
 it("uses exact expected revisions for retention and restoration, keeping unretained history",async()=>{
  await setAssetRetention(auth,assetId,{expectedRetentionRevision:0,liked:false,saved:false});expect((await listAccountAssets(auth)).items).toEqual([]);
  const response=await selectAssetVersion(auth,assetId,{versionId,expectedProjectRevision:1,expectedSelectionRevision:0,acceptStaleBasis:false});expect(response.asset.selectionRevision).toBe(1);expect(response.asset.usage).toEqual({active:false,legacy:false});
  await expect(setAssetRetention(auth,assetId,{expectedRetentionRevision:0,liked:true,saved:false})).rejects.toMatchObject({code:"conflict"});expect((await listAccountAssets(auth,{tab:"all_generations"})).items).toHaveLength(1);
 });
 it("normalizes valid uppercase mutation UUIDs before writes and receipt checks",async()=>{
  const retention=await setAssetRetention(auth,assetId.toUpperCase(),{expectedRetentionRevision:0,liked:false,saved:true});
  expect(retention.asset.id).toBe(assetId);expect(retention.asset.retentionRevision).toBe(1);
  const selected=await selectAssetVersion(auth,assetId.toUpperCase(),{versionId:versionId.toUpperCase(),expectedProjectRevision:1,expectedSelectionRevision:0,acceptStaleBasis:false});
  expect(selected.asset.currentSelection?.versionId).toBe(versionId);expect(selected.asset.selectionRevision).toBe(1);
 });
 it("normalizes project and library cursor UUIDs without weakening owner fences",async()=>{
  const older=await seedLibraryAsset(db,projectId,{liked:true,createdAt:"2026-10-01T00:00:00Z"});
  const first=await listAccountAssets(auth,{projectId:projectId.toUpperCase(),limit:1});
  expect(first.query.projectId).toBe(projectId);expect(first.nextCursor).not.toBeNull();
  const cursor={...first.nextCursor!,assetId:first.nextCursor!.assetId.toUpperCase(),projectId:projectId.toUpperCase()};
  const next=await listAccountAssets(auth,{projectId:projectId.toUpperCase(),limit:1,cursor});expect(next.items.map(item=>item.asset.id)).toEqual([older]);
  await expect(listAccountAssets(context(OWNER_B),{projectId:projectId.toUpperCase(),limit:1,cursor})).rejects.toMatchObject({code:"not_found"});
 });
 it("normalizes detail path and version cursor UUIDs before query binding",async()=>{
  await seedLibraryVersion(db,projectId,assetId,{createdAt:"2026-10-01T00:00:00Z",version:2});
  const first=await getAssetDetail(auth,assetId.toUpperCase(),{limit:1});expect(first.versions.nextCursor).not.toBeNull();
  const cursor=first.versions.nextCursor!;
  const next=await getAssetDetail(auth,assetId.toUpperCase(),{limit:1,cursor:{...cursor,assetId:cursor.assetId.toUpperCase(),projectId:cursor.projectId.toUpperCase(),versionId:cursor.versionId.toUpperCase()}});
  expect(next.versions.items).toHaveLength(1);expect(next.versions.items[0]!.versionId).not.toBe(cursor.versionId);
 });
 it("requires explicit stale-basis acknowledgement and binds it to the saved project revision",async()=>{
  await asRole(db,"authenticated",OWNER_A,()=>db.query("select public.append_project_revision($1,1,$2::jsonb,$3)",[projectId,JSON.stringify({description:"Changed saved fixture"}),HASH]));
  const request={versionId,expectedProjectRevision:2,expectedSelectionRevision:0,acceptStaleBasis:false};await expect(selectAssetVersion(auth,assetId,request)).rejects.toMatchObject({code:"conflict"});
  expect((await selectAssetVersion(auth,assetId,{...request,acceptStaleBasis:true})).asset.currentSelection!.receipt).toMatchObject({status:"recorded",projectRevision:2,acceptedStaleBasis:true});
 });
 it("rejects owner/provider/vector/usage injection before RPC",async()=>{
  const spy=vi.spyOn(auth.client,"rpc");await expect(setAssetRetention(auth,assetId,{expectedRetentionRevision:0,liked:true,saved:false,used:true})).rejects.toMatchObject({code:"invalid_input"});
  await expect(selectAssetVersion(auth,assetId,{versionId,expectedProjectRevision:1,expectedSelectionRevision:0,acceptStaleBasis:false,provider:"forged"})).rejects.toMatchObject({code:"invalid_input"});expect(spy).not.toHaveBeenCalled();
 });
 it("fences a foreign valid response and rejects manufactured file-integrity claims",async()=>{
  const detail=await getAssetDetail(auth,assetId);const version=detail.versions.items[0]!;
  const forged={...detail,versions:{...detail.versions,items:[{...version,fileState:"verified",fileVerification:{status:"verified",checkedAt:"2026-10-04T00:00:00Z",contentHash:version.contentHash,mimeType:version.mimeType,byteLength:20}}]}};
  vi.spyOn(auth.client,"rpc").mockResolvedValueOnce({data:forged,error:null} as never);await expect(getAssetDetail(auth,assetId)).rejects.toMatchObject({code:"integration_unavailable"});
  const other=context(OWNER_B);vi.spyOn(other.client,"rpc").mockResolvedValueOnce({data:detail,error:null} as never);await expect(getAssetDetail(other,assetId)).rejects.toMatchObject({code:"not_found"});
 });
 it("rejects a response for a different path, format or retention request",async()=>{
  const detail=await getAssetDetail(auth,assetId);vi.spyOn(auth.client,"rpc").mockResolvedValueOnce({data:detail,error:null} as never);
  await expect(getAssetDetail(auth,assetId,{format:"svg"})).rejects.toMatchObject({code:"integration_unavailable"});
  vi.spyOn(auth.client,"rpc").mockResolvedValueOnce({data:{asset:detail.asset,project:detail.project},error:null} as never);await expect(setAssetRetention(auth,assetId,{expectedRetentionRevision:0,liked:false,saved:false})).rejects.toMatchObject({code:"integration_unavailable"});
 });
});
