import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSupabasePrivateAssetStorage, type SupabasePrivateAssetStorageDependencies } from "../../../src/server/runtime/private-asset-storage";
import { createIdentityAssetStore, type IdentityAssetBackend, type IdentityAssetReservation } from "../../../src/server/data/identity-asset-store";
import type { AuthenticatedContext } from "../../../src/server/auth/context";
import { ApiError } from "../../../src/server/http/errors";
import { createClient } from "@supabase/supabase-js";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const assetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const versionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const requestKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const path = `${ownerId}/${projectId}/${assetId}/${versionId}`;
const homePath = `${ownerId}/home/${assetId}/${versionId}`;
const endpoint = "https://fricsfwqibyhemknqgyf.supabase.co/storage/v1/object/fluid-assets/";
const bytes = new TextEncoder().encode('{"version":1}');
const mimeType = "application/json";
const contentHash = createHash("sha256").update(bytes).digest("hex");
const deferred = <T>() => { let resolve!: (value:T)=>void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const success = () => json({ Id: assetId, Key: `fluid-assets/${path}` });
type FetchCall = { url: string; init: RequestInit };
function fixture(overrides: Partial<SupabasePrivateAssetStorageDependencies> = {}) {
 const objects = new Map<string, {bytes: Uint8Array; mimeType: string}>();
 const calls: FetchCall[] = [];
 const transport = async (url:string, init:RequestInit):Promise<Response> => {
  calls.push({url,init});
  const saved = objects.get(url);
  if(init.method === "POST") {
   if(saved) return json({code:"ResourceAlreadyExists",message:"Already stored"},409);
   objects.set(url,{bytes:new Uint8Array(init.body as Uint8Array),mimeType:new Headers(init.headers).get("content-type")!});
   return json({Id:assetId,Key:url.slice(endpoint.length-"fluid-assets/".length)});
  }
  return saved ? new Response(new Uint8Array(saved.bytes),{headers:{"content-type":saved.mimeType}}) : json({code:"NoSuchKey"},404);
 };
 const dependencies: SupabasePrivateAssetStorageDependencies = {transport,scope:{kind:"identity",ownerId,projectId},maxFileBytes:1024,deadlineMs:100,...overrides};
 return {storage:createSupabasePrivateAssetStorage(dependencies),dependencies,objects,calls};
}
afterEach(()=>vi.useRealTimers());

describe("concrete private object REST contract",()=>{
 it("matches installed Supabase SDK create-only request semantics using a deterministic fetch fixture",async()=>{
  const calls:FetchCall[]=[];
  const client=createClient("https://fricsfwqibyhemknqgyf.supabase.co","fixture-only-not-a-credential",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,init)=>{calls.push({url:String(url),init:init!});return success();}}});
  const result=await client.storage.from("fluid-assets").upload(path,new Uint8Array(bytes),{upsert:false,contentType:mimeType,cacheControl:"0"});
  expect(result.error).toBeNull();expect(result.data?.path).toBe(path);
  expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe(endpoint+path);expect(calls[0]!.init.method).toBe("POST");
  expect(new Headers(calls[0]!.init.headers).get("x-upsert")).toBe("false");expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe(mimeType);
 });
 it("creates only the exact private immutable object and reads actual bytes",async()=>{
  const f=fixture(); await f.storage.putIfAbsent(path,bytes,mimeType);
  expect(await f.storage.read(path)).toEqual({bytes,mimeType});
  expect(f.calls.map(c=>[c.url,c.init.method])).toEqual([[endpoint+path,"POST"],[endpoint+path,"GET"]]);
  for(const {init} of f.calls){expect(init.redirect).toBe("error");expect(init.cache).toBe("no-store");expect(init.credentials).toBe("omit");expect(init.signal).toBeInstanceOf(AbortSignal);}
  expect(new Headers(f.calls[0]!.init.headers).get("x-upsert")).toBe("false");
  expect(new Headers(f.calls[0]!.init.headers).get("content-type")).toBe(mimeType);
  expect(new Headers(f.calls[0]!.init.headers).has("authorization")).toBe(false);
 });
 it("never overwrites an existing version when another byte body races or replays",async()=>{
  const f=fixture(); await Promise.all([f.storage.putIfAbsent(path,bytes,mimeType),f.storage.putIfAbsent(path,new Uint8Array([9]),mimeType)]);
  expect((await f.storage.read(path)).bytes).toEqual(bytes);
  expect(f.calls.filter(c=>c.init.method==="POST")).toHaveLength(2);
 });
 it("copies Node Buffer input before any transport await",async()=>{
  const gate=deferred<Response>(), input=Buffer.from(bytes); let submitted:Uint8Array|undefined;
  const f=fixture({transport:async(_url,init)=>{submitted=init.body as Uint8Array;return gate.promise;}});
  const pending=f.storage.putIfAbsent(path,input,mimeType); input.fill(0); await Promise.resolve();
  expect(submitted).toEqual(bytes); gate.resolve(success()); await pending;
 });
 it("supports only the separately bound exact Home path",async()=>{
  const f=fixture({scope:{kind:"home",ownerId}}); await f.storage.putIfAbsent(homePath,bytes,"text/plain");
  expect(await f.storage.read(homePath)).toEqual({bytes,mimeType:"text/plain"});
  await expect(f.storage.read(path)).rejects.toMatchObject({code:"not_found"});
 });
 it.each(["",`${path}/extra`,`/${path}`,path.toUpperCase(),path+"?token=x",path+"#x",path.replace(assetId,".."),path.replace(assetId,"%2e%2e"),path.replace(ownerId,projectId),path.replace(projectId,ownerId),homePath,"https://elsewhere.test/object"])("rejects noncanonical or foreign scope before I/O: %s",async invalid=>{
  const f=fixture();await expect(f.storage.putIfAbsent(invalid,bytes,mimeType)).rejects.toMatchObject({code:"not_found"});
  await expect(f.storage.read(invalid)).rejects.toMatchObject({code:"not_found"});expect(f.calls).toHaveLength(0);
 });
 it("freezes the scope and bounds at factory construction",async()=>{
  const f=fixture();f.dependencies.scope.ownerId=projectId;f.dependencies.maxFileBytes=1;
  await f.storage.putIfAbsent(path,bytes,mimeType);expect((await f.storage.read(path)).bytes).toEqual(bytes);
 });
 it.each(["", "Image/PNG", " image/png", "image/png; charset=utf-8", "image/png\r\nx-upsert:true", "no-slash", "a/"+"b".repeat(149)])("rejects a noncanonical MIME before dispatch: %s",async invalid=>{
  const f=fixture();await expect(f.storage.putIfAbsent(path,bytes,invalid)).rejects.toMatchObject({code:"invalid_input"});expect(f.calls).toHaveLength(0);
 });
 it("rejects missing, empty and oversized bytes before transport",async()=>{
  const f=fixture({maxFileBytes:1});
  for(const value of [null,new Uint8Array(),bytes])await expect(f.storage.putIfAbsent(path,value as Uint8Array,mimeType)).rejects.toMatchObject({code:"invalid_input"});
  expect(f.calls).toHaveLength(0);
 });
 it("fails closed with absent transport or invalid configuration",async()=>{
  await expect(createSupabasePrivateAssetStorage(null).read(path)).rejects.toMatchObject({code:"integration_unavailable"});
  for(const override of [{transport:undefined},{deadlineMs:0},{deadlineMs:60_001},{maxFileBytes:52_428_801},{scope:{kind:"identity",ownerId:"forged",projectId}}]){
   expect(()=>fixture(override as Partial<SupabasePrivateAssetStorageDependencies>)).toThrowError(expect.objectContaining({code:"integration_unavailable"}));
  }
 });
});

describe("strict storage acknowledgements and error sanitation",()=>{
 it.each(["ResourceAlreadyExists","KeyAlreadyExists","already_exists"])("allows only a documented duplicate code to reach outer verification: %s",async code=>{
  const f=fixture({transport:async()=>json({code},409)});await expect(f.storage.putIfAbsent(path,bytes,mimeType)).resolves.toBeUndefined();
 });
 it.each([["ResourceAlreadyExists"],["KeyAlreadyExists"],["already_exists"],[["ResourceAlreadyExists"]],{code:"ResourceAlreadyExists"},{value:"already_exists"},409,null].map(code=>({code})))("rejects non-string duplicate codes instead of coercing them: $code",async({code})=>{
  const f=fixture({transport:async()=>json({code},409)});
  await expect(f.storage.putIfAbsent(path,bytes,mimeType)).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it.each([[409,{code:"BucketAlreadyExists"}],[409,{message:"Already exists"}],[400,{code:"InvalidRequest"}],[500,{code:"ResourceAlreadyExists"}],[403,{code:"AccessDenied"}],[429,{message:"secret service credential"}],[200,{Id:assetId,Key:"fluid-assets/other/path"}],[200,{Key:`fluid-assets/${path}`}],[201,{Id:assetId,Key:`fluid-assets/${path}`}]] as const)("does not turn failed or invalid writes into success (%s)",async(status,body)=>{
  const f=fixture({transport:async()=>json(body,status)});
  await expect(f.storage.putIfAbsent(path,bytes,mimeType)).rejects.toMatchObject({code:"integration_unavailable",message:"This integration is not configured or is unavailable."});
 });
 it("never returns confirmed absence from a masked Supabase 404",async()=>{
  const f=fixture({scope:{kind:"home",ownerId},transport:async()=>json({code:"NoSuchKey",message:"private path or secret"},404)});
  await expect(f.storage.read(homePath)).rejects.toMatchObject({code:"not_found",message:"This resource is unavailable."});
 });
 it("sanitizes unexpected transport exceptions and does not retry",async()=>{
  let calls=0;const f=fixture({transport:async()=>{calls++;throw Error("Bearer secret URL password");}});
  await expect(f.storage.read(path)).rejects.toMatchObject({code:"integration_unavailable",message:"This integration is not configured or is unavailable."});expect(calls).toBe(1);
 });
 it("does not preserve a transport-thrown ApiError payload or cause",async()=>{
  const error=new ApiError("integration_unavailable");error.message="secret credential from transport";error.cause="private URL";
  const f=fixture({transport:async()=>{throw error;}});const result=await f.storage.read(path).catch(value=>value);
  expect(result).toMatchObject({code:"integration_unavailable",message:"This integration is not configured or is unavailable."});expect(result.cause).toBeUndefined();expect(result).not.toBe(error);
 });
 it("rejects redirects or a response from another URL even if transport ignores redirect:error",async()=>{
  for(const response of [new Response(null,{status:302,headers:{location:"https://elsewhere.test"}}),Object.defineProperty(success(),"redirected",{value:true}),Object.defineProperty(success(),"url",{value:"https://elsewhere.test"})]){
   const f=fixture({transport:async()=>response});await expect(f.storage.putIfAbsent(path,bytes,mimeType)).rejects.toMatchObject({code:"integration_unavailable"});
  }
 });
});

describe("bounded response consumption and cancellation",()=>{
 it.each<Record<string,string>>([{"content-length":"2000"},{"content-length":"1"},{"content-length":"garbage"},{"content-type":"image/png; charset"},{"content-type":""},{"content-encoding":"gzip"}])("rejects invalid response metadata or inconsistent byte count %o",async headers=>{
  const f=fixture({transport:async()=>new Response(bytes,{headers:{"content-type":mimeType,...headers}})});
  await expect(f.storage.read(path)).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it("bounds actual streamed bytes even without Content-Length and cancels unread data",async()=>{
  let cancelled=false;
  const f=fixture({maxFileBytes:4,transport:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.enqueue(new Uint8Array([4,5,6]));},cancel(){cancelled=true;}}),{headers:{"content-type":mimeType}})});
  await expect(f.storage.read(path)).rejects.toMatchObject({code:"integration_unavailable"});expect(cancelled).toBe(true);
 });
 it("copies many tiny stream chunks without retaining aliased producer Buffers",async()=>{
  let index=0;const source=Buffer.alloc(1), expected=new Uint8Array(1024).map((_value,i)=>i%256);
  const f=fixture({deadlineMs:1000,transport:async()=>new Response(new ReadableStream({pull(controller){if(index===expected.length){controller.close();return;}source[0]=index++%256;controller.enqueue(source);}}, {highWaterMark:0}),{headers:{"content-type":mimeType}})});
  expect((await f.storage.read(path)).bytes).toEqual(expected);
 });
 it("bounds upload acknowledgement and error bodies",async()=>{
  for(const status of [200,409]){
   const f=fixture({transport:async()=>new Response("x".repeat(16_385),{status,headers:{"content-type":"application/json"}})});
   await expect(f.storage.putIfAbsent(path,bytes,mimeType)).rejects.toMatchObject({code:"integration_unavailable"});
  }
 });
 it("rejects pre-aborted operations without dispatch",async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await expect(f.storage.putIfAbsent(path,bytes,mimeType,controller.signal)).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(f.storage.read(path,controller.signal)).rejects.toMatchObject({code:"integration_unavailable"});expect(f.calls).toHaveLength(0);
 });
 it("settles at its deadline even if transport ignores abort, and discards a late acknowledgement",async()=>{
  vi.useFakeTimers();const gate=deferred<Response>();let signal:AbortSignal|undefined;let cancelled=false;
  const f=fixture({transport:async(_url,init)=>{signal=init.signal!;return gate.promise;}});
  const outcome=f.storage.putIfAbsent(path,bytes,mimeType).catch(error=>error);await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toMatchObject({code:"integration_unavailable"});expect(signal?.aborted).toBe(true);
  gate.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})));await vi.advanceTimersByTimeAsync(0);expect(cancelled).toBe(true);
 });
 it("settles an explicit abort while a read stream hangs without waiting for cancellation",async()=>{
  const gate=deferred<void>(),controller=new AbortController();let cancelled=false;
  const f=fixture({transport:async()=>new Response(new ReadableStream({pull(){gate.resolve();return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}}),{headers:{"content-type":mimeType}})});
  const result=f.storage.read(path,controller.signal).catch(error=>error);await gate.promise;controller.abort();
  expect(await result).toMatchObject({code:"integration_unavailable"});expect(cancelled).toBe(true);
 });
 it("does not return bytes after abort that occurs with the final read",async()=>{
  const controller=new AbortController();const f=fixture({transport:async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes);c.close();controller.abort();}}),{headers:{"content-type":mimeType}})});
  await expect(f.storage.read(path,controller.signal)).rejects.toMatchObject({code:"integration_unavailable"});
 });
});

describe("outer immutable publication verification",()=>{
 it("requires actual matching bytes after a duplicate and never publishes conflicting content",async()=>{
  const f=fixture();await f.storage.putIfAbsent(path,new Uint8Array([1]),mimeType);
  const reservation:IdentityAssetReservation={id:requestKey,requestKey,reference:{ownerId,projectId,assetId,versionId,contentHash},storagePath:path,mimeType,byteLength:bytes.length,purpose:"brand_asset",sourceReceiptId:requestKey,rightsEvidenceId:null,publicationState:"staged"};
  let observations=0;const backend:IdentityAssetBackend={async prepare(){return reservation;},async resolve(){return reservation;},async observe(){observations++;throw Error("must not publish");}};
  const store=createIdentityAssetStore({backend,storage:f.storage});
  await expect(store.stageOwnedAsset({userId:ownerId} as AuthenticatedContext,projectId,{requestKey,inputRevisions:[],mimeType,byteLength:bytes.length,contentHash,source:{kind:"vector",sourceId:requestKey}},bytes)).rejects.toMatchObject({name:"IdentityAssetUncertainPublicationError",requestKey});
  expect(observations).toBe(0);expect((await f.storage.read(path)).bytes).toEqual(new Uint8Array([1]));
 });
});
