import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createIdentityAssetStore, type IdentityAssetBackend, type IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { IdentityAssetPublication } from "../../src/domain/logo-deliverables";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = randomUUID();
const bytes = new TextEncoder().encode('{"version":1}'), hash = createHash("sha256").update(bytes).digest("hex");
const auth = { userId: owner } as AuthenticatedContext;
const job = { id: randomUUID(), ownerId: owner, projectId: project, operation: "identity.logo_vectorize", input: {}, inputRevision: 1, leaseToken: randomUUID(), status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0 } as ClaimedJob;
const publication: IdentityAssetPublication = { requestKey: randomUUID(), inputRevisions: [], mimeType: "application/json", contentHash: hash, byteLength: bytes.length, source: { kind: "vector", sourceId: randomUUID() } };
function fixture() {
 const assetId=randomUUID(),versionId=randomUUID();
 const reservation: IdentityAssetReservation = {id:randomUUID(),requestKey:publication.requestKey,reference:{ownerId:owner,projectId:project,assetId,versionId,contentHash:hash},storagePath:`${owner}/${project}/${assetId}/${versionId}`,mimeType:"application/json",byteLength:bytes.length,purpose:"brand_asset",sourceReceiptId:publication.source.sourceId,rightsEvidenceId:null,publicationState:"staged"};
 let saved: Uint8Array|null=null, reads=0, writes=0, checks=0;
 const backend:IdentityAssetBackend={
  async prepare(){checks++;return structuredClone(reservation);},
  async resolve(){checks++;return structuredClone(reservation);},
  async observe(_access,id,verification){checks++;if(id!==reservation.id)throw Error("bad id");return {id:reservation.id,reference:reservation.reference,verification,purpose:reservation.purpose,sourceReceiptId:reservation.sourceReceiptId,rightsEvidenceId:null,publicationState:reservation.publicationState};},
 };
 const storage={async putIfAbsent(_path:string,value:Uint8Array){writes++;if(!saved)saved=value.slice();},async read(){reads++;if(!saved)throw Error("missing");return {bytes:saved.slice(),mimeType:"application/json"};}};
 const store=createIdentityAssetStore({backend,storage});
 return {store,backend,storage,reservation,stats:()=>({reads,writes,checks}),corrupt:()=>{saved=new Uint8Array([0]);}};
}
describe("actual-byte private identity asset boundary",()=>{
 it("stages and reads back actual immutable bytes without granting committed success",async()=>{
  const f=fixture(),receipt=await f.store.publishLeasedAsset(job,publication,bytes);
  expect(receipt.publicationState).toBe("staged");expect(receipt.verification.contentHash).toBe(hash);
  const read=await f.store.readLeasedAsset(job,receipt.reference);expect(read.bytes).toEqual(bytes);expect(f.stats().checks).toBeGreaterThanOrEqual(4);
 });
 it("rejects an incorrect byte hash before storage or metadata writes",async()=>{
  const f=fixture();await expect(f.store.stageOwnedAsset(auth,project,publication,new Uint8Array([1]))).rejects.toMatchObject({code:"invalid_input"});expect(f.stats()).toEqual({reads:0,writes:0,checks:0});
 });
 it("rejects cross-owner metadata before touching the private object",async()=>{
  const f=fixture();f.reservation.reference.ownerId=randomUUID();await expect(f.store.stageOwnedAsset(auth,project,publication,bytes)).rejects.toMatchObject({code:"not_found"});expect(f.stats().writes).toBe(0);
 });
 it("never treats a matching metadata hash as a verified read of corrupt bytes",async()=>{
  const f=fixture();await f.store.publishLeasedAsset(job,publication,bytes);f.corrupt();await expect(f.store.readLeasedAsset(job,f.reservation.reference)).rejects.toMatchObject({code:"not_found"});
 });
 it("requires exact owner/project path rather than caller-controlled storage paths",async()=>{
  const f=fixture();f.reservation.storagePath="foreign/object";await expect(f.store.stageOwnedAsset(auth,project,publication,bytes)).rejects.toMatchObject({code:"not_found"});expect(f.stats().writes).toBe(0);
 });
 it("checks the lease again after storage and exposes lost acknowledgement as uncertain without retry",async()=>{
  const f=fixture();f.backend.observe=async()=>{throw Error("lease lost");};await expect(f.store.publishLeasedAsset(job,publication,bytes)).rejects.toMatchObject({name:"IdentityAssetUncertainPublicationError",requestKey:publication.requestKey});expect(f.stats().writes).toBe(1);
 });
 it("a cancelled publication before admission has no side effects",async()=>{
  const f=fixture(),c=new AbortController();c.abort();await expect(f.store.publishLeasedAsset(job,publication,bytes,c.signal)).rejects.toMatchObject({code:"integration_unavailable"});expect(f.stats().writes).toBe(0);
 });
 it("unconfigured capability fails closed",async()=>{
  await expect(createIdentityAssetStore(null).readOwnedAsset(auth,{ownerId:owner,projectId:project,assetId:randomUUID(),versionId:randomUUID(),contentHash:hash})).rejects.toMatchObject({code:"integration_unavailable"});
 });
});

describe("bounded decoded file admission",()=>{
 it("rejects a non-byte input before attempting a copy",async()=>{
  const f=fixture();await expect(f.store.stageOwnedAsset(auth,project,publication,{slice(){throw Error("must not copy");}} as unknown as Uint8Array)).rejects.toMatchObject({code:"invalid_input"});expect(f.stats().writes).toBe(0);
 });
 it("does not accept arbitrary bytes merely labeled PNG with a valid hash",async()=>{
  const f=fixture();await expect(f.store.publishLeasedAsset(job,{...publication,mimeType:"image/png"},bytes)).rejects.toBeDefined();expect(f.stats().checks).toBe(0);
 });
 it("rejects a raster-only SVG wrapper before preparing metadata",async()=>{
  const f=fixture(),fake=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="data:image/png;base64,AAAA"/></svg>');
  await expect(f.store.publishLeasedAsset(job,{...publication,mimeType:"image/svg+xml",contentHash:createHash("sha256").update(fake).digest("hex"),byteLength:fake.length},fake)).rejects.toBeDefined();expect(f.stats().checks).toBe(0);
 });
});

describe("fixed private database adapter",()=>{
 it("maps actual database conflict and sends only a fixed function call",async()=>{
  const assetModule=await import("../../src/server/data/identity-asset-store");
  const query=vi.fn(async (_sql:string,_parameters?:unknown[])=>{void _sql;void _parameters;throw Object.assign(Error("changed exact request"),{code:"PT409"});});
  const backend=assetModule.createPostgresIdentityAssetBackend({owned:null,worker:{query}});
  await expect(backend.prepare({kind:"leased",job,ownerId:owner,projectId:project},{kind:"stage",publication})).rejects.toMatchObject({code:"conflict"});
  expect(query.mock.calls[0]![0]).toBe("SELECT fluid_private.prepare_logo_asset($1::uuid,$2::jsonb,$3::uuid,$4::uuid) AS value");
 });
});

describe("immutable byte ownership across async boundaries",()=>{
 it("copies Node Buffer input before an awaited admission can mutate caller memory",async()=>{
  const f=fixture(),input=Buffer.from(bytes),prepare=f.backend.prepare;
  f.backend.prepare=async(...args)=>{const result=await prepare(...args);input.fill(0);return result;};
  const result=await f.store.publishLeasedAsset(job,publication,input);expect(result.verification.contentHash).toBe(hash);
  expect((await f.store.readLeasedAsset(job,result.reference)).bytes).toEqual(bytes);
 });
});
