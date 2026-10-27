import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const doubles=vi.hoisted(()=>{
 const engine={run:vi.fn(async()=>({disposition:"ack" as const,state:"succeeded"})),recover:vi.fn(async()=>({disposition:"retry" as const,state:"observation_retained"})),close:vi.fn(async()=>{})};
 const session={authUserId:"55555555-5555-4555-8555-555555555555",sessionId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",tokenProvider:vi.fn(async()=>"synthetic-inert-token"),close:vi.fn(async()=>{})};
 const factory=(options:unknown)=>{void options;return engine;};
 const native={preflight:vi.fn(async()=>{}),assertRuntimeAvailable:vi.fn(async()=>{}),invalidate:vi.fn(),close:vi.fn(async()=>{})};
 return{engine,session,native,strategy:vi.fn(factory),naming:vi.fn(factory),logo:vi.fn(factory),storageSession:vi.fn(async(options:unknown)=>{void options;return session;}),authorization:vi.fn(),developmentNative:vi.fn(()=>native),packagedNative:vi.fn(()=>native)};
});
vi.mock("../../worker/shared-lanes/strategy",()=>({createSharedStrategyLaneEngine:doubles.strategy}));
vi.mock("../../worker/shared-lanes/naming",()=>({createSharedNamingLaneEngine:doubles.naming}));
vi.mock("../../worker/shared-lanes/logo",()=>({createSharedLogoLaneEngine:doubles.logo}));
vi.mock("../../worker/shared-storage/session",()=>({createSharedSlotStorageSession:doubles.storageSession}));
vi.mock("../../worker/shared-storage/authorization",()=>({createSharedLogoStorageAuthorization:doubles.authorization}));
vi.mock("../../worker/shared-pool/logo-native-qualification",()=>({createDevelopmentSharedLogoProductionRuntimeQualification:doubles.developmentNative,createPackagedLogoProductionRuntimeQualification:doubles.packagedNative}));
import { createSharedPoolLaneEngine,createSharedPoolRuntime } from "../../worker/shared-pool/runtime";
import { sharedConfiguration,sharedEnvironment,sharedLease,sharedSecrets } from "./shared-pool-fixture";
import type { SharedPendingExecution } from "../../worker/shared-pool/contracts";
const readyDatabase=()=>({query:vi.fn(async(...parameters:unknown[])=>{void parameters;return{rows:[{envelope:{execution:null,result:true}}]};}),qualify:vi.fn(async()=>{}),close:vi.fn(async()=>{})});
const nativeCapability={operation:"identity.logo_vectorize",handlerVersion:"1",policyIdentity:"a".repeat(64),provider:null,model:null,maxCostMicrousd:0,
 engine:{id:"vtracer",version:"1.0.0-alpha.4",artifactHash:"63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45"}};
afterEach(()=>vi.clearAllMocks());
describe("actual runtime composition boundaries (explicit inert engine/session ports)",()=>{
 it("does not construct any privileged resource while disabled",()=>{
  const config=sharedConfiguration(),pool=vi.fn(),engine=vi.fn();
  expect(createSharedPoolRuntime({EMBEL_SHARED_WORKER_POOL_ENABLED:"false"},{...config.artifact,sourceClean:false},{createPool:pool,createEngine:engine})).toBeNull();
  expect(pool).not.toHaveBeenCalled();expect(engine).not.toHaveBeenCalled();expect(doubles.storageSession).not.toHaveBeenCalled();
 });
 it("refuses mismatched source attestation before constructing slot pools",()=>{
  const config=sharedConfiguration(),pool=vi.fn();expect(()=>createSharedPoolRuntime(sharedEnvironment(config),{...config.artifact,artifactSha256:"f".repeat(64),sourceClean:false},{createPool:pool})).toThrow("configuration");expect(pool).not.toHaveBeenCalled();
 });
 it("forwards concrete Logo observation recovery instead of silently stripping it from the controller-visible engine",async()=>{
  const config=sharedConfiguration(),secrets=sharedSecrets(config),slot=config.slots.find(s=>s.lane==="logo")!,lease=sharedLease(config,"logo");
  const engine=await createSharedPoolLaneEngine({configuration:config,slot,secret:secrets.slots[slot.slotId]!,provider:secrets.providers.logo,lease:()=>lease,
   database:readyDatabase(),signal:new AbortController().signal});
  const pending:SharedPendingExecution[]=[];expect(engine.recover).toBeTypeOf("function");expect(await engine.recover!(pending)).toEqual({disposition:"retry",state:"observation_retained"});
  expect(doubles.engine.recover).toHaveBeenCalledExactlyOnceWith(pending,undefined);expect(doubles.engine.run).not.toHaveBeenCalled();
  await engine.close();expect(doubles.engine.close).toHaveBeenCalledOnce();expect(doubles.session.close).toHaveBeenCalledOnce();
 });
 it("surfaces an unconfirmed engine drain while still closing the fixed-slot Storage session",async()=>{
  const config=sharedConfiguration(),secrets=sharedSecrets(config),slot=config.slots.find(s=>s.lane==="logo")!;
  const engine=await createSharedPoolLaneEngine({configuration:config,slot,secret:secrets.slots[slot.slotId]!,provider:secrets.providers.logo,lease:()=>sharedLease(config,"logo"),
   database:readyDatabase(),signal:new AbortController().signal});
  doubles.engine.close.mockRejectedValueOnce(Error("inert drain unconfirmed"));await expect(engine.close()).rejects.toThrow("unconfirmed");expect(doubles.session.close).toHaveBeenCalledOnce();
 });
 it("cannot advertise native operations before the packaged probe completes, and never substitutes development probes",async()=>{
  const config=sharedConfiguration();config.target.kind="vercel";const slot=config.slots.find(s=>s.lane==="logo")!;
  slot.policies={...slot.policies,"identity.logo_vectorize":nativeCapability};
  const database=readyDatabase(),secrets=sharedSecrets(config);let release!:()=>void;
  doubles.native.preflight.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  const pending=createSharedPoolLaneEngine({configuration:config,slot,secret:secrets.slots[slot.slotId]!,provider:secrets.providers.logo,
   lease:()=>sharedLease(config,"logo"),database,signal:new AbortController().signal});
  await vi.waitFor(()=>expect(doubles.native.preflight).toHaveBeenCalledOnce());
  expect(database.query).not.toHaveBeenCalled();expect(doubles.logo).not.toHaveBeenCalled();expect(doubles.developmentNative).not.toHaveBeenCalled();
  release();const engine=await pending;
  const values=database.query.mock.calls[0]?.[1];
  if(!Array.isArray(values))throw Error("expected_bound_gateway_parameters");
  expect(values?.[2]).toBe("runtime_ready");expect(JSON.parse(String(values?.[3]))).toEqual([Object.values(slot.policies)]);
  await engine.renewReadiness!();expect(database.query).toHaveBeenCalledTimes(2);
  await engine.close();expect(doubles.native.close).toHaveBeenCalledOnce();expect(doubles.session.close).toHaveBeenCalledOnce();
 });
 it("closes the Storage session and failed native probe without ever reporting ready",async()=>{
  const config=sharedConfiguration(),slot=config.slots.find(s=>s.lane==="logo")!;slot.policies={"identity.logo_vectorize":nativeCapability};
  const secrets=sharedSecrets(config),database=readyDatabase();doubles.native.preflight.mockRejectedValueOnce(Error("native installation missing"));
  await expect(createSharedPoolLaneEngine({configuration:config,slot,secret:secrets.slots[slot.slotId]!,provider:secrets.providers.logo,
   lease:()=>sharedLease(config,"logo"),database,signal:new AbortController().signal})).rejects.toThrow("native installation missing");
  expect(database.query).not.toHaveBeenCalled();expect(doubles.logo).not.toHaveBeenCalled();expect(doubles.packagedNative).not.toHaveBeenCalled();
  expect(doubles.native.close).toHaveBeenCalledOnce();expect(doubles.session.close).toHaveBeenCalledOnce();
 });
 it("does not return an operational engine when SQL rejects its complete runtime readiness proof",async()=>{
  const config=sharedConfiguration(),slot=config.slots.find(s=>s.lane==="logo")!,secrets=sharedSecrets(config),database=readyDatabase();
  database.query.mockResolvedValueOnce({rows:[{envelope:{execution:null,result:false}}]});
  await expect(createSharedPoolLaneEngine({configuration:config,slot,secret:secrets.slots[slot.slotId]!,provider:secrets.providers.logo,
   lease:()=>sharedLease(config,"logo"),database,signal:new AbortController().signal})).rejects.toThrow("readiness_unconfirmed");
  expect(doubles.engine.close).toHaveBeenCalledOnce();expect(doubles.session.close).toHaveBeenCalledOnce();expect(doubles.engine.run).not.toHaveBeenCalled();
 });
});
