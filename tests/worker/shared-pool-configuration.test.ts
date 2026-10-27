import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { readSharedPoolConfiguration,assertSharedPoolAttestation } from "../../worker/shared-pool/configuration";
import { readSharedPoolSecrets } from "../../worker/shared-pool/secrets";
import { sharedSlotPoolOptions } from "../../worker/shared-pool/database";
import { sharedConfiguration,sharedSecrets,sharedEnvironment } from "./shared-pool-fixture";

describe("opt-in fixed shared pool configuration (inert settings only)",()=>{
 it("is disabled without parsing settings or agent/provider environment fallbacks",()=>{
  expect(readSharedPoolConfiguration({OPENAI_API_KEY:"synthetic-agent-key",EMBEL_SHARED_WORKER_POOL_CONFIGURATION:"invalid"})).toBeNull();
  expect(readSharedPoolConfiguration({EMBEL_SHARED_WORKER_POOL_ENABLED:"false"})).toBeNull();
 });
 it("accepts only explicit finite local slots, matching static providers and actual artifact identity",()=>{
  const config=sharedConfiguration(),env=sharedEnvironment(config),parsed=readSharedPoolConfiguration(env)!;
  expect(parsed.slots).toHaveLength(3);expect(readSharedPoolSecrets(parsed,env)).toEqual(sharedSecrets(config));
  expect(()=>assertSharedPoolAttestation(parsed,{...parsed.artifact,sourceClean:false})).not.toThrow();
  expect(()=>assertSharedPoolAttestation(parsed,{...parsed.artifact,artifactSha256:"f".repeat(64),sourceClean:true})).toThrow("configuration");
  const pool=sharedSlotPoolOptions(parsed,parsed.slots[0]!,sharedSecrets(parsed).slots[parsed.slots[0]!.slotId]!);
  expect(pool.max).toBe(2);expect(pool.ssl).toBe(false);expect(pool.user).toBe(parsed.slots[0]!.roleName);expect(pool.options).not.toContain("role=");
 });
 it.each(["http://127.1:3105","http://2130706433:3105","http://0x7f000001:3105","http://localhost:3105","http://127.0.0.1:3105/","http://127.0.0.1:80","http://127.0.0.1:99999"])("rejects noncanonical local target %s",origin=>{
  const config=sharedConfiguration();config.target.applicationOrigin=origin;expect(()=>readSharedPoolConfiguration(sharedEnvironment(config))).toThrow("configuration");
 });
 it.each([{VERCEL:"1"},{VERCEL_ENV:"production"},{NODE_ENV:"production"},{EMBEL_DEVELOPMENT_ENABLED:"false"}])("rejects a hosted or unapproved local launch %#",extra=>{
  expect(()=>readSharedPoolConfiguration({...sharedEnvironment(),...extra})).toThrow("configuration");
 });
 it("qualifies an explicit isolated staging deployment and refuses preview, wrong metadata and production targets",()=>{
  const config=sharedConfiguration();config.target={kind:"vercel",purpose:"staging",applicationOrigin:"https://protected-stage.fixture.invalid",supabaseOrigin:"https://abc123def456ghi789jk.supabase.co",projectRef:"abc123def456ghi789jk",
   projectId:"prj_syntheticstaging123",deploymentId:"dpl_synthetic_staging",databaseHost:"aws-1-us-east-2.pooler.supabase.com",databasePort:5432,caSha256:"e".repeat(64)};
  config.queue.deploymentId=config.target.deploymentId;
  const env={EMBEL_SHARED_WORKER_POOL_ENABLED:"true",EMBEL_SHARED_WORKER_POOL_CONFIGURATION:JSON.stringify(config),NODE_ENV:"production",VERCEL:"1",VERCEL_ENV:"production",VERCEL_PROJECT_ID:config.target.projectId,VERCEL_DEPLOYMENT_ID:config.target.deploymentId};
  const parsed=readSharedPoolConfiguration(env)!;expect(parsed.target.kind).toBe("vercel");
  for(const extra of [{VERCEL_ENV:"preview"},{VERCEL_PROJECT_ID:"prj_wrongproject123"},{VERCEL_DEPLOYMENT_ID:"dpl_wrong"},{VERCEL:"0"}])expect(()=>readSharedPoolConfiguration({...env,...extra})).toThrow("configuration");
  expect(()=>assertSharedPoolAttestation(parsed,{...parsed.artifact,sourceClean:false})).toThrow("configuration");
  config.target.applicationOrigin="https://www.embel.xyz";expect(()=>readSharedPoolConfiguration({...env,EMBEL_SHARED_WORKER_POOL_CONFIGURATION:JSON.stringify(config)})).toThrow("configuration");
 });
 it("rejects unbounded, duplicate, lane-mismatched or incomplete slot/queue configuration",()=>{
  const mutations:Array<(c:ReturnType<typeof sharedConfiguration>)=>void>=[c=>{c.capacity.maxConcurrentExecutions=2;},c=>{c.slots.push(c.slots[0]!);},c=>{c.slots[0]!.roleName="embel_shared_naming_wrong";},c=>{c.queue.concurrency=2;},c=>{c.slots=c.slots.filter(s=>s.lane!=="logo");},c=>{c.queue.deploymentId="other-deployment";}];
  for(const mutate of mutations){
   const config=sharedConfiguration();mutate(config);expect(()=>readSharedPoolConfiguration(sharedEnvironment(config))).toThrow("configuration");
  }
 });
 it("rejects extra owner secrets, privileged DB users and missing/mismatched provider bindings",()=>{
  const config=sharedConfiguration();
  const mutations:Array<(s:ReturnType<typeof sharedSecrets>)=>void>=[s=>{s.slots["per-customer-secret"]={...s.slots[config.slots[0]!.slotId]!};},s=>{s.slots[config.slots[0]!.slotId]!.databaseUrl="postgresql://postgres:synthetic-password@127.0.0.1:54322/postgres";},s=>{s.providers.strategy.bindingRef="other";},s=>{delete s.slots[config.slots[2]!.slotId]!.storage;}];
  for(const mutate of mutations){
   const secrets=sharedSecrets(config);mutate(secrets);expect(()=>readSharedPoolSecrets(config,sharedEnvironment(config,secrets))).toThrow("secrets");
  }
 });
});
