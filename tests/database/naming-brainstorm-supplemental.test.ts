import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSharedWorkerFixture, type SharedWorkerFixture } from "./shared-worker-fixture";
import { brainPolicy, brainPreferences, brainReadinessFingerprint, brainRpc, initialIntent } from "./naming-brain-fixture";
import { asRole, OWNER_A, OWNER_B } from "./local-supabase";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { namingFeedSchema } from "../../src/domain/naming-brain";
import { normalizeNamingBrain, verifyBrainstormNamingSource } from "../../src/server/data/naming-brain-provenance";
vi.mock("server-only", () => ({}));

const policy = { ...brainPolicy, model: "gpt-6-luna" };
const approaches = ["real_words", "invented"];
const caution = "Unchecked brainstorm. Research and screening are needed before use.";
const proposal = (value: string, primaryApproach: string) => ({value, primaryApproach, rationale: "Synthetic design association.", construction: primaryApproach === "invented" ? [] : [value]});
type Member = { callId: string; rawIndex: number; value: string; primaryApproach:string; rationale: string; identityKey: string; graphemeCount: number };

describe("local supplemental publication, using retained responses only", () => {
 let fixture: SharedWorkerFixture, projectId: string, runId: string, jobId: string;
 const members: Member[] = [];
 const execute = (values: Member[]) => fixture.db.query<{result:unknown}>("select fluid_private.repair_partial_brainstorm_v1($1,$2,$3) result",[projectId,runId,JSON.stringify(values)]);
 const sources = (ids: string[], owner = OWNER_A) => asRole(fixture.db,"authenticated",owner, async() =>
   (await fixture.db.query<{result:{candidateId:string;value:string;callId:string}[]}>("select public.get_naming_brainstorm_sources_v2($1,$2) result",[projectId,ids])).rows[0]!.result);
 const evidence = async() => (await fixture.db.query(`select to_jsonb(j) job,to_jsonb(c) completion,
   (select jsonb_agg(to_jsonb(e) order by event_id) from fluid_private.naming_brainstorm_events e join fluid_private.naming_brainstorm_calls k using(call_id) where k.run_id=c.run_id) events,
   (select jsonb_agg(to_jsonb(p) order by call_id) from fluid_private.naming_brainstorm_publications p where p.run_id=c.run_id) publications,
   r.settlement_evidence,r.actual_cost_microusd from public.jobs j join fluid_private.naming_brain_runs r on r.job_id=j.id
   join fluid_private.naming_brainstorm_completions c on c.run_id=r.id where j.id=$1`,[jobId])).rows;

 beforeAll(async()=>{
  fixture=await createSharedWorkerFixture({probe:false});
  const {db}=fixture;
  for(const owner of [OWNER_A,OWNER_B]) await fixture.seedUser(owner);
  for(const file of ["shared_worker_naming.sql","shared_naming_brainstorm.sql"]) await db.exec(await readFile(new URL("../../supabase/candidates/"+file,import.meta.url),"utf8"));
  const identity=(await db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[JSON.stringify(policy)])).rows[0]!.h;
  const slot=await fixture.seedSlot({lane:"naming",policies:[{operation:"naming.generate",policyIdentity:identity,policy}]});
  await db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName};
    create table fluid_private.portable_development_installation(singleton boolean primary key, project_id text, origin text);`);
  await db.query("insert into fluid_private.portable_development_installation values(true,$1,'http://127.0.0.1:54321')",[slot.deploymentId]);
  await db.exec(await readFile(new URL("../../supabase/development/brainstorm-supplemental-membership-v1.sql",import.meta.url),"utf8"));
  await db.query("insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)",[slot.slotId,JSON.stringify(brainReadinessFingerprint)]);
  const lease=await fixture.lease(slot);
  let execution: Record<string,unknown>|null=null;
  const action=async(name:string,args:unknown)=>fixture.asSlot(slot,async()=>
    (await db.query<{v:{result:unknown;execution:Record<string,unknown>}}>("select public.shared_naming_worker_action($1,$2,$3,$4) v",[lease,execution,name,JSON.stringify(args)])).rows[0]!.v);
  await action("qualify",[policy,brainReadinessFingerprint]);
  projectId=(await brainRpc<{id:string}>(db,"create_project",["naming_only","Local recovery test",{description:"A synthetic naming brief"},"a".repeat(64)])).id;
  await brainRpc(db,"save_naming_preferences",[projectId,0,{...brainPreferences,approaches}]);
  const demand=initialIntent("supplemental-fixture-request");
  await brainRpc(db,"ensure_shared_naming_brainstorm_run",[projectId,demand]);
  const [work]=(await action("preference_work",[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  await action("attest_preferences",[projectId,work!.preferencesVersion,work!.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}]);
  await brainRpc(db,"ensure_shared_naming_brainstorm_run",[projectId,demand]);
  const claimed=await action("claim",["supplemental-fixture-worker",slot.deploymentId,120]);
  execution=claimed.execution;runId=(claimed.result as {job:{input:{runId:string}}}).job.input.runId;jobId=String(execution.jobId);
  for(let index=1;index<=3;index++){
   const target=index===1?120:22;
   const request={model:policy.model,store:true,stream:true,reasoning:{effort:"low"},max_output_tokens:16000,input:"Synthetic fixture",text:{verbosity:"low",format:{type:"json_schema",name:"naming_brainstorm_balanced_v2",strict:true,schema:{properties:{candidates:{items:{properties:{primaryApproach:{enum:approaches}}}}}}}},metadata:{embel_generation_profile:"brainstorm_v1",embel_job_id:jobId,embel_run_id:runId,embel_call_index:String(index)}};
   const history=(await db.query<{id:string;value:string;identity_key:string}>("select id,value,identity_key from public.name_candidates where project_id=$1",[projectId])).rows;
   const epoch=Number((await db.query<{writer_epoch:number}>("select writer_epoch from fluid_private.naming_brain_heads where project_id=$1",[projectId])).rows[0]!.writer_epoch);
   const call=(await action("brainstorm_begin",{callIndex:index,candidateTarget:target,request,expectedHistoryEpoch:epoch,historyIdentities:history.map(row=>({candidateId:row.id,value:row.value,identityKey:row.identity_key}))})).result as {callId:string};
   const original=index===1?Array.from({length:98},(_,n)=>proposal("Cedar"+n,n<50?"real_words":"invented")):[];
   const raw=[...original,...(index===1?[proposal("Aureli","invented"),proposal("Umber","real_words")]:index===2?[proposal("Kiro","invented")]:[])];
   if(index<=2)for(let i=original.length;i<raw.length;i++){
    const {value,primaryApproach,rationale}=raw[i]!;members.push({callId:call.callId,rawIndex:i,value,primaryApproach,rationale,identityKey:value.toLowerCase(),graphemeCount:value.length});
   }
   const responseId="resp_supplement_"+index;
   const response={id:responseId,status:"completed",model:policy.model,output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({candidates:raw})}]}]};
   await action("brainstorm_event",{callId:call.callId,kind:"completed",observedAt:"2026-10-29T12:00:00Z",responseId,requestId:null,model:policy.model,response,usage:null,
    candidates:original.map(({value,rationale,primaryApproach})=>({value,rationale,primaryApproach,identityKey:value.toLowerCase(),graphemeCount:value.length,caution}))});
   await action("brainstorm_publish",{callId:call.callId});
  }
  expect((await action("brainstorm_finish",{})).result).toEqual({state:"partial",publishedCount:98});
 },60000);
 afterAll(async()=>{await fixture?.close();});

 it("denies ordinary roles, stale heads, forged source/identity, duplicate input and excess route capacity",async()=>{
  const input=[members[0]!,members[2]!];
  expect((await fixture.db.query("select has_function_privilege('anon','public.get_naming_brainstorm_sources_v2(uuid,uuid[])','execute') anon_read, has_function_privilege('authenticated','public.get_naming_brainstorm_sources_v2(uuid,uuid[])','execute') owner_read, has_table_privilege('authenticated','fluid_private.naming_brainstorm_supplemental_members','insert') member_write")).rows)
    .toEqual([{anon_read:false,owner_read:true,member_write:false}]);
  for(const role of ["authenticated","service_role"] as const)await expect(asRole(fixture.db,role,OWNER_A,()=>execute(input))).rejects.toThrow(/permission denied/);
  await fixture.db.query("update fluid_private.naming_brain_heads set paused=true where project_id=$1",[projectId]);
  await expect(execute(input)).rejects.toThrow(/not_current/);
  await fixture.db.query("update fluid_private.naming_brain_heads set paused=false where project_id=$1",[projectId]);
  await fixture.db.query("update fluid_private.naming_brain_heads set coverage_epoch=null where project_id=$1",[projectId]);
  await expect(execute(input)).rejects.toThrow(/not_current/);
  await fixture.db.query("update fluid_private.naming_brain_heads set coverage_epoch=writer_epoch where project_id=$1",[projectId]);
  await expect(execute([input[0]!,{...input[1]!,callId:input[0]!.callId}])).rejects.toThrow(/invalid_supplemental_source/);
  for(const key of ["value","identityKey","rationale","primaryApproach","graphemeCount"] as const){
   await expect(execute([input[0]!,{...input[1]!,[key]:key==="graphemeCount"?77:"Forgery"}])).rejects.toThrow(/invalid_supplemental_source/);
  }
  await expect(execute([input[0]!,input[0]!])).rejects.toThrow(/membership_changed/);
  await expect(execute([members[0]!,members[1]!])).rejects.toThrow(/coverage_mismatch/);
  expect((await fixture.db.query("select count(*)::int n from fluid_private.naming_brainstorm_supplemental_members")).rows).toEqual([{n:0}]);
 });

 it("appends real membership once, reloads original and recovered source proofs and preserves the original bill/job/completion/events",async()=>{
  const original=await evidence(),input=[members[0]!,members[2]!];
  expect((await execute(input)).rows[0]!.result).toMatchObject({insertedCount:2,acceptedCount:100,originalState:"partial",originalPublishedCount:98});
  expect((await execute([...input].reverse())).rows[0]!.result).toMatchObject({insertedCount:0});
  expect(await evidence()).toEqual(original);
  const feed=namingFeedSchema.parse(normalizeNamingBrain(await brainRpc(fixture.db,"get_naming_feed",[projectId,{limit:100}]),OWNER_A));
  expect(feed.entries).toHaveLength(100);
  expect(feed.activeRun).toMatchObject({state:"partial",fulfillment:{acceptedCount:100,status:"complete",coverageSatisfied:true}});
  const ids=feed.entries.map(row=>row.entry.candidate.id);
  const proof=await sources(ids);expect(proof).toHaveLength(100);
  expect(proof.find(row=>row.value==="Aureli")?.callId).toBe(input[0]!.callId);
  expect(proof.find(row=>row.value==="Kiro")?.callId).toBe(input[1]!.callId);
  const recovered=feed.entries.find(row=>row.entry.candidate.value==="Kiro")!.entry.candidate;
  await verifyBrainstormNamingSource({userId:OWNER_A} as AuthenticatedContext,recovered,normalizeNamingBrain(proof.find(row=>row.candidateId===recovered.id),OWNER_A));
  const picked=await brainRpc<{project:{context:{selectedName:string}}}>(fixture.db,"select_project_name",[projectId,recovered.id,feed.projectRevision,false],OWNER_A);
  expect(picked.project.context.selectedName).toBe("Kiro");
  await expect(sources(ids,OWNER_B)).rejects.toThrow(/not_found/);
  await expect(sources([crypto.randomUUID()])).rejects.toThrow(/invalid_brainstorm_source/);
  await expect(fixture.db.exec("delete from fluid_private.naming_brainstorm_supplemental_members")).rejects.toThrow();
 });
});
