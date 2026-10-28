import { createHash } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import type {ClaimedJob} from "../../src/domain/jobs";
import type {SharedExecution} from "../../worker/shared-pool/contracts";
import {sharedConfiguration,sharedLease} from "./shared-pool-fixture";
import {QUALIFIED_VTRACER} from "../../worker/logo-vector/engine";
import {createSharedAdvancedLogoStorageAuthorization} from "../../worker/shared-lanes/logo-storage";
import {separatedLogoDocument} from "../features/logo-vector/fixtures";
import {canonicalLogoDocumentBytes} from "../../src/features/logo-vector/model/canonical";
import {qualifiedLogoProductionStorageCapability} from "../../worker/logo-production-storage-authorization";
const id=(n:number)=>"77111111-1111-4111-8111-"+String(n).padStart(12,"0");
/** Native bytes/strict HTTP protocol with explicit inert Auth+grant ports.
 * Actual role/RLS/SQL membership proofs are tested by the database packet tests. */
function fixture(){
 const config=sharedConfiguration(),initial=sharedLease(config,"logo"),origin="https://abcdefghijklmnopqrst.supabase.co";
 let slot=initial;
 const capability=qualifiedLogoProductionStorageCapability({operation:"identity.logo_vectorize",policyIdentity:"a".repeat(64),handlerVersion:"1",provider:null,model:null,engine:{id:"vtracer",version:QUALIFIED_VTRACER.version,artifactHash:QUALIFIED_VTRACER.wasm},maxCostMicrousd:0})!;
 const execution:SharedExecution={version:1,executionId:id(1),executionToken:id(2),slotId:slot.slotId,instanceId:slot.instanceId,generation:slot.generation,lane:"logo",ownerId:id(3),projectId:id(4),jobId:id(5),
  leaseToken:id(6),operation:"identity.logo_vectorize",policyIdentity:capability.policyIdentity,deploymentId:config.target.deploymentId};
 const job:ClaimedJob={id:execution.jobId,ownerId:execution.ownerId,projectId:execution.projectId,leaseToken:execution.leaseToken,status:"running",operation:execution.operation,inputRevision:1,reservedCostMicrousd:0,actualCostMicrousd:0,
  input:{version:2,ownerId:execution.ownerId,projectId:execution.projectId,operation:execution.operation,requestKey:id(7),quoteId:id(8),policyIdentity:capability.policyIdentity,handlerVersion:"1",inputHash:"b".repeat(64),
   source:{kind:"refinement",rasterRevisionId:id(9)},settings:{preset:"poster",simplify:0,filterSpeckle:0,maxColors:4},engine:capability.engine}};
 const bytes=canonicalLogoDocumentBytes(separatedLogoDocument()),contentHash=createHash("sha256").update(bytes).digest("hex");
 const reference={ownerId:job.ownerId,projectId:job.projectId,assetId:id(10),versionId:id(11),contentHash};
 const reservation={id:id(12),requestKey:id(13),reference,storagePath:job.ownerId+"/"+job.projectId+"/"+reference.assetId+"/"+reference.versionId,mimeType:"application/json",byteLength:bytes.length,
  purpose:"brand_asset" as const,sourceReceiptId:job.id,rightsEvidenceId:null,publicationState:"staged" as const};
 const publication={requestKey:reservation.requestKey,inputRevisions:[],source:{kind:"vector" as const,sourceId:job.id},mimeType:reservation.mimeType,byteLength:bytes.length,contentHash};
 const authUserId=id(14),sessionId=id(15),state={foreignSession:false,forgedOwner:false,uploaded:false};
 const token=()=>[Buffer.from('{"alg":"HS256"}').toString("base64url"),Buffer.from(JSON.stringify({sub:authUserId,session_id:state.foreignSession?id(99):sessionId,role:"authenticated",aud:"authenticated",iss:origin+"/auth/v1",is_anonymous:false,exp:Math.floor(Date.now()/1000)+600})).toString("base64url"),"inert"].join(".");
 const fetcher=vi.fn(async(raw:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(raw));expect(url.origin).toBe(origin);expect(init?.redirect).toBe("error");expect(init?.credentials).toBe("omit");
  if(url.pathname==="/auth/v1/user")return Response.json({id:authUserId,is_anonymous:false,email_confirmed_at:"2026-10-01T00:00:00Z"});
  if(url.pathname==="/rest/v1/rpc/authorize_shared_logo_storage"){const body=JSON.parse(String(init?.body));expect(body.p_execution_token).toBe(execution.executionToken);expect(body.p_job).toBe(job.id);
   if(body.p_mode==="write"&&slot.generation!==execution.generation)return new Response(null,{status:403});
   return Response.json({version:1,slotId:execution.slotId,instanceId:execution.instanceId,generation:execution.generation,roleName:initial.roleName,roleOid:initial.roleOid,authUserId,sessionId,execution,
    ownerId:state.forgedOwner?id(99):job.ownerId,projectId:job.projectId,jobId:job.id,leaseToken:job.leaseToken,inputRevision:1,jobInput:job.input,capability,mode:body.p_mode,
    member:body.p_mode==="probe"?null:"output",reservation:body.p_mode==="probe"?null:reservation,publication:body.p_mode==="probe"?null:publication});}
  expect(url.pathname).toBe("/storage/v1/object/fluid-assets/"+reservation.storagePath);
  if(init?.method==="POST"){state.uploaded=true;return Response.json({Id:id(16),Key:"fluid-assets/"+reservation.storagePath});}
  expect(state.uploaded).toBe(true);return new Response(Buffer.from(bytes),{headers:{"content-type":"application/json; charset=utf-8"}});
 });
 const authorization=createSharedAdvancedLogoStorageAuthorization({targetOrigin:origin,publishableKey:"sb_publishable_inert_fixture",slot:()=>slot,execution,capability,session:{authUserId,sessionId,tokenProvider:async()=>token()}},{fetch:fetcher});
 return{job,execution,capability,bytes,reservation,publication,state,authorization,fetcher,advance(){slot={...slot,generation:slot.generation+1,instanceId:id(90),leaseToken:id(91)};}};
}
describe("advanced fixed-slot Storage object protocol",()=>{
 it("authorizes canonical native JSON bytes and verifies immutable readback",async()=>{
  const f=fixture();try{await f.authorization.assertAvailable(f.job);const writer=await f.authorization.authorizeWrite({job:f.job,reservation:f.reservation,publication:f.publication});
   await writer.putIfAbsent(f.bytes,"application/json");expect(await writer.read()).toEqual({bytes:new Uint8Array(f.bytes),mimeType:"application/json"});
  }finally{f.authorization.close();}
 });
 it.each(["owner","path","hash","proof","session"])("rejects forged %s without object HTTP",async defect=>{
  const f=fixture(),scope=structuredClone({job:f.job,reservation:f.reservation,publication:f.publication});
  if(defect==="owner")scope.job.ownerId=id(99);if(defect==="path")scope.reservation.storagePath+="/suffix";
  if(defect==="hash")scope.publication.contentHash="f".repeat(64);if(defect==="proof")f.state.forgedOwner=true;if(defect==="session")f.state.foreignSession=true;
  try{await expect(f.authorization.authorizeWrite(scope)).rejects.toThrow();expect(f.fetcher.mock.calls.some(([url])=>String(url).includes("/storage/v1/object/"))).toBe(false);}
  finally{f.authorization.close();}
 });
 it("allows only existing issued-output readback after generation fencing and forbids another upload",async()=>{
  const f=fixture();try{const writer=await f.authorization.authorizeWrite({job:f.job,reservation:f.reservation,publication:f.publication});await writer.putIfAbsent(f.bytes,"application/json");f.advance();
   expect((await writer.read()).bytes).toEqual(new Uint8Array(f.bytes));await expect(writer.putIfAbsent(f.bytes,"application/json")).rejects.toThrow();
  }finally{f.authorization.close();}
 });
 it("does not accept substituted output bytes under a correct reservation",async()=>{
  const f=fixture();try{const writer=await f.authorization.authorizeWrite({job:f.job,reservation:f.reservation,publication:f.publication});
   await expect(writer.putIfAbsent(new Uint8Array(f.bytes.length),"application/json")).rejects.toThrow();
   expect(f.fetcher.mock.calls.some(([url])=>String(url).includes("/storage/v1/object/"))).toBe(false);
  }finally{f.authorization.close();}
 });
});
