import { beforeAll,describe,expect,it,vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only",()=>({}));
import { createIdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { hash,id,jobInput,jobId,ownerId,projectId,leaseToken } from "../worker/identity-generation-fixture";
let bytes:Uint8Array;beforeAll(async()=>{bytes=new Uint8Array(await sharp({create:{width:1024,height:1024,channels:3,background:"#aa4477"}}).png().toBuffer());});
function fixture(){const prepare=vi.fn(async()=>{throw Error("Fixture backend unavailable");}),resolve=vi.fn(async()=>{throw Error("Fixture backend unavailable");}),observe=vi.fn(async()=>{throw Error("Fixture backend unavailable");}),putIfAbsent=vi.fn(),read=vi.fn();
 const store=createIdentityAssetStore({backend:{prepare,resolve,observe},storage:{putIfAbsent,read}}),input=jobInput(hash(bytes)),job:ClaimedJob={id:jobId,ownerId,projectId,operation:"identity.image",input,inputRevision:1,leaseToken,status:"running",reservedCostMicrousd:0,actualCostMicrousd:0};
 const publication={requestKey:input.systemIds[0]!,inputRevisions:[],mimeType:"image/png",contentHash:hash(bytes),byteLength:bytes.byteLength,source:{kind:"identity_system" as const,sourceId:input.systemIds[0]!}};
 return{store,prepare,resolve,observe,putIfAbsent,read,job,publication};}
describe("Identity exact leased asset gate",()=>{
 it("permits only the predetermined Identity system publication into SQL authority",async()=>{const f=fixture();await expect(f.store.publishLeasedAsset(f.job,f.publication,bytes)).rejects.toMatchObject({code:"integration_unavailable"});expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.putIfAbsent).not.toHaveBeenCalled();});
 it.each(["wrong_kind","wrong_id","wrong_source","wrong_mime","foreign_scope"])("rejects %s before backend or Storage",async kind=>{const f=fixture();if(kind==="wrong_kind")Object.assign(f.publication.source,{kind:"concept"});if(kind==="wrong_id")f.publication.requestKey=id(99);if(kind==="wrong_source")f.publication.source.sourceId=id(99);if(kind==="wrong_mime")f.publication.mimeType="image/svg+xml";if(kind==="foreign_scope")f.job.ownerId=id(99);await expect(f.store.publishLeasedAsset(f.job,f.publication,bytes)).rejects.toMatchObject({code:"not_found"});expect(f.prepare).not.toHaveBeenCalled();expect(f.putIfAbsent).not.toHaveBeenCalled();});
 it("does not graft Identity publications onto a Logo job",async()=>{const f=fixture();f.job.operation="identity.logo_concept";await expect(f.store.publishLeasedAsset(f.job,f.publication,bytes)).rejects.toMatchObject({code:"not_found"});expect(f.prepare).not.toHaveBeenCalled();});
 it("does not grant web callers the new producer-only source",async()=>{const f=fixture(),auth={userId:ownerId} as AuthenticatedContext;await expect(f.store.stageOwnedAsset(auth,projectId,f.publication,bytes)).rejects.toMatchObject({code:"not_found"});expect(f.prepare).not.toHaveBeenCalled();});
 it("does not read arbitrary owned files beyond the captured selected references",async()=>{const f=fixture();await expect(f.store.readLeasedAsset(f.job,{assetId:id(98),versionId:id(99),ownerId,projectId,contentHash:hash(bytes)})).rejects.toMatchObject({code:"not_found"});expect(f.resolve).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();});
});
