import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import {prepareRealSharedExportSource} from "./shared-lanes-logo-export-source";
import { decodeJwt } from "jose";
import { createSharedAdvancedLogoFixture,type SharedAdvancedLogoFixture } from "../database/shared-advanced-logo-fixture";
import { SHARED_STORAGE_ACTOR,SHARED_STORAGE_SESSION,SHARED_STORAGE_ORIGIN } from "../database/shared-storage-fixture";
import {sharedExecutionSchema,sharedPendingExecutionSchema,type SharedExecution,type SharedSlotLease} from "../../worker/shared-pool/contracts";
import type {IdentityAssetReservation} from "../../src/server/data/identity-asset-store";
import {createSharedLogoLaneEngine} from "../../worker/shared-lanes/logo";
import {createSharedAdvancedLogoStorageAuthorization} from "../../worker/shared-lanes/logo-storage";
import {buildLogoVectorProposalContext} from "../../src/features/logo-vector/server/proposal-context";
import {workerRole as sourceWebRole} from "../database/logo-production-storage-fixture";
import type {LogoBriefRevision} from "../../src/domain/logo-workspace";
import {logoCostQuoteSchema} from "../../src/domain/logo-jobs";
import {subscriptionFixture} from "../features/identity-directions/subscription-fixtures";
import type {OpenAIResponsesTransport} from "../../src/server/ai/openai-transport";
import {qualifySharedLogoCapability} from "../../worker/shared-lanes/logo-capability";
import {qualifiedLogoProductionStorageCapability} from "../../worker/logo-production-storage-authorization";
import {createLogoProductionRuntimeQualification} from "../../worker/logo-production-qualification";
function token(claims:Record<string,unknown>){return[Buffer.from('{"alg":"HS256"}').toString("base64url"),Buffer.from(JSON.stringify(claims)).toString("base64url"),"inert"].join(".");}
/** Actual restricted SQL admission/claim/steps, real native qualification and
 * real vector/export handlers. HTTP Auth is synthetic; Storage object access
 * executes actual disposable RLS and byte transport is an in-memory fixture. */
describe("advanced shared Logo native execution against actual disposable SQL",()=>{
 let f:SharedAdvancedLogoFixture;
 beforeAll(async()=>{f=await createSharedAdvancedLogoFixture();},60_000);
 afterAll(async()=>{await f?.close();});
 it.each(["vector","export","directions","proposal","export_lost_stage_ack"] as const)("runs %s through the shared engine, native runtime and exact Storage grants",async scenario=>{
  const operation=scenario==="export_lost_stage_ack"?"export":scenario;
  await f.db.exec("begin");let runtime:ReturnType<typeof createSharedLogoLaneEngine>|undefined;
  let qualification:ReturnType<typeof createLogoProductionRuntimeQualification>|undefined;
  try{
   await f.resetLease();expect(await f.runtimeReady()).toBe(true);
   const source=operation==="vector"?await f.prepareVector():await prepareRealSharedExportSource(f);
   let prepared:{jobId:string;job:typeof source.job;capability:unknown;sourceBytes:typeof source.sourceBytes}=source;
   let candidate:unknown;
   if(operation==="directions"||operation==="proposal"){
    if(!("snapshot" in source))throw Error("Real source snapshot missing");
    await f.owner(source.job.owner_id,()=>f.db.query("select public.request_job_cancel($1)",[source.jobId]));
    const scope={expected:source.request.expected};
    const request=operation==="directions"?{...scope,operation:"directions",approvedLogoId:source.snapshot.logoApproval.id}
     :{...scope,operation:"propose_vector_edit",baseVectorRevisionId:source.snapshot.logo.id,instruction:"Rotate the selected component ten degrees",targetComponentIds:["synthetic-art"]};
    let quote;
    if(operation==="proposal"){
     const briefId=source.snapshot.logo.inputRevisions.find(revision=>revision.stage==="brief_references")!.id;
     const brief=(await f.db.query<{record:LogoBriefRevision}>("select record from public.logo_stage_revisions where id=$1",[briefId])).rows[0]!.record;
     const context=buildLogoVectorProposalContext({revision:source.snapshot.logo,document:source.snapshot.logoDocument,brief,fonts:source.snapshot.fonts,targetComponentIds:["synthetic-art"]});
     const evidence={version:1,request,context,baseRevision:source.snapshot.logo,brief,fonts:source.snapshot.fonts};
     await f.db.exec("grant execute on function fluid_private.shared_logo_quote_vector_proposal(uuid,jsonb) to "+sourceWebRole);
     quote=await f.legacy.writer(async()=>logoCostQuoteSchema.parse((await f.db.query<{value:unknown}>("select fluid_private.shared_logo_quote_vector_proposal($1,$2) value",[source.job.project_id,evidence])).rows[0]!.value));
    }else quote=await f.owner(source.job.owner_id,async()=>logoCostQuoteSchema.parse((await f.db.query<{value:unknown}>("select public.shared_logo_operation($1,'quote',$2) value",[source.job.project_id,request])).rows[0]!.value));
    const admitted=await f.admitAdvanced(source.job.project_id,quote);prepared={...admitted,sourceBytes:source.sourceBytes,capability:operation==="directions"?f.directionsCapability:f.proposalCapability};
    if(operation==="directions"){
     const original=subscriptionFixture().candidate;
     candidate={directions:original.directions.map(direction=>({...direction,typography:{styles:direction.typography.styles.map(style=>({...style,fontVersionId:source.snapshot.fonts[0]!.id,sampleText:"Synthetic shared Storage"}))}}))};
    }else candidate={version:1,status:"proposed",edit:{kind:"rotation",componentId:"synthetic-art",degrees:10},explanation:"One original synthetic intent."};
   }
   const capability=qualifySharedLogoCapability(prepared.capability)!;
   const blobs=new Map(prepared.sourceBytes),reservations=new Map<string,IdentityAssetReservation>(),methods:string[]=[],faults:unknown[]=[],actions:string[]=[];
   const workerId="synthetic-shared-logo-native";let lostStageAck=false,claimedExecution:SharedExecution|null=null;
      const native=qualifiedLogoProductionStorageCapability(capability);
   if(native)qualification=createLogoProductionRuntimeQualification({ownerId:prepared.job.owner_id,workerId,capabilities:[native]});
   const createResponse=vi.fn<OpenAIResponsesTransport["createResponse"]>(async()=>({requestId:"req_inert_advanced",body:{id:"resp_inert_advanced",status:"completed",model:"gpt-6.1-sol",service_tier:"default",
    usage:{input_tokens:100,output_tokens:100,total_tokens:200,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}},output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(candidate)}]}]}}));
   runtime=createSharedLogoLaneEngine({slot:f.slot,deploymentId:"dpl_shared_storage_fixture",workerId,capabilities:[capability],nativeQualification:qualification,
    provider:{apiKey:"inert-unused-image-key",model:"unused-image",modelVerificationReceipt:"unused-image-proof"},
    ...((operation==="directions"||operation==="proposal")?{textProvider:{apiKey:"inert-text-key",model:"gpt-6.1-sol",modelVerificationReceipt:"inert-proof"}}:{}),
    database:{async query(sql,values=[]){
     expect(sql).toBe("select public.shared_logo_worker_action($1::jsonb,$2::jsonb,$3,$4::jsonb) as envelope");
     const lease=JSON.parse(String(values[0])) as SharedSlotLease,execution=values[1]===null?null:JSON.parse(String(values[1])) as SharedExecution;
     actions.push(String(values[2]));try{const envelope=await f.action(execution,String(values[2]),JSON.parse(String(values[3])),lease);
      if(envelope.execution)claimedExecution=sharedExecutionSchema.parse(envelope.execution);
      if(scenario==="export_lost_stage_ack"&&values[2]==="stage_exports"&&!lostStageAck){lostStageAck=true;throw Error("Synthetic stage_exports acknowledgement lost after actual SQL persistence");}
      return{rows:[{envelope}]};}
     catch(error){faults.push({action:values[2],code:(error as {code?:string}).code,message:(error as Error).message});throw error;}
    }},
    storage:async(execution,currentCapability)=>createSharedAdvancedLogoStorageAuthorization({targetOrigin:SHARED_STORAGE_ORIGIN,publishableKey:"sb_publishable_inert_fixture",
     slot:f.slot,execution,capability:currentCapability,session:{authUserId:SHARED_STORAGE_ACTOR,sessionId:SHARED_STORAGE_SESSION,tokenProvider:async()=>token(f.claims())}},
     {fetch:async(raw,init)=>{
      const url=new URL(String(raw));methods.push((init?.method??"GET")+" "+url.pathname);
      if(url.pathname==="/auth/v1/user")return Response.json({id:SHARED_STORAGE_ACTOR,is_anonymous:false,email_confirmed_at:"2026-10-01T00:00:00Z"});
      if(url.pathname==="/rest/v1/rpc/authorize_shared_logo_storage"){
       const body=JSON.parse(String(init?.body)),claims=decodeJwt(new Headers(init?.headers).get("authorization")!.slice(7));
       let value:{reservation:IdentityAssetReservation|null};try{value=await f.auth(async()=>(await f.db.query<{value:{reservation:IdentityAssetReservation|null}}>("select public.authorize_shared_logo_storage($1,$2,$3,$4,$5,$6) value",
        [body.p_execution,body.p_execution_token,body.p_job,body.p_lease,body.p_reservation,body.p_mode])).rows[0]!.value,claims);}catch(error){faults.push({storage:body.p_mode,code:(error as {code?:string}).code,message:(error as Error).message});throw error;}
       if(value.reservation)reservations.set(value.reservation.storagePath,value.reservation);return Response.json(value);
      }
      const path=url.pathname.slice("/storage/v1/object/fluid-assets/".length),reservation=reservations.get(path);if(!reservation)throw Error("No exact SQLgrant");
      if(init?.method==="POST"){await f.put(reservation);blobs.set(path,{bytes:new Uint8Array(await new Response(init.body).arrayBuffer()),mimeType:reservation.mimeType});return Response.json({Id:reservation.id,Key:"fluid-assets/"+path});}
      expect(await f.get(reservation)).toHaveLength(1);const blob=blobs.get(path);if(!blob)throw Error("Missing actual fixture bytes");
      return new Response(Buffer.from(blob.bytes),{headers:{"content-type":blob.mimeType}});
     }})},{textTransport:{countInputTokens:async()=>100,createResponse}});
   let result=await runtime.run();
   if(scenario==="export_lost_stage_ack"){
    expect(lostStageAck).toBe(true);expect(claimedExecution).not.toBeNull();
    expect((await f.db.query("select state from public.jobs where id=$1",[prepared.jobId])).rows).toEqual([{state:"needs_reconciliation"}]);
    const writesBefore=methods.filter(method=>method.startsWith("POST /storage/")).length;
    expect(writesBefore).toBeGreaterThan(0);
    for(let page=0;page<25&&result.state!=="succeeded";page++){
     const pending=sharedPendingExecutionSchema.parse({execution:claimedExecution,job:(await f.db.query("select * from public.jobs where id=$1",[prepared.jobId])).rows[0],mode:"observe"});
     const readsBefore=methods.filter(method=>method.startsWith("GET /storage/")).length;
     result=await runtime.recover!([pending]);
     expect(methods.filter(method=>method.startsWith("GET /storage/")).length-readsBefore).toBeLessThanOrEqual(3);
    }
    expect(methods.filter(method=>method.startsWith("POST /storage/")).length).toBe(writesBefore);
    expect((await f.db.query("select count(*)::int n from fluid_private.shared_logo_export_resolutions where job_id=$1",[prepared.jobId])).rows).toEqual([{n:1}]);
    expect(createResponse).not.toHaveBeenCalled();
   }
   const steps=(await f.db.query("select step_key,state,output from public.job_steps where job_id=$1",[prepared.jobId])).rows;
   expect(result,JSON.stringify({steps,methods,actions,faults})).toEqual({disposition:"ack",state:"succeeded"});
   expect((await f.db.query("select state,actual_cost_microusd from public.jobs where id=$1",[prepared.jobId])).rows).toEqual([{state:"succeeded",actual_cost_microusd:operation==="directions"||operation==="proposal"?1200:0}]);
   if(operation==="proposal"){expect(methods).toEqual([]);expect(createResponse).toHaveBeenCalledTimes(1);}
   else {expect(methods.some(method=>method.startsWith("POST /storage/"))).toBe(operation!=="directions");expect(methods.some(method=>method.startsWith("GET /storage/"))).toBe(true);}
   if(operation==="directions")expect(createResponse).toHaveBeenCalledTimes(1);
   expect((await f.db.query("select * from fluid_private.shared_worker_gateway_context")).rows).toEqual([]);
  }finally{await runtime?.close();await qualification?.close();await f.db.exec("rollback;set session authorization postgres");await f.resetLease();}
 },120_000);
});
