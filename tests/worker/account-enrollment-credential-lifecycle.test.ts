import { readFile } from "node:fs/promises";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const driver=vi.hoisted(()=>({created:vi.fn(),connect:vi.fn(),end:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("pg-pool",()=>({default:class{
 totalCount=0;idleCount=0;waitingCount=0;
 constructor(){driver.created();}on(){}connect(){return driver.connect();}end(){return driver.end();}
}}));
import { createVaultEnrollmentCredentialStore } from "../../worker/account-enrollment/vault-credentials";
import type { EnrollmentContext,EnrollmentHttpBinding } from "../../src/server/account-enrollment/contracts";
const ownerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",operationKey="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
beforeEach(()=>{driver.created.mockReset();driver.connect.mockReset();driver.end.mockReset().mockResolvedValue(undefined);});
afterEach(()=>{vi.unstubAllGlobals();});
async function fixture(){
 const caPem=await readFile("scripts/certs/supabase-prod-ca-2021.crt","utf8"),roleName=`embel_home_web_${ownerId.replaceAll("-","")}`,reference=`accounts/${ownerId}/1/home_attachments/${operationKey}`;
 let record={version:1,ownerId,generation:1,revision:1,operationKey,capability:"home_attachments",retired:false,verifier:"fixture",providerBindingRef:null,modelVerificationReceipt:null,profileFingerprint:null,
  secrets:{database:{databaseUrl:`postgresql://${roleName}:fixture@db.fricsfwqibyhemknqgyf.supabase.co:5432/postgres?sslmode=verify-full`,caPem}}} as Record<string,unknown>,version=1;
 vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{if(url.includes("/destroy/"))return new Response(null,{status:204});
  if(init.method==="GET")return Response.json({data:{data:record,metadata:{version}}});const body=JSON.parse(init.body as string);record=body.data;version++;return Response.json({data:{version}});
 }));
 const store=createVaultEnrollmentCredentialStore({vault:{origin:"https://vault.example",mount:"embel",token:"fixture-store-token"},prefix:"accounts",database:{host:"db.fricsfwqibyhemknqgyf.supabase.co",caPem},profiles:new Map()});
 const binding:EnrollmentHttpBinding={managementVersion:2,ownerId,generation:1,revision:1,operationKey,capability:"home_attachments",roleName,roleOid:123,managerRoleName:"embel_account_role_manager",managerRoleOid:234,credentialRef:reference};
 const factory=await store.connections(reference,binding),context={claim:{ownerId,generation:1,revision:2,mode:"revoke"},step:{capability:"home_attachments",operationKey,credentialRef:reference}} as EnrollmentContext;
 return{store,factory,context,reference};
}
describe("issued lazy HTTP factory lifetime (mock driver only)",()=>{
 it("cannot recreate a pool after the credential store closes",async()=>{
  const f=await fixture();await f.store.close();await expect(f.factory.acquire(ownerId)).rejects.toThrow();expect(driver.created).not.toHaveBeenCalled();expect(driver.connect).not.toHaveBeenCalled();
 });
 it("cannot recreate a pool after the credential is retired",async()=>{
  const f=await fixture();try{await f.store.retire(f.context);await expect(f.factory.acquire(ownerId)).rejects.toThrow();expect(driver.created).not.toHaveBeenCalled();expect(driver.connect).not.toHaveBeenCalled();}finally{await f.store.close();}
 });
 it("cannot reopen a drained publication's issued factory",async()=>{
  const f=await fixture();try{await f.store.drainConnections(f.reference);await expect(f.factory.acquire(ownerId)).rejects.toThrow();expect(driver.created).not.toHaveBeenCalled();}finally{await f.store.close();}
 });
 it("discards a real checkout that resolves after the close fence",async()=>{
  const f=await fixture();let resolve!:((value:unknown)=>void);driver.connect.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const pending=f.factory.acquire(ownerId);await vi.waitFor(()=>expect(driver.connect).toHaveBeenCalledOnce());await f.store.close();
  const lease={release:vi.fn(),on:vi.fn(),removeListener:vi.fn(),query:vi.fn(),end:vi.fn()};resolve(lease);
  await expect(pending).rejects.toThrow();expect(lease.release).toHaveBeenCalledWith(true);
 });
});
