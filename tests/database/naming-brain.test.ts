import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

describe("Naming Brain SQL ownership and provisional liability (synthetic local database)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await resetFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("installs only disabled runtime policy and scoped account reads", async () => {
    const installed = (await db.query<{ installed: boolean }>("select to_regprocedure('public.get_naming_feed(uuid,jsonb)') is not null as installed")).rows[0]!;
    expect(installed.installed).toBe(true);
    const rows = (await db.query<{ count: number }>("select count(*)::integer count from fluid_private.naming_brain_pilots where enabled")).rows;
    expect(rows[0]!.count).toBe(0);
  });

  it("reads an owned empty feed without creating a run and denies a foreign project", async () => {
    const project = await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ id: string }>("select id from public.create_project('naming_only','Local fixture','{\"description\":\"Synthetic coffee brief\"}',repeat('a',64))")).rows[0]!.id);
    const feed = await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ feed: { entries: unknown[]; activeRun: unknown; availability: { status: string } } }>("select public.get_naming_feed($1,'{}') feed", [project])).rows[0]!.feed);
    expect(feed).toMatchObject({ entries: [], activeRun: null, availability: { status: "unavailable" } });
    await expect(asRole(db, "authenticated", OWNER_B, () => db.query("select public.get_naming_feed($1,'{}')", [project]))).rejects.toMatchObject({ code: "P0002" });
  });
});

import { beforeEach } from "vitest";
import { attestBrainPreferences, brainReadinessFingerprint, brainPolicy, brainGapEnvelope, brainManifest, brainPreferences, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, seedBrainFixture } from "./naming-brain-fixture";

describe("Naming Brain scoped admission and worker boundaries", () => {
 let db: TestDatabase; let project: string;
 beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
 afterAll(async () => { await db?.close(); });
 beforeEach(async () => { project = await seedBrainFixture(db); });
 const ensure = (key?: string) => brainRpc<{ status: string; run: { runId: string; jobId: string; revision: number; accounting: unknown }; reused: boolean }>(db, "ensure_naming_brain_run", [project, initialIntent(key)]);
 it("coalesces browser keys without doubling allowance and rejects changed key reuse", async () => {
  const first = await ensure(); const replay = await ensure("fixture-other-browser-key");
  expect(first.status).toBe("pending"); expect(replay.run.runId).toBe(first.run.runId);
  expect(first.run.accounting).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5000000, confirmedActualCostMicrousd: null });
  expect((await db.query<{ amount: number }>("select reserved_microusd::integer amount from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]!.amount).toBe(5000000);
  await expect(brainRpc(db,"ensure_naming_brain_run",[project,{...initialIntent(),expectedPreferencesVersion:2}])).rejects.toMatchObject({code:"PT409"});
 });
 it("keeps default private data unreadable even to bound workers and blocks generic claim and expiry", async () => {
  const first = await ensure();
  await expect(brainWorker(db, () => db.query("select * from fluid_private.naming_brain_runs"))).rejects.toMatchObject({code:"42501"});
  const generic = await asRole(db,"service_role",null,()=>db.query("select * from public.claim_job('legacy',60)")); expect(generic.rows).toHaveLength(0);
  const claimed = await claimBrain(db); expect(claimed.job.id).toBe(first.run.jobId);
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[claimed.job.id]);
  await asRole(db,"service_role",null,()=>db.query("select public.expire_job_leases()"));
  expect((await db.query<{state:string}>("select state from public.jobs where id=$1",[claimed.job.id])).rows[0]!.state).toBe("running");
 });
 it("settles a proven never-started cancellation to zero but retains a started run's liability", async () => {
  const first=await ensure(); await brainRpc(db,"request_job_cancel",[first.run.jobId]);
  const cancelled=await brainRpc<{accounting:unknown}>(db,"get_naming_brain_run",[project,first.run.runId]);
  expect(cancelled.accounting).toEqual({status:"settled",heldAllowanceMicrousd:0,confirmedActualCostMicrousd:0});
  const project2=(await brainRpc<{id:string}>(db,"create_project",["naming_only","Other fixture",{description:"Synthetic second brief"},"a".repeat(64)])).id;
  await brainRpc(db,"save_naming_preferences",[project2,0,brainPreferences]);await attestBrainPreferences(db);
  const run=await brainRpc<{run:{runId:string}}>(db,"ensure_naming_brain_run",[project2,initialIntent("fixture-second-project")]);
  const {job}=await claimBrain(db);
  await brainWorker(db,()=>db.query("select public.naming_brain_worker_action($1,$2,'plan',$3::jsonb)",[job.id,job.lease_token,JSON.stringify({manifest:brainManifest,gapEnvelope:brainGapEnvelope})]));
  await brainWorker(db,()=>db.query("select public.naming_brain_worker_action($1,$2,'begin',$3::jsonb)",[job.id,job.lease_token,JSON.stringify({stageKey:"research",requestKey:"fixture-started-research",maximumCostMicrousd:750000})]));
  const {request:dispatch}=await planBrainCall(db,job,"research");
  await brainWorker(db,()=>db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(dispatch)]));
  await brainRpc(db,"request_job_cancel",[job.id]);
  await db.query("select fluid_private.settle_reservation($1)",[job.id]);
  expect((await brainRpc<{accounting:unknown}>(db,"get_naming_brain_run",[project2,run.run.runId])).accounting).toEqual({status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null});
 });
});

describe("Naming Brain allowance, replay, identity and recovery", () => {
 let db: TestDatabase; let project: string;
 beforeAll(async () => { db=await createTestDatabase(); await installBrainFixture(db); },30_000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{project=await seedBrainFixture(db);});
 const action=(job:{id:string;lease_token:string},name:string,payload:unknown={})=>brainWorker(db,async()=>(await db.query<{result:unknown}>("select public.naming_brain_worker_action($1,$2,$3,$4::jsonb) result",[job.id,job.lease_token,name,JSON.stringify(payload)])).rows[0]!.result);
 async function failedRun(target=project,key="fixture-retained-liability") {
  const admitted=await brainRpc<{run:{runId:string;jobId:string}}>(db,"ensure_naming_brain_run",[target,initialIntent(key)]);
  const {job}=await claimBrain(db); await action(job,"plan",{manifest:brainManifest,gapEnvelope:brainGapEnvelope});
  await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"partial",sources:[]});
  await action(job,"finish",{state:"partial",errorCode:"fixture_incomplete_research"});return admitted.run;
 }
 it("keeps five unresolved billing allowances and rejects a sixth without changing its project",async()=>{
  for(let n=0;n<5;n++){
   const p=n===0?project:(await brainRpc<{id:string}>(db,"create_project",["naming_only",`Synthetic ${n}`,{description:`Synthetic allowance brief ${n}`},"a".repeat(64)])).id;
   if(n)await brainRpc(db,"save_naming_preferences",[p,0,brainPreferences]);await attestBrainPreferences(db);await failedRun(p,`fixture-allowance-run-${n}`);
  }
  const p=(await brainRpc<{id:string}>(db,"create_project",["naming_only","Synthetic sixth",{description:"Synthetic sixth"},"a".repeat(64)])).id;await brainRpc(db,"save_naming_preferences",[p,0,brainPreferences]);await attestBrainPreferences(db);
  const blocked=await brainRpc<{status:string;code:string}>(db,"ensure_naming_brain_run",[p,initialIntent("fixture-sixth-refused")]);expect(blocked).toMatchObject({status:"blocked",code:"pilot_allowance_held"});
  expect((await db.query<{count:number}>("select count(*)::integer count from fluid_private.naming_brain_runs")).rows[0]!.count).toBe(5);
  expect((await db.query<{amount:number}>("select reserved_microusd::integer amount from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]!.amount).toBe(25000000);
 });
 it("requires explicit Resume and coalesces concurrent keys by the same terminal revision",async()=>{
  const old=await failedRun(); const terminal=await brainRpc<{revision:number;accounting:unknown}>(db,"get_naming_brain_run",[project,old.runId]);
  const ordinary=await brainRpc<{status:string}>(db,"ensure_naming_brain_run",[project,initialIntent("fixture-ordinary-after-failure")]);expect(ordinary.status).toBe("incomplete");
  const intent={...initialIntent("fixture-explicit-resume"),reason:"resume",resumeOfRunId:old.runId,expectedRunRevision:terminal.revision};
  const resumed=await brainRpc<{run:{runId:string;resumedFromRunId:string;demandSequence:number}}>(db,"ensure_naming_brain_run",[project,intent]);
  const replay=await brainRpc<{run:{runId:string}}>(db,"ensure_naming_brain_run",[project,{...intent,idempotencyKey:"fixture-resume-other-tab"}]);
  expect(resumed.run.runId).not.toBe(old.runId);expect(resumed.run).toMatchObject({resumedFromRunId:old.runId,demandSequence:1});expect(replay.run.runId).toBe(resumed.run.runId);
  expect((await brainRpc<{revision:number}>(db,"get_naming_brain_run",[project,old.runId])).revision).toBe(terminal.revision);
  await expect(brainRpc(db,"ensure_naming_brain_run",[project,initialIntent("fixture-stale-old-scroll")])).rejects.toMatchObject({code:"PT409"});
 });
 it("indexes historical values rather than client keys and rejects incomplete/raced coverage",async()=>{
  const imported=await brainRpc<{entry:{candidate:{id:string}}}>(db,"import_local_name",[project,1,{id:"33333333-3333-4333-8333-333333333333",value:"Café",createdAt:"2026-10-16T12:00:00Z",origin:"manual",history:[]},{description:"Synthetic imported context"},"false-but-canonical","fixture-spoofed-name-key"]);
  await brainRpc(db,"ensure_naming_brain_run",[project,initialIntent()]);const {job}=await claimBrain(db);
  const page=await action(job,"index_page",{limit:100}) as {epoch:number;entries:unknown[]};expect(page.entries).toEqual([{candidateId:imported.entry.candidate.id,value:"Café"}]);
  await expect(action(job,"index_finalize",{epoch:page.epoch})).rejects.toMatchObject({code:"PT409"});
  await expect(action(job,"index_record",{epoch:page.epoch,entries:[{candidateId:imported.entry.candidate.id,value:"Another",identityKey:"another"}]})).rejects.toMatchObject({code:"22023"});
  await action(job,"index_record",{epoch:page.epoch,entries:[{candidateId:imported.entry.candidate.id,value:"Café",identityKey:"café"}]});await action(job,"index_finalize",{epoch:page.epoch});
  expect(await action(job,"identities",{keys:["café","cafe","false-but-canonical"]})).toEqual(["café"]);
  await brainRpc(db,"import_local_name",[project,1,{id:"44444444-4444-4444-8444-444444444444",value:"Cedar",createdAt:"2026-10-16T12:00:00Z",origin:"manual",history:[]},{description:"Synthetic imported context"},"cedar","fixture-index-racing-import"]);
  await expect(action(job,"identities",{keys:["café"]})).rejects.toMatchObject({code:"PT409"});
 });
 it("replays only the exact next saved preference head and never overwrites a newer one",async()=>{
  const same=await brainRpc<{preferences:{version:number}}>(db,"save_naming_preferences",[project,0,brainPreferences]);expect(same.preferences.version).toBe(1);
  await brainRpc(db,"save_naming_preferences",[project,1,{...brainPreferences,notes:"Later edit"}]);
  await expect(brainRpc(db,"save_naming_preferences",[project,0,brainPreferences])).rejects.toMatchObject({code:"PT409"});
 });
 it("refuses a foreign worker and the generic service-role lease path",async()=>{
  await brainRpc(db,"ensure_naming_brain_run",[project,initialIntent()]);const {job}=await claimBrain(db);
  await expect(brainWorker(db,()=>db.query("select public.naming_brain_worker_action($1,$2,'heartbeat','{\"leaseSeconds\":120}')",[job.id,job.lease_token]),OWNER_B)).rejects.toMatchObject({code:"42501"});
  await expect(asRole(db,"service_role",null,()=>db.query("select public.heartbeat_job($1,$2,120)",[job.id,job.lease_token]))).rejects.toMatchObject({code:"42501"});
  await expect(brainWorker(db,()=>db.query("insert into fluid_private.naming_brain_financial_evidence(run_id,owner_id,project_id,confirmed_total_microusd,evidence) values(gen_random_uuid(),$1,$2,0,'{}')",[OWNER_A,project]))).rejects.toMatchObject({code:"42501"});
 });
});

import { beginBrainStage, brainAction, planBrainCall, saveBrainArtifact, startBrainFixture } from "./naming-brain-fixture";
describe("Naming Brain single-use dispatch and immutable publication",()=>{
 let db:TestDatabase;let project:string;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30_000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{project=await seedBrainFixture(db);});
 it("allows one preallocated provider create and refuses changed allocation, duplicate authorization and financial claims",async()=>{
  const job=await startBrainFixture(db,project);await beginBrainStage(db,job,"research");const {request,allocation}=await planBrainCall(db,job,"research");
  const authorize=()=>brainWorker(db,async()=>(await db.query<{ok:boolean}>("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb) ok",[job.id,job.lease_token,JSON.stringify(request)])).rows[0]!.ok);
  expect(await authorize()).toBe(true);expect(await authorize()).toBe(false);
  await expect(brainAction(db,job,"call_plan",{stageKey:"research",calls:[{...allocation,requestKey:"fixture-replacement-request"}]})).rejects.toMatchObject({code:"55000"});
  await expect(brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify({...request,accountingStatus:"confirmed",confirmedActualCostMicrousd:0})]))).rejects.toMatchObject({code:"22023"});
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);
  await brainWorker(db,()=>db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment')"));
  expect((await db.query<{state:string}>("select state from public.jobs where id=$1",[job.id])).rows[0]!.state).toBe("needs_reconciliation");expect(await claimBrain(db)).toBeNull();
 });
 it("prepares only source-bound names, appends idempotently and retains provisional expense on success",async()=>{
  const job=await startBrainFixture(db,project),candidateId=crypto.randomUUID();
  const proposal={candidateKey:"one",value:"Cedar",primaryApproach:"real_words",additionalApproaches:[],territoryId:"nature",constructionKey:"whole_word",rationale:"A proposed natural association.",caution:null,claims:[]};
  await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"sourced",sources:[]});
  await saveBrainArtifact(db,job,"direction",{role:"director",round:"initial",assignments:[],feedbackHypotheses:[]});
  const creator=await saveBrainArtifact(db,job,"creation",{role:"creator",assignmentKey:"real",candidates:[proposal]},{candidateIds:[{candidateKey:"one",candidateId}]});
  const curator=await saveBrainArtifact(db,job,"curation",{role:"curator",annotations:[],gaps:[]});
  const verifier=await saveBrainArtifact(db,job,"verification",{role:"verifier",findings:[]},{sources:[]});
  await beginBrainStage(db,job,"gap");await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'gap','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));
  await beginBrainStage(db,job,"prepare");const index=await brainAction(db,job,"index_page",{}) as {epoch:number};await brainAction(db,job,"index_finalize",{epoch:index.epoch});
  const preparedSet={version:1,runId:job.input.runId,stageKey:"prepare",snapshotHash:creator.snapshotHash,schemaVersion:1,promptVersion:"naming-brain-v1",targetCount:100,minimumPerApproach:5,candidateIds:[candidateId],primaryCounts:[{approach:"real_words",count:1}],retainedUnusedIds:[],fulfillment:{status:"partial",targetCount:100,acceptedCount:1,missingCount:99,coverageSatisfied:false,message:"Only one synthetic candidate was prepared."},deficits:[{approach:"real_words",required:5,actual:1,missing:4}],rejected:[],annotations:[],curationArtifactId:curator.artifactId,verificationArtifactId:verifier.artifactId,sourceArtifactIds:[creator.artifactId]};
  const candidate={...proposal,candidateId,sourceArtifactId:creator.artifactId,runId:job.input.runId,snapshotHash:creator.snapshotHash,assignmentKey:"real",assignmentOrder:0,generatedOrder:0,identityKey:"cedar",sources:[]};
  const payload={preparedSet,candidates:[candidate],verification:{runId:job.input.runId,snapshotHash:creator.snapshotHash,verificationArtifactId:verifier.artifactId,artifact:verifier,candidates:[]}};
  await expect(brainAction(db,job,"prepare",{...payload,candidates:[{...candidate,value:"Forged"}]})).rejects.toMatchObject({code:"22023"});
  expect((await db.query<{count:number}>("select count(*)::integer count from public.name_candidates")).rows[0]!.count).toBe(0);
  const prepared=await brainAction(db,job,"prepare",payload) as {preparedSetId:string};
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));
  await brainAction(db,job,"finish",{state:"succeeded",errorCode:null});
  const appended=await brainRpc<{appendedEntryIds:string[];feed:{entries:{entry:{candidate:{origin:{billingMode:string}}}}[]}}>(db,"append_prepared_naming_set",[project,prepared.preparedSetId]);
  expect(appended.appendedEntryIds).toHaveLength(1);expect(appended.feed.entries[0]!.entry.candidate.origin.billingMode).toBe("openai_api");
  const again=await brainRpc<{appendedEntryIds:string[]}>(db,"append_prepared_naming_set",[project,prepared.preparedSetId]);expect(again.appendedEntryIds).toEqual(appended.appendedEntryIds);
  expect(await brainRpc(db,"get_naming_brain_job_accounting",[job.id])).toEqual({status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null});
  expect((await db.query<{state:string}>("select state from public.usage_reservations where job_id=$1",[job.id])).rows[0]!.state).toBe("active");
  const terminal=await brainRpc<{state:string;canResume:boolean;revision:number}>(db,"get_naming_brain_run",[project,job.input.runId]);expect(terminal).toMatchObject({state:"partial",canResume:true});
  const loaded=await brainRpc<{activeRun:{runId:string;canResume:boolean};entries:{entryId:string;position:number}[]}>(db,"get_naming_feed",[project,{}]);expect(loaded.activeRun).toMatchObject({runId:job.input.runId,canResume:true});
  const consumedThrough={entryId:loaded.entries[0]!.entryId,position:loaded.entries[0]!.position};
  await brainRpc(db,"ensure_naming_brain_run",[project,{...initialIntent("fixture-incomplete-scroll"),reason:"scroll",consumedThrough}]);
  expect((await db.query<{count:number}>("select count(*)::integer count from fluid_private.naming_brain_runs")).rows[0]!.count).toBe(1);
  await db.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1",[OWNER_A]);expect((await brainRpc<{canResume:boolean}>(db,"get_naming_brain_run",[project,job.input.runId])).canResume).toBe(false);
  await db.query("update fluid_private.naming_brain_pilots set enabled=true where owner_id=$1",[OWNER_A]);
  const resumed=await brainRpc<{status:string;run:{runId:string;resumedFromRunId:string}}>(db,"ensure_naming_brain_run",[project,{...initialIntent("fixture-partial-success-resume"),reason:"resume",resumeOfRunId:job.input.runId,expectedRunRevision:terminal.revision,consumedThrough}]);
  expect(resumed.status).toBe("pending");expect(resumed.run.resumedFromRunId).toBe(job.input.runId);expect(resumed.run.runId).not.toBe(job.input.runId);
  expect(await brainRpc(db,"get_naming_brain_job_accounting",[job.id])).toEqual({status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null});
  expect((await db.query<{amount:number}>("select reserved_microusd::integer amount from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]!.amount).toBe(10000000);
 });
});

describe("Naming Brain recovery mode and verified financial finalization",()=>{
 let db:TestDatabase;let project:string;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30_000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{project=await seedBrainFixture(db);});
 it("reclaims successful stages under the same run and refuses new direction without sourced research",async()=>{
  const job=await startBrainFixture(db,project);await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"partial",sources:[]});
  await expect(beginBrainStage(db,job,"direction")).rejects.toMatchObject({code:"55000"});
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);
  await brainWorker(db,()=>db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment')"));const resumed=await claimBrain(db);
  expect(resumed.mode).toBe("execute");expect(resumed.job.id).toBe(job.id);expect(resumed.job.lease_token).not.toBe(job.lease_token);
  expect(await beginBrainStage(db,resumed.job,"research")).toMatchObject({disposition:"already_succeeded"});
  expect((await db.query<{count:number}>("select count(*)::integer count from fluid_private.naming_brain_runs")).rows[0]!.count).toBe(1);
 });
 it.each(["fixture-retained-turn",null])("permits observe-only recovery of a retained session with turn %s without another create",async(turnId)=>{
  const job=await startBrainFixture(db,project);await beginBrainStage(db,job,"research");const {request,allocation,snapshot}=await planBrainCall(db,job,"research");
  await brainWorker(db,()=>db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(request)]));
  const receipt={version:1,provider:"openai",billingMode:"openai_api",runId:job.input.runId,stageKey:"research",role:"researcher",snapshotHash:snapshot.snapshotHash,protocol:"openai_agents",providerCallKey:allocation.providerCallKey,assignmentKey:null,requestKey:allocation.requestKey,requestHash:allocation.requestHash,sessionLimitCents:75,dispatchState:"dispatched",requestId:null,callIds:[],observedModel:brainPolicy.model,toolCalls:[],artifactItemIds:[],usageObservations:[],estimatedCostMicrousd:null,providerCostCounters:[],accountingStatus:"provisional",confirmedActualCostMicrousd:null,recordedAt:"2026-10-16T12:00:00Z",sessionId:"fixture-retained-session",turnId,agentId:null,responseId:null};
  await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(receipt)]));
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);
  await brainWorker(db,()=>db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment')"));const resumed=await claimBrain(db);expect(resumed.mode).toBe("observe_only");
  expect(await beginBrainStage(db,resumed.job,"research")).toMatchObject({disposition:"resume_observation"});
  const status=await brainAction(db,resumed.job,"stage",{stageKey:"research"}) as {startedAt:string;receipts:unknown[];recoveryMode:string};expect(status.startedAt).toBeTruthy();expect(status.receipts).toEqual([receipt]);expect(status.recoveryMode).toBe("observe_only");
  const authorized=await brainWorker(db,()=>db.query<{ok:boolean}>("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb) ok",[resumed.job.id,resumed.job.lease_token,JSON.stringify(request)]));expect(authorized.rows[0]!.ok).toBe(false);
 });
 it("binds inherited source evidence to the exact saved owned dependency receipt",async()=>{
  const job=await startBrainFixture(db,project);
  const research=await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"sourced",sources:[]});
  await saveBrainArtifact(db,job,"direction",{role:"director",round:"initial",assignments:[],feedbackHypotheses:[]});
  await saveBrainArtifact(db,job,"creation",{role:"creator",assignmentKey:"real",candidates:[]},{candidateIds:[]});
  await saveBrainArtifact(db,job,"curation",{role:"curator",annotations:[],gaps:[]});
  const sources=(research as unknown as {sources:{sourceKey:string;providerItemId:string;contentHash:string}[]}).sources;
  const dependency={artifactId:research.artifactId,runId:research.runId,snapshotHash:research.snapshotHash,providerReceipt:research.providerReceipt,sources:sources.map(source=>({sourceKey:source.sourceKey,providerItemId:source.providerItemId,contentHash:source.contentHash}))};
  const saved=await saveBrainArtifact(db,job,"verification",{role:"verifier",findings:[]},{sources,sourceDependencies:[dependency]},false);
  await expect(brainAction(db,job,"artifact",{artifact:{...saved,artifactId:crypto.randomUUID(),sources:[{...sources[0],contentHash:"f".repeat(64)}]}})).rejects.toMatchObject({code:"22023"});
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'verification','succeeded',$3::jsonb)",[job.id,job.lease_token,JSON.stringify({artifactIds:[saved.artifactId]})]));
  expect((await brainAction(db,job,"stage",{stageKey:"verification"}) as {artifacts:unknown[]}).artifacts).toEqual([saved]);
 });
 it("settles only verified complete financial evidence once and releases only the unused allowance",async()=>{
  const job=await startBrainFixture(db,project);
  await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"partial",sources:[]});
  await brainAction(db,job,"finish",{state:"partial",errorCode:"fixture_incomplete_research"});
  await db.exec("begin");
  const badEvidence=(await db.query<{id:string}>("insert into fluid_private.naming_brain_financial_evidence(run_id,owner_id,project_id,confirmed_total_microusd,evidence) values($1,$2,$3,1000000,'{\"kind\":\"estimated_cap\",\"sourceRecordId\":\"fixture-estimate\",\"final\":true,\"coveredCallKeys\":[]}') returning id",[job.input.runId,OWNER_A,project])).rows[0]!.id;
  await expect(db.query("select fluid_private.naming_brain_reconcile($1,$2)",[job.input.runId,badEvidence])).rejects.toMatchObject({code:"55000"});
  // The invalid administrative fixture transaction is rolled back; immutable
  // history remains enforced while a new verified-evidence transaction is tested.
  await db.exec("rollback");
  const evidence=(await db.query<{id:string}>("insert into fluid_private.naming_brain_financial_evidence(run_id,owner_id,project_id,confirmed_total_microusd,evidence) values($1,$2,$3,1000000,'{\"kind\":\"confirmed_provider_billing\",\"sourceRecordId\":\"synthetic-billing-receipt\",\"final\":true,\"coveredCallKeys\":[\"fixture-call-research\"]}') returning id",[job.input.runId,OWNER_A,project])).rows[0]!.id;
  await db.query("select fluid_private.naming_brain_reconcile($1,$2)",[job.input.runId,evidence]);await db.query("select fluid_private.naming_brain_reconcile($1,$2)",[job.input.runId,evidence]);
  expect(await brainRpc(db,"get_naming_brain_job_accounting",[job.id])).toEqual({status:"settled",heldAllowanceMicrousd:0,confirmedActualCostMicrousd:1000000});
  expect((await db.query<{reserved:number;spent:number;actual:number}>("select reserved_microusd::integer reserved,spent_microusd::integer spent,provider_actual_microusd::integer actual from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({reserved:0,spent:1000000,actual:1000000});
  for(let n=0;n<4;n++){
   const target=(await brainRpc<{id:string}>(db,"create_project",["naming_only",`Synthetic after settlement ${n}`,{description:"Synthetic conserved allowance"},"a".repeat(64)])).id;
   await brainRpc(db,"save_naming_preferences",[target,0,brainPreferences]);await attestBrainPreferences(db);
   expect((await brainRpc<{status:string}>(db,"ensure_naming_brain_run",[target,initialIntent(`fixture-conservation-run-${n}`)])).status).toBe("pending");
  }
  const sixth=(await brainRpc<{id:string}>(db,"create_project",["naming_only","Synthetic conserved ceiling",{description:"Synthetic ceiling"},"a".repeat(64)])).id;await brainRpc(db,"save_naming_preferences",[sixth,0,brainPreferences]);await attestBrainPreferences(db);
  expect(await brainRpc(db,"ensure_naming_brain_run",[sixth,initialIntent("fixture-conserved-sixth")])).toMatchObject({status:"blocked",code:"pilot_allowance_held"});
  expect((await db.query<{total:number}>("select sum(coalesce(actual_cost_microusd,5000000))::integer total from fluid_private.naming_brain_runs")).rows[0]!.total).toBe(21000000);
  expect((await db.query<{reserved:number;actual:number}>("select reserved_microusd::integer reserved,provider_actual_microusd::integer actual from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({reserved:20000000,actual:1000000});
 });
});

describe("Naming Brain complete historical identity coverage",()=>{
 let db:TestDatabase;
 beforeAll(async()=>{db=await createTestDatabase({before:"20261016180000_naming_brain.sql"});},30_000);afterAll(async()=>{await db?.close();});
 it("admits beyond the legacy10000 snapshot limit and normalizes every historical value through bounded pages",async()=>{
  const timings:Record<string,number>={};let at=performance.now();
  await resetFixture(db);
  const project=(await brainRpc<{id:string}>(db,"create_project",["naming_only","Historical synthetic fixture",{description:"Synthetic history"},"a".repeat(64)])).id;
  await brainRpc(db,"save_naming_preferences",[project,0,{version:1,creativeLocale:"en",notes:"",minimumGraphemes:null,maximumGraphemes:null}]);
  await db.query(`with fixture as (select gen_random_uuid() id,'FixtureName'||lpad(n::text,5,'0') value from generate_series(1,10001) n)
   insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale)
   select id,$1,$2,value,'wrong-supplied-key',1,fluid_private.naming_strategy_basis('{"description":"Synthetic history"}'::jsonb),
    jsonb_build_object('kind','local_import','ownerId',$1::uuid,'projectId',$2::uuid,'candidateId',id,'contextRevision',1,'source',jsonb_build_object('id',id,'value',value,'createdAt','2026-10-16T12:00:00Z','origin','manual','history','[]'::jsonb),'capturedContext','{"description":"Synthetic history"}'::jsonb),'Explicit synthetic history.' from fixture`,[OWNER_A,project]);
  timings.seedMs=performance.now()-at;at=performance.now();
  // These are pre-existing historical rows, so install the additive candidate
  // only after seeding them. All original ownership/FK/lifecycle guards remain on.
  const {readFile}=await import("node:fs/promises");
  await db.exec(await readFile(new URL("../../supabase/migrations/20261016180000_naming_brain.sql",import.meta.url),"utf8"));
  await installBrainFixture(db);await db.query("update public.usage_accounts set limit_microusd=25000000");
  await brainRpc(db,"save_naming_preferences",[project,1,brainPreferences]);
  await db.query("insert into fluid_private.naming_brain_pilots(owner_id,role_name,role_oid,deployment_id,policy,enabled) select $1,rolname,oid,'fixture-deployment',$2::jsonb,true from pg_roles where rolname='fixture_naming_brain_a'",[OWNER_A,JSON.stringify(brainPolicy)]);
  await brainWorker(db,()=>db.query("select public.report_naming_brain_worker_ready($1::jsonb,'fixture-deployment','fixture-worker',120)",[JSON.stringify(brainPolicy)]));
  await db.query("update fluid_private.naming_brain_pilots set readiness_fingerprint=$1::jsonb",[JSON.stringify(brainReadinessFingerprint)]);await attestBrainPreferences(db);
  await brainRpc(db,"ensure_naming_brain_run",[project,{...initialIntent(),expectedPreferencesVersion:2}]);const {job}=await claimBrain(db);
  await db.exec("analyze public.name_candidates; analyze fluid_private.naming_brain_identity_index");
  timings.migrateAdmitMs=performance.now()-at;at=performance.now();timings.pageReadsMs=0;timings.pageWritesMs=0;
  const plan=await db.query('explain (format json) select c.id,c.value from public.name_candidates c where c.owner_id=$1 and c.project_id=$2 and not exists(select 1 from fluid_private.naming_brain_identity_index ix where ix.candidate_id=c.id and ix.value=c.value) order by c.id limit 500',[OWNER_A,project]);

  let afterId:string|null=null;let count=0;let epoch=0;
  for(let page=0;page<22;page++){
   let pageAt=performance.now();
   const result=await brainAction(db,job,"index_page",{afterId,limit:500}) as {epoch:number;entries:{candidateId:string;value:string}[]};epoch=result.epoch;timings.pageReadsMs+=performance.now()-pageAt;
   if(!result.entries.length)break;
   // Hand-checkable ASCII fixture keys; non-ASCII preservation has its own case.
   pageAt=performance.now();
   await brainAction(db,job,"index_record",{epoch,entries:result.entries.map(row=>({...row,identityKey:row.value.toLowerCase()}))});timings.pageWritesMs+=performance.now()-pageAt;count+=result.entries.length;afterId=result.entries.at(-1)!.candidateId;
  }
  timings.indexPagesMs=performance.now()-at;at=performance.now();
  expect(count).toBe(10001);await brainAction(db,job,"index_finalize",{epoch});
  expect(await brainAction(db,job,"identities",{keys:["fixturename00001","fixturename10001","wrong-supplied-key"]})).toEqual(["fixturename00001","fixturename10001"]);
  expect(await brainAction(db,job,"index_page",{limit:500})).toMatchObject({entries:[]});
  timings.finalizeLookupMs=performance.now()-at;
  if(process.env.NAMING_HISTORY_DIAGNOSTICS)await (await import("node:fs/promises")).writeFile(process.env.NAMING_HISTORY_DIAGNOSTICS,JSON.stringify({timings,plan:plan.rows},null,2));
 // This meaningful bulk-history case executes10001 immutable source checks in WASM.
 },60_000);
});
