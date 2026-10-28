import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createVaultAccountHttpBindingSource,createVaultHttpBindingPublisher } from "../../worker/account-enrollment/http-publication";
import { WORKER_OBSERVATION_BODY_SHA256 } from "../../worker/account-enrollment/observation";
import type { EnrollmentContext,EnrollmentHttpBinding,EnrollmentRevocationProof } from "../../src/server/account-enrollment/contracts";

const ownerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",operationKey="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const vault={origin:"https://vault.example",mount:"embel",token:"fixture-dedicated-publication-token"};
function fixture(){
 const records=new Map<string,{data:Record<string,unknown>;version:number}>();
 const transport=vi.fn(async(raw:string,init:RequestInit)=>{const url=new URL(raw),key=url.pathname.split("/data/")[1]!.split("/").map(decodeURIComponent).join("/"),old=records.get(key);
  if(init.method==="GET")return old?Response.json({data:{data:old.data,metadata:{version:old.version}}}):new Response(null,{status:404});
  const body=JSON.parse(init.body as string),version=old?.version??0;if(body.options.cas!==version)return Response.json({errors:["check-and-set parameter did not match the current version"]},{status:400});
  records.set(key,{data:body.data,version:version+1});return Response.json({data:{version:version+1}});
 });vi.stubGlobal("fetch",transport);
 const binding:EnrollmentHttpBinding={managementVersion:2,ownerId,generation:1,revision:2,capability:"home_attachments",operationKey,
  roleName:`embel_home_web_${ownerId.replaceAll("-","")}`,roleOid:123,managerRoleName:"embel_account_role_manager",managerRoleOid:234,credentialRef:`accounts/${ownerId}/1/home_attachments/${operationKey}`};
 const step={capability:binding.capability,operationKey,phase:"provisioned" as const,effectsStarted:true,credentialRef:binding.credentialRef,publicationReceipt:null,verificationReceipt:null};
 const proof:EnrollmentRevocationProof={ownerId,generation:2,revision:3,operationKey,capability:"home_attachments",receipt:"verified:http-revocation",observedAt:new Date().toISOString(),authorityDisabled:true,runtimeStopped:true,storageDenied:true};
 const query=vi.fn(async()=>({rows:[{value:proof}]}));
 const context:EnrollmentContext={claim:{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",ownerId,generation:1,revision:2,leaseToken:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",leaseUntil:new Date(Date.now()+60000).toISOString(),mode:"enroll",steps:[step]},step,store:{operator:{query}} as unknown as EnrollmentContext["store"]};
 return{records,transport,binding,context,query,proof};
}
afterEach(()=>{vi.unstubAllGlobals();});
describe("concrete HTTP binding CAS publication and read-only source (memory Vault/SQL fixtures)",()=>{
 it("publishes no plaintext credentials and reads only a matching server-only HTTP record",async()=>{
  const f=fixture(),publisher=createVaultHttpBindingPublisher({vault,publicationPrefix:"bindings"}),pub=await publisher.publish(f.context,f.binding);
  expect(await publisher.publish(f.context,f.binding)).toEqual(pub);expect(await publisher.verify(f.context,f.binding,pub)).toEqual(pub);
  const publicValue=f.records.get(`bindings/${ownerId}/home_attachments`)!.data;expect(JSON.stringify(publicValue)).not.toContain("postgresql://");
  const caPem=await readFile("scripts/certs/supabase-prod-ca-2021.crt","utf8"),databaseUrl=`postgresql://${f.binding.roleName}:fixture-connection-password@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full`;
  f.records.set(f.binding.credentialRef,{version:1,data:{version:1,ownerId,generation:1,revision:2,operationKey,capability:"home_attachments",retired:false,secrets:{database:{databaseUrl,caPem}}}});
  f.transport.mockClear();const source=createVaultAccountHttpBindingSource({vault,publicationPrefix:"bindings",credentialPrefix:"accounts"});
  expect(await source.read(ownerId)).toMatchObject({ownerId,generation:1,revision:2,attachments:{publicationReceipt:pub.receipt,configuration:{databaseUrl,managementVersion:2,roleName:f.binding.roleName,roleOid:123}}});
  expect(f.transport.mock.calls.every(([,init])=>init.method==="GET")).toBe(true);
 });
 it("fences an older published generation/revision without overwriting the durable pointer",async()=>{
  const f=fixture(),publisher=createVaultHttpBindingPublisher({vault,publicationPrefix:"bindings"});await publisher.publish(f.context,f.binding);
  const next={...f.binding,generation:2,revision:3,credentialRef:`accounts/${ownerId}/2/home_attachments/${operationKey}`},newContext={...f.context,claim:{...f.context.claim,generation:2,revision:3},step:{...f.context.step,credentialRef:next.credentialRef}};
  await publisher.publish(newContext,next);await expect(publisher.publish(f.context,f.binding)).rejects.toThrow();expect((f.records.get(`bindings/${ownerId}/home_attachments`)!.data.binding as EnrollmentHttpBinding).generation).toBe(2);
 });
 it("withdraws and rechecks visibility before requiring independent SQL authority/Storage/drain proof",async()=>{
  const f=fixture(),drain=vi.fn(async()=>{}),publisher=createVaultHttpBindingPublisher({vault,publicationPrefix:"bindings",credentials:{drainConnections:drain}});
  await publisher.publish(f.context,f.binding);f.context.claim.mode="revoke";f.context.claim.generation=2;f.context.claim.revision=3;
  const proof=await publisher.revoke(f.context);expect(proof).toEqual(f.proof);expect(drain).toHaveBeenCalledWith(f.binding.credentialRef);
  expect(f.query).toHaveBeenCalledWith("SELECT public.verify_account_http_revocation($1,$2,$3,$4) value",[f.context.claim.id,f.context.claim.leaseToken,"home_attachments",expect.stringMatching(/^http-binding:/u)]);
  expect(await createVaultAccountHttpBindingSource({vault,publicationPrefix:"bindings",credentialPrefix:"accounts"}).read(ownerId)).toBeNull();
 });
 it("does not convert successful pointer withdrawal into a missing Storage-denial proof",async()=>{
  const f=fixture(),publisher=createVaultHttpBindingPublisher({vault,publicationPrefix:"bindings"});await publisher.publish(f.context,f.binding);
  f.context.claim.mode="revoke";f.context.claim.generation=2;f.context.claim.revision=3;
  f.query.mockResolvedValue({rows:[{value:{...f.proof,storageDenied:false} as unknown as typeof f.proof}]});
  await expect(publisher.revoke(f.context)).rejects.toThrow();expect(f.records.get(`bindings/${ownerId}/home_attachments`)!.data.state).toBe("withdrawn");
 });
 it("never resurrects the same withdrawn publication",async()=>{
  const f=fixture(),publisher=createVaultHttpBindingPublisher({vault,publicationPrefix:"bindings"});await publisher.publish(f.context,f.binding);
  const key=`bindings/${ownerId}/home_attachments`,old=f.records.get(key)!;f.records.set(key,{...old,data:{...old.data,state:"withdrawn"}});
  await expect(publisher.publish(f.context,f.binding)).rejects.toThrow();
 });
 it("CAS-proves absent partial publication with a scope tombstone and still requires SQL denial/drain proof",async()=>{
  const f=fixture(),publisher=createVaultHttpBindingPublisher({vault,publicationPrefix:"bindings"});
  f.context.claim.mode="revoke";f.context.claim.generation=2;f.context.claim.revision=3;
  await expect(publisher.revoke(f.context)).resolves.toEqual(f.proof);
  const saved=f.records.get(`bindings/${ownerId}/home_attachments`)!.data;
  expect(saved).toMatchObject({state:"withdrawn_absent",ownerId,generation:2,revision:3,operationKey});expect(saved).not.toHaveProperty("binding");
  expect(await createVaultAccountHttpBindingSource({vault,publicationPrefix:"bindings",credentialPrefix:"accounts"}).read(ownerId)).toBeNull();
  expect(f.query).toHaveBeenCalledOnce();
 });
 it("pins the exact reviewed SQL observation body rather than accepting a changed helper",async()=>{
  const sql=await readFile("supabase/candidates/account_worker_enrollment.sql","utf8"),body=/create function public\.account_worker_observation_principal\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/u.exec(sql)?.[1];
  expect(body).toBeDefined();expect(createHash("sha256").update(body!).digest("hex")).toBe(WORKER_OBSERVATION_BODY_SHA256);
 });
});
