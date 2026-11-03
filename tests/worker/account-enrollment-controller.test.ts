import { createHash } from "node:crypto";
import { mkdir,mkdtemp,realpath,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
const reporter=vi.hoisted(()=>({report:vi.fn(),strategyRoute:vi.fn(),close:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("../../worker/account-enrollment/process-reporter",()=>({createOwnerWorkerProcessReporter:()=>reporter}));
import { createOwnerWorkerProcessController } from "../../worker/account-enrollment/process-controller";
import { ownerWorkerBindingSchema,type OwnerWorkerProcessDescriptor } from "../../worker/account-enrollment/adapter";
import { readApprovedWorkerProfiles,workerProfileFingerprint } from "../../worker/account-enrollment/configuration";
import type { EnrollmentContext } from "../../src/server/account-enrollment/contracts";

/** The local child deliberately simulates engine readiness. These tests prove
 * OS/IPC controller lifecycle only, never native SQL/model/production readiness. */
async function fixture(){
 reporter.report.mockReset();reporter.close.mockReset().mockResolvedValue(undefined);reporter.strategyRoute.mockReset();
 // Real path: macOS tmpdir() is /var, a link to /private/var.
 const directory=await realpath(await mkdtemp(join(tmpdir(),"embel-controller-fixture-"))),artifact=join(directory,"artifact"),publication=join(directory,"publications");
 await mkdir(artifact,{mode:0o700});await mkdir(publication,{mode:0o700});
 const child=`import {readFile} from 'node:fs/promises';
const manifest=JSON.parse(await readFile(new URL('./build-manifest.json',import.meta.url),'utf8'));
process.send({type:'hello',artifactSha256:manifest.artifactSha256});
process.on('message',message=>{if(message.type==='start'){const b=message.descriptor.binding;process.send({type:'ready',notice:{workerId:b.workerId,roleOid:b.roleOid,observedAt:new Date().toISOString(),storageSessionId:null}});}if(message.type==='deliver')process.send({type:'delivery',id:message.id,result:{disposition:'ack',state:'succeeded'}});});
process.on('SIGTERM',()=>process.send({type:'drained'},()=>process.exit(0)));process.on('disconnect',()=>process.exit(0));`;
 const raster="// inert controller fixture: no raster engine is invoked\n",indexSha256=createHash("sha256").update(child).digest("hex"),rasterSha256=createHash("sha256").update(raster).digest("hex"),artifactSha256=createHash("sha256").update(JSON.stringify({indexSha256,rasterSha256})).digest("hex");
 await writeFile(join(artifact,"index.js"),child);await writeFile(join(artifact,"raster.js"),raster);await writeFile(join(artifact,"package.json"),'{"type":"module"}');
 await writeFile(join(artifact,"build-manifest.json"),JSON.stringify({version:1,sourceRevision:"a".repeat(40),sourceClean:true,bundleSha256:indexSha256,rasterSha256,artifactSha256}));
 const profile=readApprovedWorkerProfiles([{profileId:"fixture:strategy",providerBindingRef:"fixture:provider",modelVerificationReceipt:"fixture:model",applicationOrigin:"https://www.embel.xyz",supabaseOrigin:"https://fricsfwqibyhemknqgyf.supabase.co",projectId:"prj_fixturecontroller",deploymentId:"dpl_fixturecontroller",sourceRevision:"a".repeat(40),artifactSha256,managedProofSha256:"c".repeat(64),runtime:{node:"22.22.2",icu:"77.1",unicode:"16.0",platform:"linux",arch:"x64"},dispatchApproved:true,capability:"strategy",model:"gpt-6.1-sol",admissionContract:"hosted_strategy_owner_uncapped_v1",spendControl:"uncapped",policyIdentities:{"strategy.reformulate":"d".repeat(64),"strategy.competitors":"e".repeat(64),"strategy.audience":"f".repeat(64),"strategy.personality":"1".repeat(64)}}]).get("strategy")!;
 const binding=ownerWorkerBindingSchema.parse({ownerId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",generation:1,revision:2,operationKey:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",capability:"strategy",roleName:"fluid_api_text_worker_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",roleOid:123,credentialRef:"fixture/credential",workerId:"fixture-worker",deploymentId:profile.deploymentId,profileFingerprint:workerProfileFingerprint(profile),storageAuthUserId:null});
 const descriptor:OwnerWorkerProcessDescriptor={version:1,binding,profile},state={stale:false,suspended:false,stopped:false};
 reporter.report.mockImplementation(async(_binding,state_)=>{if(state_==="stopped")state.stopped=true;});
 reporter.strategyRoute.mockResolvedValue(binding);
 const query=vi.fn(async(sql:string)=>{
  if(sql.includes("read_account_worker_enrollment"))return{rows:[{value:{descriptor,heartbeat:state.suspended?null:{workerId:binding.workerId,roleOid:binding.roleOid,observedAt:new Date(Date.now()-(state.stale?60_000:0)).toISOString(),storageSessionId:null},restartAllowed:state.suspended&&state.stopped}}]};
  if(sql.includes("suspend_account_worker_enrollment")){state.suspended=true;return{rows:[{value:true}]};}
  if(sql.includes("resume_account_worker_enrollment")){state.suspended=false;state.stale=false;return{rows:[{value:descriptor}]};}throw Error("unreviewed fixture SQL");
 });
 const step={capability:"strategy",operationKey:binding.operationKey,phase:"ready",effectsStarted:true,credentialRef:binding.credentialRef,publicationReceipt:null,verificationReceipt:null};
 const context={claim:{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",ownerId:binding.ownerId,generation:1,revision:2,leaseToken:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",leaseUntil:new Date(Date.now()+120000).toISOString(),mode:"enroll",steps:[step]},step,store:{operator:{query}}} as unknown as EnrollmentContext;
 const transport=vi.fn(async()=>Response.json({data:{data:{version:1,...binding,providerBindingRef:profile.providerBindingRef,modelVerificationReceipt:profile.modelVerificationReceipt,secrets:{fixture:true}}}}));
 // Reader accepts only its explicit scope fields, not the other binding fields.
 transport.mockImplementation(async()=>Response.json({data:{data:{version:1,ownerId:binding.ownerId,generation:1,revision:2,operationKey:binding.operationKey,capability:"strategy",providerBindingRef:profile.providerBindingRef,modelVerificationReceipt:profile.modelVerificationReceipt,secrets:{fixture:true}}}}));vi.stubGlobal("fetch",transport);
 const controller=createOwnerWorkerProcessController({artifactDirectory:artifact,publicationDirectory:publication,vault:{origin:"https://vault.example",mount:"embel",token:"fixture-controller-token"},reporter:{database:{databaseUrl:"unused-fixture",caPem:"unused-fixture"},roleName:"embel_worker_launcher_fixture",roleOid:456,trustedCreatorRoleOid:789}});
 return{controller,context,descriptor,state,query,transport,async cleanup(){await controller.close();await rm(directory,{recursive:true,force:true});}};
}
afterEach(()=>{vi.unstubAllGlobals();});
describe("actual inert child lifecycle with mocked SQL/reporter authority",()=>{
 it("refreshes proof only from a live connected child plus a fresh independent heartbeat",async()=>{
  const f=await fixture();try{const publication=await f.controller.publish(f.context,f.descriptor);await f.controller.inspect(f.context,f.descriptor,publication);
   const observed=await f.controller.maintain(f.context);expect(observed.workerId).toBe(f.descriptor.binding.workerId);expect(reporter.report).toHaveBeenCalledTimes(2);expect(f.transport).toHaveBeenCalledOnce();
   expect(f.query.mock.calls.some(([sql])=>sql.includes("provision_"))).toBe(false);
  }finally{await f.cleanup();}
 });
 it("suspends and observes real child exit before SQL-authorized same-binding restart",async()=>{
  const f=await fixture();try{const publication=await f.controller.publish(f.context,f.descriptor);await f.controller.inspect(f.context,f.descriptor,publication);f.state.stale=true;
   const proof=await f.controller.maintain(f.context);expect(proof.operationKey).toBe(f.descriptor.binding.operationKey);expect(f.transport).toHaveBeenCalledTimes(2);
   expect(reporter.report.mock.calls.map(([,state])=>state)).toEqual(["running","stopped","running"]);expect(f.query.mock.calls.some(([sql])=>sql.includes("resume_"))).toBe(true);
  }finally{await f.cleanup();}
 });
 it("does not invent a stopped receipt or start an unknown old supervisor's process",async()=>{
  const f=await fixture();try{await expect(f.controller.maintain(f.context)).rejects.toThrow();expect(f.transport).not.toHaveBeenCalled();expect(reporter.report).not.toHaveBeenCalled();expect(f.query).toHaveBeenCalledOnce();}finally{await f.cleanup();}
 });
 it("preserves an authoritative never-provisioned SQL proof without claiming an OS process stopped",async()=>{
  const f=await fixture();try{f.context.claim.mode="revoke";
   const proof={ownerId:f.context.claim.ownerId,generation:1,revision:2,operationKey:f.context.step.operationKey,capability:"strategy",receipt:"never-provisioned:fixture",observedAt:new Date().toISOString(),scope:"never_provisioned",authorityAbsent:true,authorityDisabled:true,storageDenied:true};
   f.query.mockResolvedValue({rows:[{value:proof}]} as unknown as Awaited<ReturnType<typeof f.query>>);
   expect(await f.controller.revoke(f.context)).toEqual(proof);expect(proof).not.toHaveProperty("runtimeStopped");expect(reporter.report).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
  }finally{await f.cleanup();}
 });
});
