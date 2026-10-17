import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { createTestDatabase,OWNER_A,type TestDatabase } from "./local-supabase";
import { brainAction,brainRpc,brainWorker,initialIntent,installBrainFixture,prepareBrainFixture,seedBrainFixture } from "./naming-brain-fixture";

type Run={runId:string;revision:number;state:string;canResume:boolean;demandSequence:number};
type Feed={state:string;demandSequence:number;activeRun:Run|null;entries:unknown[]};
type Result={status:string;feed:Feed;run:Run;appendedEntryIds:string[]};
const stopIntent=(sequence:number,key="fixture-stop-request-key",pending:string|null=null)=>({version:1,expectedDemandSequence:sequence,pendingEnsureIdempotencyKey:pending,idempotencyKey:key});
describe("Naming durable Stop and explicit Continue (local SQL)",()=>{
 let db:TestDatabase;let project:string;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{project=await seedBrainFixture(db);});
 const ensure=(intent:unknown)=>brainRpc<Result>(db,"ensure_naming_brain_run",[project,intent]);
 const stop=(intent:unknown)=>brainRpc<{feed:Feed}>(db,"stop_naming_feed",[project,intent]);
 const feed=()=>brainRpc<Feed>(db,"get_naming_feed",[project,{}]);
 const current=async()=> (await feed()).activeRun!;
 const resume=(run:Run,sequence:number,key:string)=>({...initialIntent(key),reason:"resume",resumeOfRunId:run.runId,expectedRunRevision:run.revision,expectedDemandSequence:sequence});
 it("stops a committed initial admission with lost ack using only its pre-ack sequence, exactly once",async()=>{
  const pending=initialIntent();await ensure(pending);
  const intent=stopIntent(0,"fixture-stop-after-commit",pending.idempotencyKey);
  const stopped=await stop(intent);expect(stopped.feed).toMatchObject({state:"paused",demandSequence:1,activeRun:{state:"cancelled"}});
  expect((await stop(intent)).feed.demandSequence).toBe(1);
  expect((await ensure(pending)).status).toBe("paused");
  await expect(ensure(initialIntent("fixture-late-uncommitted-key"))).rejects.toMatchObject({code:"PT409"});
  expect((await db.query<{n:number}>("select count(*)::integer n from fluid_private.naming_brain_runs")).rows[0]!.n).toBe(1);
 });
 it("Stop wins before admission and only explicit initial Continue unpauses a no-run head",async()=>{
  const pending=initialIntent();expect((await stop(stopIntent(0))).feed).toMatchObject({state:"paused",demandSequence:1,activeRun:null});
  await expect(ensure(pending)).rejects.toMatchObject({code:"PT409"});
  expect((await ensure({...initialIntent("fixture-initial-continue"),expectedDemandSequence:1})).status).toBe("pending");
  expect((await feed()).demandSequence).toBe(1);
 });
 it("binds Stop to the exact latest paid Resume receipt after lost ack and rejects an unrelated later head",async()=>{
  await ensure(initialIntent());await stop(stopIntent(0));const old=await current();
  const request=resume(old,1,"fixture-paid-resume-first");await ensure(request);
  expect((await stop(stopIntent(1,"fixture-stop-resume-ack",request.idempotencyKey))).feed).toMatchObject({state:"paused",demandSequence:3});
  const next=await current();await ensure(resume(next,3,"fixture-paid-resume-later"));
  await expect(stop(stopIntent(1,"fixture-stop-unrelated-demand",request.idempotencyKey))).rejects.toMatchObject({code:"PT409"});
 });
 it("Stop winning before Resume fences its stale source without creating a new run",async()=>{
  const admitted=await ensure(initialIntent());await brainRpc(db,"request_job_cancel",[(await db.query<{job_id:string}>("select job_id from fluid_private.naming_brain_runs where id=$1",[admitted.run.runId])).rows[0]!.job_id]);
  const request=resume(await current(),0,"fixture-resume-before-stop");await stop(stopIntent(0,"fixture-stop-before-resume",request.idempotencyKey));
  await expect(ensure(request)).rejects.toMatchObject({code:"PT409"});
  expect((await db.query<{n:number}>("select count(*)::integer n from fluid_private.naming_brain_runs")).rows[0]!.n).toBe(1);
 });
 it("treats likes as soft feedback and strong steering as a persisted direction change",async()=>{
  const {job,preparedSetId,preparedSet}=await prepareBrainFixture(db,project,1);
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));await brainAction(db,job,"finish",{state:"succeeded",errorCode:null});
  const candidateId=preparedSet.candidateIds[0]!;
  await brainRpc(db,"set_name_retention",[project,candidateId,0,true,false]);
  expect(await feed()).toMatchObject({feedbackRevision:1,steeringRevision:0,preparedSetId});
  const intent={expectedProjectRevision:1,expectedPreferencesVersion:1,expectedSteeringRevision:0,candidateIds:[candidateId],instruction:null,idempotencyKey:"fixture-strong-seed-steering"};
  const steered=await brainRpc<{feed:Feed;supersededRunIds:string[]}>(db,"steer_naming_feed",[project,intent]);
  expect(steered.feed).toMatchObject({steeringRevision:1,demandSequence:1,preparedSetId:null,activeRun:null});expect(steered.supersededRunIds).toEqual([job.input.runId]);
  expect((await brainRpc<{feed:Feed}>(db,"steer_naming_feed",[project,intent])).feed.demandSequence).toBe(1);
  await expect(brainRpc(db,"append_prepared_naming_set",[project,preparedSetId])).rejects.toMatchObject({code:"PT409"});
  expect((await ensure({...initialIntent("fixture-after-strong-steer"),expectedSteeringRevision:1,expectedDemandSequence:1})).status).toBe("pending");
 });
 it("saves late strong steering after Stop without clearing pause or rebasing the Stop epoch",async()=>{
  const {preparedSet}=await prepareBrainFixture(db,project,1);const candidateId=preparedSet.candidateIds[0]!;
  const alreadySent={expectedProjectRevision:1,expectedPreferencesVersion:1,expectedSteeringRevision:0,candidateIds:[candidateId],instruction:null,idempotencyKey:"fixture-late-steering-ack"};
  await stop(stopIntent(0));
  const result=await brainRpc<{feed:Feed}>(db,"steer_naming_feed",[project,alreadySent]);expect(result.feed).toMatchObject({state:"paused",paused:true,steeringRevision:1,demandSequence:1});
  expect((await db.query<{n:number}>("select count(*)::integer n from fluid_private.naming_brain_runs")).rows[0]!.n).toBe(1);
 });
 it("project deletion preserves dispatched managed liability and immutable results",async()=>{
  const {job}=await prepareBrainFixture(db,project,1);
  expect(await brainRpc(db,"request_project_deletion",[project,1,0])).toMatchObject({deletion_state:"stopping"});
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));await brainAction(db,job,"finish",{state:"cancelled",errorCode:null});
  expect(await brainRpc(db,"get_project_deletion",[project])).toMatchObject({deletion_state:"awaiting_resolution"});
  expect(await brainRpc(db,"get_naming_brain_job_accounting",[job.id])).toEqual({status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null});
  expect((await db.query<{n:number}>("select count(*)::integer n from fluid_private.naming_brain_prepared_sets")).rows[0]!.n).toBe(1);
 });
 it("retains complete preparation through late Stop, consumes it free, and binds a second Stop to the free receipt",async()=>{
  const {job,preparedSetId}=await prepareBrainFixture(db,project);
  const stopped=await stop(stopIntent(0));expect(stopped.feed.state).toBe("paused");
  await expect(brainRpc(db,"append_prepared_naming_set",[project,preparedSetId])).rejects.toMatchObject({code:"PT409"});
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));
  await brainAction(db,job,"finish",{state:"cancelled",errorCode:null});
  const saved=await current();expect(saved).toMatchObject({state:"succeeded",canResume:true,demandSequence:0});
  await db.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1",[OWNER_A]);
  const request=resume(saved,1,"fixture-free-continue-request");const result=await ensure(request);
  expect(result).toMatchObject({status:"appended",feed:{state:"active",demandSequence:2,activeRun:{runId:saved.runId}}});expect(result.appendedEntryIds).toHaveLength(100);
  expect((await stop(stopIntent(1,"fixture-free-continue-lost-ack",request.idempotencyKey))).feed.demandSequence).toBe(3);
  const again=await ensure(resume(await current(),3,"fixture-complete-empty-continue"));expect(again.status).toBe("appended");expect(again.appendedEntryIds).toEqual([]);expect(again.feed.demandSequence).toBe(4);
  await expect(stop(stopIntent(1,"fixture-free-stale-stop-key",request.idempotencyKey))).rejects.toMatchObject({code:"PT409"});
  expect((await db.query<{n:number;held:number}>("select count(*)::integer n,sum(coalesce(actual_cost_microusd,5000000))::integer held from fluid_private.naming_brain_runs")).rows[0]).toEqual({n:1,held:5000000});
  expect((await current()).canResume).toBe(false);
  await db.query("update fluid_private.naming_brain_pilots set enabled=true where owner_id=$1",[OWNER_A]);
  const cursor=(await db.query<{entryId:string;position:number}>("select id as \"entryId\",position::integer from fluid_private.naming_brain_feed_entries where project_id=$1 order by position desc limit 1",[project])).rows[0]!;
  const fresh=await ensure({...initialIntent("fixture-scroll-after-complete-stop"),reason:"scroll",expectedDemandSequence:4,consumedThrough:cursor});expect(fresh.status).toBe("pending");expect(fresh.run.runId).not.toBe(saved.runId);
  expect((await ensure(request)).status).toBe("paused");

 });
});
