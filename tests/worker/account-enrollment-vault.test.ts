import { createHash,createHmac,pbkdf2Sync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createVaultEnrollmentCredentialStore } from "../../worker/account-enrollment/vault-credentials";
import { createOwnerWorkerVaultReader } from "../../worker/account-enrollment/secret-store";
import { readApprovedWorkerProfiles,workerProfileFingerprint } from "../../worker/account-enrollment/configuration";
import { ownerWorkerChildEnvironment } from "../../worker/account-enrollment/process-controller";
import { isOwnerWorkerObservationStatement } from "../../worker/account-enrollment/observation";
import type { EnrollmentClaim,EnrollmentContext } from "../../src/server/account-enrollment/contracts";

const ownerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",operationKey="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function context(capability:EnrollmentClaim["steps"][number]["capability"]="home_attachments"):EnrollmentContext{
 const step={capability,operationKey,phase:"provisioning" as const,effectsStarted:true,credentialRef:null,publicationReceipt:null,verificationReceipt:null};
 return{claim:{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",ownerId,generation:1,revision:2,leaseToken:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",leaseUntil:new Date(Date.now()+60_000).toISOString(),mode:"enroll",steps:[step]},step,store:{} as EnrollmentContext["store"]};
}
function vaultFixture(){
 const records=new Map<string,{data:Record<string,unknown>;version:number}>(),destroyed:unknown[]=[];let loseWrite=false;
 const transport=vi.fn(async(raw:string,init:RequestInit)=>{
  const url=new URL(raw),match=/\/v1\/embel\/(data|destroy)\/(.+)$/u.exec(url.pathname);if(!match)throw Error("unexpected fixture request");
  const ref=match[2]!.split("/").map(decodeURIComponent).join("/");
  expect(init.redirect).toBe("error");expect(init.credentials).toBe("omit");
  if(init.method==="GET"){const value=records.get(ref);return value?Response.json({data:{data:value.data,metadata:{version:value.version,destroyed:false,deletion_time:""}}}):new Response(null,{status:404});}
  const body=JSON.parse(init.body as string);
  if(match[1]==="destroy"){destroyed.push({ref,...body});return new Response(null,{status:204});}
  const old=records.get(ref),version=old?.version??0;if(body.options.cas!==version)return Response.json({errors:["check-and-set parameter did not match the current version"]},{status:400});
  records.set(ref,{data:body.data,version:version+1});if(loseWrite){loseWrite=false;throw Error("fixture lost write acknowledgement");}return Response.json({data:{version:version+1}});
 });
 vi.stubGlobal("fetch",transport);
 return{records,destroyed,transport,loseNextWrite(){loseWrite=true;}};
}
async function configuration(){return{vault:{origin:"https://vault.example",mount:"embel",token:"fixture-dedicated-store-token"},prefix:"accounts",database:{host:"db.fricsfwqibyhemknqgyf.supabase.co" as const,caPem:await readFile("scripts/certs/supabase-prod-ca-2021.crt","utf8")},profiles:readApprovedWorkerProfiles([])};}
afterEach(()=>{vi.unstubAllGlobals();});
describe("optional concrete Vault credential store (memory HTTP fixture, no configured backend)",()=>{
 it("atomically reserves a stable high-entropy owner credential and exposes only opaque reference/SCRAM",async()=>{
  const f=vaultFixture(),store=createVaultEnrollmentCredentialStore(await configuration()),c=context();
  try{const first=await store.reserve(c),second=await store.reserve(c);expect(second).toEqual(first);expect(Object.keys(first).sort()).toEqual(["reference","verifier"]);
   const stored=f.records.get(first.reference)!;expect(stored.version).toBe(1);
   const secret=stored.data.secrets as{database:{databaseUrl:string}},url=new URL(secret.database.databaseUrl),password=decodeURIComponent(url.password);
   expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/u);expect(url.username).toBe(`embel_home_web_${ownerId.replaceAll("-","")}`);
   const match=/^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/u.exec(first.verifier)!;
   const salted=pbkdf2Sync(password,Buffer.from(match[1]!,"base64"),4096,32,"sha256"),client=createHmac("sha256",salted).update("Client Key").digest();
   expect(match[2]).toBe(createHash("sha256").update(client).digest("base64"));expect(match[3]).toBe(createHmac("sha256",salted).update("Server Key").digest("base64"));
   expect(f.transport.mock.calls.filter(([,init])=>init.method==="POST")).toHaveLength(1);
  }finally{await store.close();}
 });
 it("recovers the same committed reservation after a lost Vault write acknowledgement",async()=>{
  const f=vaultFixture(),store=createVaultEnrollmentCredentialStore(await configuration()),c=context();
  try{f.loseNextWrite();await expect(store.reserve(c)).rejects.toMatchObject({reason:"store_unavailable",uncertain:true});
   const existing=[...f.records.values()][0]!.data;const recovered=await store.reserve(c);expect(recovered.verifier).toBe(existing.verifier);expect(f.records.size).toBe(1);
  }finally{await store.close();}
 });
 it("refuses reservation before durable effect marking, after lease expiry, or during revocation",async()=>{
  const f=vaultFixture(),store=createVaultEnrollmentCredentialStore(await configuration());
  try{for(const mode of["unmarked","expired","revoking"]){const c=context();if(mode==="unmarked")c.step.effectsStarted=false;if(mode==="expired")c.claim.leaseUntil=new Date(0).toISOString();if(mode==="revoking")c.claim.mode="revoke";await expect(store.reserve(c)).rejects.toThrow();}
   expect(f.transport).not.toHaveBeenCalled();
  }finally{await store.close();}
 });
 it("retains a durable retirement tombstone and destroys earlier secret versions idempotently",async()=>{
  const f=vaultFixture(),store=createVaultEnrollmentCredentialStore(await configuration()),c=context();
  try{const reserved=await store.reserve(c);c.claim.mode="revoke";c.claim.generation=2;c.claim.revision=3;c.step.credentialRef=reserved.reference;
   await store.retire(c);await store.retire(c);expect(f.records.get(reserved.reference)).toMatchObject({version:2,data:{retired:true,verifier:null,secrets:null}});
   expect(f.destroyed).toEqual([{ref:reserved.reference,versions:[1]},{ref:reserved.reference,versions:[1]}]);
   c.claim.mode="enroll";c.claim.generation=1;c.claim.revision=2;await expect(store.reserve(c)).rejects.toMatchObject({reason:"store_unavailable"});
  }finally{await store.close();}
 });
 it("recovers and retires an unacknowledged reservation after an eligibility revision changes",async()=>{
  const f=vaultFixture(),store=createVaultEnrollmentCredentialStore(await configuration()),c=context();
  try{f.loseNextWrite();await expect(store.reserve(c)).rejects.toThrow();const ref=[...f.records.keys()][0]!;
   c.claim.mode="revoke";c.claim.revision++;expect(c.step.credentialRef).toBeNull();await store.retire(c);
   expect(f.records.get(ref)).toMatchObject({version:2,data:{retired:true,secrets:null}});expect(f.destroyed).toEqual([{ref,versions:[1]}]);
  }finally{await store.close();}
 });
 it("CAS-fences an absent partial reservation without inventing a password",async()=>{
  const f=vaultFixture(),store=createVaultEnrollmentCredentialStore(await configuration()),c=context();
  try{c.claim.mode="revoke";await store.retire(c);expect([...f.records.values()]).toEqual([{version:1,data:expect.objectContaining({retired:true,verifier:null,secrets:null})}]);
   c.claim.mode="enroll";await expect(store.reserve(c)).rejects.toThrow();expect(f.records.size).toBe(1);
  }finally{await store.close();}
 });
 it("builds a worker record from an existing explicitly approved provider record and keeps attestation outside secrets",async()=>{
  const f=vaultFixture(),config=await configuration();
  const profiles=readApprovedWorkerProfiles([{profileId:"approved-naming",providerBindingRef:"providers/naming",modelVerificationReceipt:"receipt:model",applicationOrigin:"https://www.embel.xyz",supabaseOrigin:"https://fricsfwqibyhemknqgyf.supabase.co",projectId:"prj_1234567890ab",deploymentId:"dpl_qualified",sourceRevision:"a".repeat(40),artifactSha256:"b".repeat(64),managedProofSha256:"c".repeat(64),runtime:{node:"22.22.2",icu:"77.1",unicode:"16.0",platform:"linux",arch:"x64"},dispatchApproved:true,capability:"naming",model:"gpt-6-luna",admissionContract:"hosted_owner_v1",providerBudgetVersion:2,spendControl:"uncapped",policyIdentity:"d".repeat(64)}]),profile=profiles.get("naming")!;
  f.records.set(profile.providerBindingRef,{version:1,data:{version:1,providerBindingRef:profile.providerBindingRef,modelVerificationReceipt:profile.modelVerificationReceipt,capability:"naming",profileFingerprint:workerProfileFingerprint(profile),secrets:{provider:{apiKey:"fixture-never-sent-provider-key",model:profile.model,modelVerificationReceipt:profile.modelVerificationReceipt},policy:{fixture:true}}}});
  const store=createVaultEnrollmentCredentialStore({...config,profiles}),c=context("naming");
  try{const reservation=await store.reserve(c);const descriptor={version:1 as const,binding:{ownerId,generation:1,revision:2,operationKey,capability:"naming" as const,roleName:`fluid_naming_brain_worker_${ownerId.replaceAll("-","")}`,roleOid:123,credentialRef:reservation.reference,workerId:"fixture-naming",deploymentId:profile.deploymentId,profileFingerprint:workerProfileFingerprint(profile),storageAuthUserId:null},profile};
   const loaded=await createOwnerWorkerVaultReader(config.vault).read(descriptor);expect(loaded).toMatchObject({provider:{model:"gpt-6-luna"},policy:{fixture:true}});expect(loaded).not.toHaveProperty("attestation");expect(loaded).not.toHaveProperty("verifier");
  }finally{await store.close();}
 });
});
describe("process policy boundaries",()=>{
 it("inherits configured proxy/CA trust and actual deployment metadata without ambient app or driver secrets",()=>{
  const env=ownerWorkerChildEnvironment({NODE_ENV:"test",VERCEL:"1",VERCEL_ENV:"production",VERCEL_PROJECT_ID:"prj_actual",VERCEL_DEPLOYMENT_ID:"dpl_actual",HTTPS_PROXY:"http://session-proxy",https_proxy:"http://session-proxy",NO_PROXY:"127.0.0.1",NODE_EXTRA_CA_CERTS:"/trusted/ca.pem",SSL_CERT_FILE:"/trusted/ca.pem",NODE_USE_ENV_PROXY:"1",OPENAI_API_KEY:"must-not-copy",PGPASSWORD:"must-not-copy",PGOPTIONS:"must-not-copy",NODE_OPTIONS:"must-not-copy",NODE_PG_FORCE_NATIVE:"1",AWS_SECRET_ACCESS_KEY:"must-not-copy"});
  expect(env).toMatchObject({VERCEL_PROJECT_ID:"prj_actual",HTTPS_PROXY:"http://session-proxy",https_proxy:"http://session-proxy",NODE_EXTRA_CA_CERTS:"/trusted/ca.pem",SSL_CERT_FILE:"/trusted/ca.pem",NODE_USE_ENV_PROXY:"1"});
  for(const key of["OPENAI_API_KEY","PGPASSWORD","PGOPTIONS","NODE_OPTIONS","NODE_PG_FORCE_NATIVE","AWS_SECRET_ACCESS_KEY"])expect(env).not.toHaveProperty(key);
 });
 it("permits only immutable paid-observation/accounting statements in the drain wrapper",()=>{
  expect(isOwnerWorkerObservationStatement("select public.record_logo_provider_response($1,$2,$3) value")).toBe(true);
  expect(isOwnerWorkerObservationStatement("select * from public.complete_job_step($1, $2, $3, $4, $5, $6, $7)")).toBe(true);
  for(const sql of["select * from public.claim_logo_job($1,$2)","select public.begin_logo_job_step($1,$2,$3,$4,$5) value","select * from public.claim_job($1, $2)","select public.report_logo_worker_ready($1,$2,$3) value","select public.stage_logo_asset($1,$2,$3)","select * from public.finish_job($1, $2, $3, $4); select 1"]){expect(isOwnerWorkerObservationStatement(sql)).toBe(false);}
 });
});
