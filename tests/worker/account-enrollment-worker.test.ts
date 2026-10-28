import { createHash } from "node:crypto";
import { chmod,mkdtemp,readFile,rm,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createOwnerWorkerEnrollmentAdapter,type OwnerWorkerBinding,type OwnerWorkerProcessDescriptor } from "../../worker/account-enrollment/adapter";
import { readApprovedWorkerProfiles,workerProfileFingerprint,ownerWorkerRole,type ApprovedWorkerProfile } from "../../worker/account-enrollment/configuration";
import { createPreparedWorkerDescriptorPublisher } from "../../worker/account-enrollment/prepared-publication";
import { createOwnerWorkerVaultReader } from "../../worker/account-enrollment/secret-store";
import { ownerWorkerPoolOptions,assertOwnerWorkerArtifact } from "../../worker/account-enrollment/process-qualification";
import type { EnrollmentClaim,EnrollmentContext,EnrollmentStore } from "../../src/server/account-enrollment/contracts";

const ownerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",operationKey="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const profile:ApprovedWorkerProfile={profileId:"approved:strategy-v1",providerBindingRef:"provider:dedicated",modelVerificationReceipt:"model:verified",
 applicationOrigin:"https://www.embel.xyz",supabaseOrigin:"https://fricsfwqibyhemknqgyf.supabase.co",projectId:"prj_1234567890abc",deploymentId:"dpl_qualified",
 sourceRevision:"a".repeat(40),artifactSha256:"b".repeat(64),managedProofSha256:"c".repeat(64),runtime:{node:"22.22.2",icu:"77.1",unicode:"16.0",platform:"linux",arch:"x64"},dispatchApproved:true,
 capability:"strategy",model:"gpt-6.1-sol",admissionContract:"hosted_strategy_owner_uncapped_v1",spendControl:"uncapped",policyIdentities:{"strategy.reformulate":"d".repeat(64),"strategy.competitors":"e".repeat(64),"strategy.audience":"f".repeat(64),"strategy.personality":"1".repeat(64)}};
function fixture(){
 let claim:EnrollmentClaim={id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",ownerId,generation:1,revision:2,leaseToken:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",leaseUntil:"2030-01-01T00:00:00Z",mode:"enroll",
  steps:["home_attachments","identity_transactions","strategy","naming","logo"].map(capability=>({capability:capability as EnrollmentClaim["steps"][number]["capability"],operationKey,phase:"pending",effectsStarted:false,credentialRef:null,publicationReceipt:null,verificationReceipt:null}))};
 const binding:OwnerWorkerBinding={ownerId,generation:1,revision:2,operationKey,capability:"strategy",roleName:ownerWorkerRole("strategy",ownerId),roleOid:12345,
  credentialRef:"workers/owner-a/strategy",workerId:"owner-worker-a",deploymentId:profile.deploymentId,profileFingerprint:workerProfileFingerprint(profile),storageAuthUserId:null};
 const descriptor:OwnerWorkerProcessDescriptor={version:1,binding,profile},events:string[]=[];
 const query=vi.fn(async(sql:string)=>{events.push(sql.includes("adopt_")?"adopt":sql.includes("publish_")?"publish-sql":"verify-sql");
  if(sql.includes("adopt_"))return{rows:[{value:binding}]};return{rows:[{value:true}]};});
 const store={operator:{query},read:vi.fn(async()=>claim),record:vi.fn(async(_claim,capability,phase)=>{events.push(`record:${phase}`);claim={...claim,steps:claim.steps.map(step=>step.capability===capability?{...step,phase,effectsStarted:phase==="provisioning"||step.effectsStarted}:step)};return claim;})} as unknown as EnrollmentStore;
 const context=():EnrollmentContext=>({claim,step:claim.steps.find(step=>step.capability==="strategy")!,store});
 const reservation={reference:binding.credentialRef,verifier:`SCRAM-SHA-256$4096:${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(32).toString("base64")}:${Buffer.alloc(32).toString("base64")}`};
 const credentials={reserve:vi.fn(async()=>{events.push("reserve");return reservation;}),retire:vi.fn(async()=>{})};
 const now=Date.parse("2026-10-27T12:00:00Z");
 const proof={ownerId,generation:1,revision:2,operationKey,capability:"strategy" as const,receipt:"runtime:verified",observedAt:new Date(now).toISOString(),profileFingerprint:binding.profileFingerprint,roleOid:binding.roleOid,workerId:binding.workerId,sourceRevision:profile.sourceRevision,artifactSha256:profile.artifactSha256,storageSessionId:null};
 const controller={prepare:vi.fn(async()=>{events.push("prepare");return binding;}),publish:vi.fn(async()=>{events.push("publish-process");return{ownerId,generation:1,revision:2,operationKey,capability:"strategy" as const,receipt:"prepared:descriptor"};}),
  inspect:vi.fn(async()=>{events.push("inspect");return proof;}),revoke:vi.fn()};
 return{context,binding,descriptor,events,store,credentials,controller,proof,now};
}
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe("configured per-owner worker enrollment protocol (fixture authority only)",()=>{
 it("keeps missing configuration blocked before credential reservation",async()=>{
  const f=fixture();await createOwnerWorkerEnrollmentAdapter({profiles:new Map(),credentials:f.credentials,controller:f.controller}).reconcile(f.context());
  expect(f.credentials.reserve).not.toHaveBeenCalled();expect(f.events).toEqual(["record:blocked"]);
 });
 it("durably marks effects before reservation and requires runtime proof before SQL publication/readiness",async()=>{
  const f=fixture();await createOwnerWorkerEnrollmentAdapter({profiles:readApprovedWorkerProfiles([profile]),credentials:f.credentials,controller:f.controller,now:()=>f.now}).reconcile(f.context());
  expect(f.events).toEqual(["record:provisioning","reserve","prepare","adopt","publish-process","inspect","publish-sql","verify-sql"]);
  expect(f.store.record).not.toHaveBeenCalledWith(expect.anything(),"strategy","ready",expect.anything());
 });
 it("rejects a different owner binding before process publication",async()=>{
  const f=fixture();f.controller.prepare.mockResolvedValue({...f.binding,ownerId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"});
  await expect(createOwnerWorkerEnrollmentAdapter({profiles:readApprovedWorkerProfiles([profile]),credentials:f.credentials,controller:f.controller}).reconcile(f.context())).rejects.toThrow();
  expect(f.controller.publish).not.toHaveBeenCalled();
 });
 it.each(["stale","revision","role","artifact"])("does not publish enrollment from %s process proof",async mode=>{
  const f=fixture();if(mode==="stale")f.proof.observedAt=new Date(f.now-30_001).toISOString();if(mode==="revision")f.proof.revision=1;if(mode==="role")f.proof.roleOid++;if(mode==="artifact")f.proof.artifactSha256="0".repeat(64);
  await expect(createOwnerWorkerEnrollmentAdapter({profiles:readApprovedWorkerProfiles([profile]),credentials:f.credentials,controller:f.controller,now:()=>f.now}).reconcile(f.context())).rejects.toThrow();
  expect(f.events).not.toContain("publish-sql");expect(f.events).not.toContain("verify-sql");
 });
 it("rejects duplicate capability profiles and unsupported models",()=>{
  expect(()=>readApprovedWorkerProfiles([profile,profile])).toThrow();expect(()=>readApprovedWorkerProfiles([{...profile,model:"invented"}])).toThrow();
 });
 it("maintains an enrolled worker through real-proof ports without reserving credentials or reprovisioning roles",async()=>{
  const f=fixture(),context=f.context();context.step.phase="ready";context.step.effectsStarted=true;
  const controller={...f.controller,maintain:vi.fn(async()=>f.proof),suspend:vi.fn(async()=>{})};
  await createOwnerWorkerEnrollmentAdapter({profiles:readApprovedWorkerProfiles([profile]),credentials:f.credentials,controller,now:()=>f.now}).maintain!(context);
  expect(controller.maintain).toHaveBeenCalledOnce();expect(f.credentials.reserve).not.toHaveBeenCalled();expect(controller.prepare).not.toHaveBeenCalled();
  expect(f.events).toEqual(["verify-sql"]);expect(controller.suspend).not.toHaveBeenCalled();
 });
 it("suspends new admission when a saved startup proof is too old without destroying credentials",async()=>{
  const f=fixture(),context=f.context();context.step.phase="ready";context.step.effectsStarted=true;f.proof.observedAt=new Date(f.now-30_001).toISOString();
  const controller={...f.controller,maintain:vi.fn(async()=>f.proof),suspend:vi.fn(async()=>{})};
  await expect(createOwnerWorkerEnrollmentAdapter({profiles:readApprovedWorkerProfiles([profile]),credentials:f.credentials,controller,now:()=>f.now}).maintain!(context)).rejects.toThrow();
  expect(controller.suspend).toHaveBeenCalledOnce();expect(f.credentials.retire).not.toHaveBeenCalled();expect(controller.revoke).not.toHaveBeenCalled();expect(f.events).not.toContain("verify-sql");
 });
});
describe("durable prepared descriptors",()=>{
 it("stores public fields only, idempotently, and fences older generation/revision",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"embel-worker-publication-"));await chmod(directory,0o700);
  try{
   const f=fixture(),publisher=createPreparedWorkerDescriptorPublisher(directory);
   const publication=await publisher.publish(f.context(),{...f.descriptor,secret:"must-not-persist"} as OwnerWorkerProcessDescriptor);
   expect(await publisher.publish(f.context(),f.descriptor)).toEqual(publication);await expect(publisher.verify(f.context(),publication)).resolves.toEqual(publication);
   const stored=await readFile(join(directory,ownerId,"strategy","1-2.json"),"utf8");expect(stored).not.toContain("must-not-persist");
   const newer={...f.context(),claim:{...f.context().claim,revision:3}};
   await publisher.publish(newer,{...f.descriptor,binding:{...f.binding,revision:3}});
   await expect(publisher.verify(f.context(),publication)).rejects.toThrow();await expect(publisher.publish(f.context(),f.descriptor)).rejects.toThrow();
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 it("rejects symlink publication roots",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"embel-worker-link-"));await chmod(directory,0o700);
  try{await symlink(directory,`${directory}-link`);const f=fixture();await expect(createPreparedWorkerDescriptorPublisher(`${directory}-link`).publish(f.context(),f.descriptor)).rejects.toThrow();}
  finally{await rm(`${directory}-link`,{force:true});await rm(directory,{recursive:true,force:true});}
 });
});
describe("explicit process-only secrets and actual artifact gates",()=>{
 it("reads only a bound dedicated Vault KV-v2 record, with bounded redirect-free protocol",async()=>{
  const f=fixture(),transport=vi.fn(async()=>Response.json({data:{data:{version:1,ownerId,generation:1,revision:2,operationKey,capability:"strategy",providerBindingRef:profile.providerBindingRef,modelVerificationReceipt:profile.modelVerificationReceipt,secrets:{opaque:"memory-only"}}}}));vi.stubGlobal("fetch",transport);
  const reader=createOwnerWorkerVaultReader({origin:"https://vault.example",mount:"embel",token:"dedicated-test-token"});
  await expect(reader.read(f.descriptor)).resolves.toEqual({opaque:"memory-only"});expect(transport).toHaveBeenCalledWith("https://vault.example/v1/embel/data/workers/owner-a/strategy",expect.objectContaining({method:"GET",redirect:"error",credentials:"omit"}));
 });
 it.each(["owner","attestation","oversized"])("rejects %s secret response without leaking its body",async mode=>{
  const f=fixture(),payload={version:1,ownerId:mode==="owner"?"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee":ownerId,generation:1,revision:2,operationKey,capability:"strategy",providerBindingRef:profile.providerBindingRef,modelVerificationReceipt:profile.modelVerificationReceipt,secrets:mode==="attestation"?{attestation:{}}:{secret:"test-secret-do-not-log"}};
  vi.stubGlobal("fetch",vi.fn(async()=>mode==="oversized"?new Response("x".repeat(131073)):Response.json({data:{data:payload}})));
  await expect(createOwnerWorkerVaultReader({origin:"https://vault.example",mount:"embel",token:"dedicated-test-token"}).read(f.descriptor)).rejects.toThrow("Owner worker secret store is unavailable");
 });
 it("ignores ambient PG options/native selection and preserves dedicated verify-full connection options",async()=>{
  const f=fixture(),caPem=await readFile("scripts/certs/supabase-prod-ca-2021.crt","utf8");
  expect(createHash("sha256").update(caPem).digest("hex")).toBe("700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7");
  vi.stubEnv("PGOPTIONS","-c row_security=off");vi.stubEnv("NODE_PG_FORCE_NATIVE","1");
  const options=ownerWorkerPoolOptions(f.descriptor,{databaseUrl:`postgresql://${f.binding.roleName}:synthetic@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full`,caPem});
  expect(options.options).toContain("row_security=on");expect(options.ssl).toMatchObject({rejectUnauthorized:true,ca:caPem});expect(options.client_encoding).toBe("UTF8");
  expect(()=>ownerWorkerPoolOptions(f.descriptor,{databaseUrl:"postgresql://postgres:x@127.0.0.1:5432/postgres?sslmode=disable",caPem})).toThrow();
 });
 it("never accepts parsed descriptors as actual clean deployment/runtime proof",()=>{
  const f=fixture();expect(()=>assertOwnerWorkerArtifact(f.descriptor,{sourceClean:false,sourceRevision:profile.sourceRevision,artifactSha256:profile.artifactSha256,deploymentId:profile.deploymentId,runtime:profile.runtime})).toThrow();
 });
});
