import {createHash} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createSharedAdvancedLogoFixture,type SharedAdvancedLogoFixture} from "../database/shared-advanced-logo-fixture";
import {conceptCapability} from "../database/logo-generative-storage-fixture";
import {SHARED_STORAGE_ACTOR,SHARED_STORAGE_SESSION,SHARED_STORAGE_ORIGIN} from "../database/shared-storage-fixture";
import {sharedExecutionSchema,sharedPendingExecutionSchema,type SharedSlotLease} from "../../worker/shared-pool/contracts";
import {createSharedLogoLaneEngine} from "../../worker/shared-lanes/logo";
import {createSharedLogoStorageAuthorization} from "../../worker/shared-storage/authorization";
import {qualifiedLogoGenerativeStorageCapability} from "../../worker/logo-generative-storage-authorization";
const token=(claims:unknown)=>[Buffer.from('{"alg":"HS256"}').toString("base64url"),Buffer.from(JSON.stringify(claims)).toString("base64url"),"inert"].join(".");
describe("historical shared Logo recovery (actual disposable SQL, synthetic Auth/HTTP)",()=>{
 let f:SharedAdvancedLogoFixture;beforeAll(async()=>{f=await createSharedAdvancedLogoFixture();},60000);afterAll(async()=>{await f?.close();});
 it("reads only prior issued bytes with the original frozen policy after deployment and roster changes",async()=>{
  await f.db.exec("begin");let runtime:ReturnType<typeof createSharedLogoLaneEngine>|undefined;
  try{
   expect(await f.runtimeReady()).toBe(true);const p=await f.prepare();await f.grant(p.execution,p.reservation,"write");await f.put(p.reservation);
   const frozen=p.job.input as {slotId:string;attemptId:string},step="logo-preview-v1:"+frozen.slotId+":"+frozen.attemptId;
   await f.action(p.execution,"begin",[p.job.id,p.job.leaseToken,step,createHash("sha256").update(p.job.id+":"+step).digest("hex"),p.job.reservedCostMicrousd]);
   await f.db.query("update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null where id=$1",[p.job.id]);
   const newDeployment="dpl_shared_after_redeploy",newCapability={...conceptCapability,policyIdentity:"e".repeat(64)};
   await f.db.query("update fluid_private.shared_worker_slots set deployment_id=$1 where slot_id=$2",[newDeployment,f.slotId]);
   await f.db.query("update fluid_private.shared_worker_policies set policy_identity=$1,policy=$2 where slot_id=$3 and operation='identity.logo_concept'",[newCapability.policyIdentity,newCapability,f.slotId]);
   const pending=sharedPendingExecutionSchema.parse({execution:p.execution,job:(await f.db.query("select * from public.jobs where id=$1",[p.job.id])).rows[0],mode:"observe"});
   const creates=vi.fn(),methods:string[]=[];
   runtime=createSharedLogoLaneEngine({slot:f.slot,deploymentId:newDeployment,workerId:"synthetic-shared-recovery",capabilities:[newCapability],
    provider:{apiKey:"inert-not-used",model:conceptCapability.model!,modelVerificationReceipt:"inert-model-receipt"},
    database:{async query(_sql,values=[]){const lease=JSON.parse(String(values[0])) as SharedSlotLease,execution=sharedExecutionSchema.parse(JSON.parse(String(values[1])));
     return{rows:[{envelope:await f.action(execution,String(values[2]),JSON.parse(String(values[3])),lease)}]};}},
    storage:async(execution,raw)=>{const capability=qualifiedLogoGenerativeStorageCapability(raw);expect(capability).toEqual(conceptCapability);if(!capability)throw Error("Unsupported historical schema");
     return createSharedLogoStorageAuthorization({targetOrigin:SHARED_STORAGE_ORIGIN,publishableKey:"sb_publishable_inert_fixture",slot:f.slot,execution,capability,
      session:{authUserId:SHARED_STORAGE_ACTOR,sessionId:SHARED_STORAGE_SESSION,tokenProvider:async()=>token(f.claims())}},{fetch:async(url,init)=>{
       const path=new URL(String(url)).pathname;methods.push((init?.method??"GET")+" "+path);
       if(path==="/auth/v1/user")return Response.json({id:SHARED_STORAGE_ACTOR,is_anonymous:false,email_confirmed_at:"2026-10-01T00:00:00Z"});
       if(path==="/rest/v1/rpc/authorize_shared_logo_storage"){const body=JSON.parse(String(init?.body));return Response.json(await f.grant(execution,body.p_reservation?p.reservation:null,body.p_mode));}
       expect(await f.get(p.reservation)).toHaveLength(1);return new Response(Buffer.from(p.bytes),{headers:{"content-type":p.reservation.mimeType}});
      }});}
   },{transport:{createImage:creates}});
   expect(await runtime.recover!([pending])).toEqual({disposition:"retry",state:"observation_retained"});
   expect(creates).not.toHaveBeenCalled();expect(methods.some(method=>method.startsWith("GET /storage/"))).toBe(true);
   expect(methods.every(method=>!method.startsWith("POST /storage/"))).toBe(true);
   expect((await f.db.query("select state from public.jobs where id=$1",[p.job.id])).rows).toEqual([{state:"needs_reconciliation"}]);
  }finally{await runtime?.close();await f.db.exec("rollback;set session authorization postgres");await f.resetLease();}
 },60000);
});
