import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedWorkerFixture, OWNER_A, OWNER_B } from "../database/shared-worker-fixture";
import { brainPolicy, brainPreferences, brainReadinessFingerprint, brainRpc, initialIntent } from "../database/naming-brain-fixture";
import { sharedSlotLeaseSchema, sharedPendingExecutionSchema, type SharedExecution } from "../../worker/shared-pool/contracts";
import { createSharedNamingLaneEngine } from "../../worker/shared-lanes/naming";
import { NamingBrainstormProviderError, type NamingBrainstormProvider } from "../../src/server/ai/naming-brainstorm-provider";
import { namingFeedSchema } from "../../src/domain/naming-brain";
import { normalizeNamingBrain, verifyBrainstormNamingSource } from "../../src/server/data/naming-brain-provenance";
import type { AuthenticatedContext } from "../../src/server/auth/context";

/** Actual restricted SQL and shared lane engine; provider ports are inert. */
async function fixture(options: { model?: string; retrieveError?: Error; oversized?: boolean; wrongId?: boolean; loseCompletedAck?: boolean; loseStateRead?: boolean; loseDeliveryAck?:boolean; count?:number; priorPublished?:boolean } = {}) {
  const f = await createSharedWorkerFixture({ probe: false }), db = f.db;
  await f.seedUser(OWNER_A); await f.seedUser(OWNER_B);
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_worker_naming.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_naming_brainstorm.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_naming_brainstorm_delivery_recovery.sql", import.meta.url), "utf8"));
  const policy = { ...brainPolicy, model: "gpt-6-luna" };
  const policyIdentity = (await db.query<{ h: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h", [JSON.stringify(policy)])).rows[0]!.h;
  const slot = await f.seedSlot({ lane: "naming", policies: [{ operation: "naming.generate", policyIdentity, policy }] });
  await db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await db.query("insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)", [slot.slotId, JSON.stringify(brainReadinessFingerprint)]);
  const lease = sharedSlotLeaseSchema.parse(await f.lease(slot)); let execution: SharedExecution | null = null;
  const action = async (name: string, args: unknown = {}, e: SharedExecution | null = execution) => f.asSlot(slot, async () => (await db.query<{ v: { execution: SharedExecution; result: Record<string, unknown> } }>("select public.shared_naming_worker_action($1,$2,$3,$4) v", [lease, e, name, JSON.stringify(args)])).rows[0]!.v);
  await action("qualify", [policy, brainReadinessFingerprint], null);
  const project = (await brainRpc<{ id: string }>(db, "create_project", ["naming_only", "Observation synthetic", { description: "Synthetic brief" }, "a".repeat(64)])).id;
  await brainRpc(db, "save_naming_preferences", [project, 0, brainPreferences]);
  await brainRpc(db, "ensure_shared_naming_brainstorm_run", [project, initialIntent("observation-fixture")]);
  const work = (await action("preference_work", [20], null)).result as unknown as { projectId: string; preferencesVersion: number; preferencesHash: string }[];
  const row = work.find(r => r.projectId === project)!;
  await action("attest_preferences", [project, row.preferencesVersion, row.preferencesHash, brainReadinessFingerprint, { ready: true, missing: [] }], null);
  await brainRpc(db, "ensure_shared_naming_brainstorm_run", [project, initialIntent("observation-fixture")]);
  const claimed = await action("claim", ["observation-fixture", slot.deploymentId, 120], null); execution = claimed.execution;
  const input = (claimed.result as { job: { input: { runId: string } } }).job.input;
  const request = { model: policy.model, store: true, stream: true, reasoning: { effort: "low" }, max_output_tokens: 16000, input: "Synthetic source fixture", text: { verbosity: "low", format: { type: "json_schema", name: "naming_brainstorm_v1", strict: true, schema: { type: "object" } } }, metadata: { embel_generation_profile: "brainstorm_v1", embel_job_id: execution.jobId, embel_run_id: input.runId, embel_call_index: "1" } };
  let begun = (await action("brainstorm_begin", { callIndex: 1, candidateTarget: 120, request, expectedHistoryEpoch: 0, historyIdentities: [] })).result;
  if(options.priorPublished){
    const candidate={value:"PriorCedar",rationale:"Previously saved sound.",primaryApproach:"real_words"},responseId="resp_prior_saved";
    await action("brainstorm_event",{callId:begun.callId,kind:"created",responseId,requestId:"req_prior_saved",observedAt:"2026-10-29T21:00:00Z"});
    await action("brainstorm_event",{callId:begun.callId,kind:"completed",responseId,requestId:"req_prior_saved",observedAt:"2026-10-29T21:00:30Z",model:policy.model,
      response:{id:responseId,status:"completed",model:policy.model,output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({candidates:[candidate]})}]}]},usage:null,
      candidates:[{...candidate,identityKey:"priorcedar",graphemeCount:10,caution:"Unchecked brainstorm. Research and screening are needed before use."}]});
    await action("brainstorm_publish",{callId:begun.callId});
    const history=(await db.query("select id as \"candidateId\",value,identity_key as \"identityKey\" from public.name_candidates where project_id=$1",[project])).rows;
    const epoch=(await db.query<{epoch:number}>("select writer_epoch as epoch from fluid_private.naming_brain_heads where project_id=$1",[project])).rows[0]!.epoch;
    begun=(await action("brainstorm_begin",{callIndex:2,candidateTarget:60,request:{...request,metadata:{...request.metadata,embel_call_index:"2"}},expectedHistoryEpoch:epoch,historyIdentities:history})).result;
  }
  const responseId = "resp_observation_fixture_1";
  await action("brainstorm_event", { callId: begun.callId, kind: "created", responseId, requestId: "req_observation_fixture", observedAt: "2026-10-29T21:27:30Z" });
  await action("brainstorm_event", { callId: begun.callId, kind: "unknown", responseId, requestId: "req_observation_fixture", observedAt: "2026-10-29T21:27:59Z" });
  expect((await action("brainstorm_finish")).result).toEqual({ state: "needs_reconciliation", publishedCount: options.priorPublished?1:0 });
  const readPending = async () => f.asSlot(slot, async () => (await db.query<{ pending: unknown }>("select public.read_shared_worker_executions($1) pending", [lease])).rows.map(r => sharedPendingExecutionSchema.parse(r.pending)));
  const pending = await readPending(); expect(pending).toHaveLength(1);
  const provider: NamingBrainstormProvider = { create: vi.fn(async () => { throw Error("create must never be called"); }), cancel: vi.fn(async () => { throw Error("cancel must never be called"); }), retrieve: vi.fn(async id => {
    expect(id).toBe(responseId); if (options.retrieveError) throw options.retrieveError;
    return { requestId: "req_observation_get", response: { id: options.wrongId ? "resp_foreign" : responseId, status: "completed", model: options.model ?? policy.model,
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ candidates: Array.from({length:options.count??1},(_,index)=>({value:options.count?`SyntheticCedar${index}`:"SyntheticCedar",rationale:"Synthetic sound.",primaryApproach:"real_words"})) }) }] }], usage: { input_tokens: 8, output_tokens: 9, total_tokens: 17 }, ...(options.oversized ? { ignored: "x".repeat(524_288) } : {}) } };
  }) };
  const actions: string[] = [];
  const engine = createSharedNamingLaneEngine({ database: { async query(sql, values = []) {
    actions.push(String(values[2]));
    if (options.loseStateRead && values[2] === "brainstorm_state") throw Error("synthetic private state-read failure");
    const result = await f.asSlot(slot, () => db.query<Record<string, unknown>>(sql, values));
    if (options.loseCompletedAck && values[2] === "brainstorm_event") throw Error("synthetic private committed-ack failure");
    if (options.loseDeliveryAck && values[2] === "brainstorm_recover_delivery") throw Error("synthetic committed delivery-ack failure");
    return result;
  } }, slot: () => lease, deploymentId: slot.deploymentId, workerId: "observation-fixture", provider: { apiKey: "synthetic-never-live", model: policy.model, modelVerificationReceipt: "synthetic-model-proof" }, policy }, { brainstormProvider: provider });
  type Witness = Record<string, unknown> & { run: Record<string, unknown> & { revision: number; updated_at: string } };
  const snapshot = async () => (await db.query<{ v: Witness }>(`select jsonb_build_object('job',(select to_jsonb(j) from public.jobs j where id=$1),'run',(select to_jsonb(r)from fluid_private.naming_brain_runs r where id=$2),'call',(select to_jsonb(c)from fluid_private.naming_brainstorm_calls c where call_id=$3),'events',(select jsonb_agg(to_jsonb(e)order by created_at,event_id)from fluid_private.naming_brainstorm_events e where call_id=$3),'execution',(select to_jsonb(e)from fluid_private.shared_worker_executions e where job_id=$1),'publications',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from fluid_private.naming_brainstorm_publications p where call_id=$3)) v`, [execution!.jobId, input.runId, begun.callId])).rows[0]!.v;
  return { f, db, slot, lease, engine, provider, pending, actions, snapshot, project, execution, callId: begun.callId, action };
}

describe("brainstorm known-response observation containment (actual restricted SQL, inert provider)", () => {
  it.each([
    ["model mismatch", { model: "gpt-6-luna-2026-10-01" }],
    ["response bound", { oversized: true }],
    ["foreign response", { wrongId: true }],
    ["provider 404", { retrieveError: new NamingBrainstormProviderError("request_rejected") }],
    ["provider transport", { retrieveError: new NamingBrainstormProviderError("outcome_unknown") }],
    ["provider byte bound", { retrieveError: new NamingBrainstormProviderError("protocol_limit") }],
  ] as const)("retains %s without poisoning the lane, changing immutable evidence or another create", async (_label, options) => {
    const f = await fixture(options); try {
      const before = await f.snapshot();
      expect(await f.engine.recover!(f.pending)).toEqual({ disposition: "retry", state: "retained_unsupported" });
      const after = await f.snapshot();
      // The unchanged recover RPC sets observe_only, invoking its existing
      // revision/timestamp trigger. Every other captured byte must remain exact.
      expect(after).toEqual({ ...before, run: { ...before.run, revision: before.run.revision + 1, updated_at: expect.any(String) } });
      expect(f.provider.retrieve).toHaveBeenCalledOnce();
      expect(f.actions).toEqual(["recover", "brainstorm_state", "brainstorm_recover_delivery"]);
      expect(await f.engine.run()).toEqual({ disposition: "ack", state: "idle" });
      expect(f.provider.create).not.toHaveBeenCalled(); expect(f.provider.cancel).not.toHaveBeenCalled();
      await expect(f.engine.close()).resolves.toBeUndefined();
    } finally { await f.engine.close().catch(() => {}); await f.f.close(); }
  }, 60000);
  it("delivers a verified retained response through owned feed and selection while its charge stays unknown", async () => {
    const f = await fixture(); try {
      const reservations=(await f.db.query("select to_jsonb(r) row from public.usage_reservations r where job_id=$1",[f.execution.jobId])).rows;
      expect(await f.engine.recover!(f.pending)).toEqual({ disposition: "retry", state: "observation_retained" });
      expect(f.provider.retrieve).toHaveBeenCalledOnce(); expect(f.provider.create).not.toHaveBeenCalled(); expect(f.provider.cancel).not.toHaveBeenCalled();
      expect(f.actions).not.toContain("brainstorm_publish"); expect(f.actions).not.toContain("brainstorm_finish");
      expect((await f.db.query<{kind:string}>("select kind from fluid_private.naming_brainstorm_events where call_id=$1 order by created_at", [f.callId])).rows.map(r => r.kind)).toEqual(["created", "unknown", "completed"]);
      expect((await f.db.query("select state,attempts,actual_cost_microusd from public.jobs where id=$1", [f.execution.jobId])).rows).toEqual([{ state: "needs_reconciliation", attempts: 1, actual_cost_microusd: 0 }]);
      expect((await f.db.query("select actual_cost_microusd from fluid_private.naming_brain_runs where job_id=$1", [f.execution.jobId])).rows).toEqual([{ actual_cost_microusd: null }]);
      expect((await f.db.query("select count(*)::integer n from fluid_private.naming_brainstorm_publications")).rows).toEqual([{ n: 1 }]);
      expect((await f.db.query("select to_jsonb(r) row from public.usage_reservations r where job_id=$1",[f.execution.jobId])).rows).toEqual(reservations);
      const feed=namingFeedSchema.parse(normalizeNamingBrain(await brainRpc(f.db,"get_naming_feed",[f.project,{}]),OWNER_A));
      expect(feed.activeRun).toMatchObject({state:"needs_reconciliation",recoveredNameCount:1,accounting:{status:"held_unsettled",confirmedActualCostMicrousd:null}});
      expect(feed.entries.map(row=>row.entry.candidate.value)).toEqual(["SyntheticCedar"]);
      const candidate=feed.entries[0]!.entry.candidate;
      const sources=await brainRpc<unknown[]>(f.db,"get_naming_brainstorm_sources",[f.project,`{${candidate.id}}`]);
      expect(sources).toEqual([expect.objectContaining({candidateId:candidate.id,value:"SyntheticCedar"})]);
      await expect(verifyBrainstormNamingSource({userId:OWNER_A} as AuthenticatedContext,candidate,normalizeNamingBrain(sources[0],OWNER_A))).resolves.toMatchObject({candidateId:candidate.id});
      // Exact replay neither retrieves nor publishes the already delivered call.
      expect(await f.engine.recover!(f.pending)).toEqual({disposition:"retry",state:"retained_unsupported"});
      expect(f.provider.retrieve).toHaveBeenCalledOnce();
      expect((await f.db.query("select count(*)::integer n from public.name_candidates where project_id=$1",[f.project])).rows).toEqual([{n:1}]);
      expect(await brainRpc(f.db,"select_project_name",[f.project,candidate.id,1,false])).toMatchObject({currentSelection:{candidate:{id:candidate.id}}});
      expect(await f.engine.run()).toEqual({ disposition: "ack", state: "idle" }); await expect(f.engine.close()).resolves.toBeUndefined();
    } finally { await f.engine.close().catch(() => {}); await f.f.close(); }
  }, 60000);
  it.each(["cancelled", "paused", "deleted", "changed steering", "changed preferences", "superseded", "banned"] as const)("retains the response without publishing after %s",async mode=>{
    const f=await fixture();try{
      if(mode==="cancelled")await f.db.query("update public.jobs set cancel_requested_at=clock_timestamp() where id=$1",[f.execution.jobId]);
      if(mode==="paused")await f.db.query("update fluid_private.naming_brain_heads set paused=true where project_id=$1",[f.project]);
      if(mode==="deleted")await brainRpc(f.db,"request_project_deletion",[f.project,1,0]);
      if(mode==="changed steering")await f.db.query("update fluid_private.naming_brain_heads set steering_revision=steering_revision+1 where project_id=$1",[f.project]);
      if(mode==="changed preferences")await brainRpc(f.db,"save_naming_preferences",[f.project,1,{...brainPreferences,notes:"Updated after the original request."}]);
      if(mode==="superseded")await f.db.query("update fluid_private.naming_brain_runs set superseded=true where job_id=$1",[f.execution.jobId]);
      if(mode==="banned")await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[OWNER_A]);
      const reservations=(await f.db.query("select to_jsonb(r) row from public.usage_reservations r where job_id=$1",[f.execution.jobId])).rows;
      expect(await f.engine.recover!(f.pending)).toEqual({disposition:"retry",state:"observation_retained"});
      expect((await f.db.query("select count(*)::integer n from fluid_private.naming_brainstorm_publications")).rows).toEqual([{n:0}]);
      expect((await f.db.query("select count(*)::integer n from fluid_private.naming_brainstorm_delivery_recoveries")).rows).toEqual([{n:0}]);
      expect((await f.db.query("select to_jsonb(r) row from public.usage_reservations r where job_id=$1",[f.execution.jobId])).rows).toEqual(reservations);
      expect(f.provider.create).not.toHaveBeenCalled();
    }finally{await f.engine.close().catch(()=>{});await f.f.close();}
  },60000);
  it("recovers a lost delivery acknowledgement without publishing twice or altering original receipts",async()=>{
    const f=await fixture({loseDeliveryAck:true});try{
      await expect(f.engine.recover!(f.pending)).rejects.toThrow("shared_naming_observation_unconfirmed");
      const events=(await f.db.query("select to_jsonb(e) row from fluid_private.naming_brainstorm_events e where call_id=$1 order by created_at,event_id",[f.callId])).rows;
      expect((await f.action("brainstorm_recover_delivery")).result).toEqual({status:"retained_unknown",insertedCount:0});
      expect((await f.db.query("select count(*)::integer n from public.name_candidates where project_id=$1",[f.project])).rows).toEqual([{n:1}]);
      expect((await f.db.query("select to_jsonb(e) row from fluid_private.naming_brainstorm_events e where call_id=$1 order by created_at,event_id",[f.callId])).rows).toEqual(events);
      expect((await f.db.query("select count(*)::integer n from fluid_private.naming_brainstorm_completions")).rows).toEqual([{n:0}]);
      expect(f.provider.create).not.toHaveBeenCalled();expect(f.provider.retrieve).toHaveBeenCalledOnce();
    }finally{await f.engine.close().catch(()=>{});await f.f.close();}
  },60000);
  it("denies a forged delivery owner and direct private-helper access",async()=>{
    const f=await fixture();try{
      await expect(f.action("brainstorm_recover_delivery",{},{...f.execution,ownerId:OWNER_B})).rejects.toThrow("shared_execution_denied");
      await expect(f.f.asSlot(f.slot,()=>f.db.query("select fluid_private.recover_naming_brainstorm_delivery($1,$2,'{}')",[f.lease,f.execution]))).rejects.toThrow(/permission denied/);
      expect((await f.db.query("select count(*)::integer n from fluid_private.naming_brainstorm_publications")).rows).toEqual([{n:0}]);
    }finally{await f.engine.close().catch(()=>{});await f.f.close();}
  },60000);
  it.each([false,true])("preserves prior partial names when the retained call remains unknown=%s",async unknown=>{
    const f=await fixture({priorPublished:true,...(unknown?{retrieveError:new NamingBrainstormProviderError("outcome_unknown")}: {})});try{
      await f.engine.recover!(f.pending);
      const feed=namingFeedSchema.parse(normalizeNamingBrain(await brainRpc(f.db,"get_naming_feed",[f.project,{}]),OWNER_A));
      expect(feed.entries.map(row=>row.entry.candidate.value)).toEqual(unknown?["PriorCedar"]:["PriorCedar","SyntheticCedar"]);
      expect(feed.activeRun).toMatchObject({state:"needs_reconciliation",accounting:{confirmedActualCostMicrousd:null}});
      expect(f.provider.create).not.toHaveBeenCalled();
    }finally{await f.engine.close().catch(()=>{});await f.f.close();}
  },60000);
  it("delivers a full hundred saved names without claiming a completed job or zero charge",async()=>{
    const f=await fixture({count:100});try{
      await f.engine.recover!(f.pending);
      const feed=namingFeedSchema.parse(normalizeNamingBrain(await brainRpc(f.db,"get_naming_feed",[f.project,{}]),OWNER_A));
      expect(feed.entries).toHaveLength(100);expect(feed.activeRun).toMatchObject({state:"needs_reconciliation",recoveredNameCount:100,accounting:{confirmedActualCostMicrousd:null}});
      expect((await f.db.query("select count(*)::integer n from fluid_private.naming_brainstorm_completions")).rows).toEqual([{n:0}]);
      expect(f.provider.create).not.toHaveBeenCalled();
    }finally{await f.engine.close().catch(()=>{});await f.f.close();}
  },60000);
  it.each(["state read", "completed acknowledgement", "unexpected provider error"] as const)("still rejects %s and preserves the unconfirmed-drain boundary", async kind => {
    const f = await fixture(kind === "state read" ? { loseStateRead: true } : kind === "completed acknowledgement" ? { loseCompletedAck: true } : { retrieveError: Error("synthetic private unexpected failure") });
    try {
      await expect(f.engine.recover!(f.pending)).rejects.toThrow("shared_naming_observation_unconfirmed");
      await expect(f.engine.close()).rejects.toThrow("shared_naming_drain_unconfirmed");
      expect(f.provider.create).not.toHaveBeenCalled(); expect(f.provider.cancel).not.toHaveBeenCalled();
      if (kind === "completed acknowledgement") expect((await f.db.query("select count(*)::integer n from fluid_private.naming_brainstorm_events where call_id=$1 and kind='completed'", [f.callId])).rows).toEqual([{ n: 1 }]);
    } finally { await f.engine.close().catch(() => {}); await f.f.close(); }
  }, 60000);
  it("retains a fixed diagnostic through the unchanged restricted SQL event contract", async () => {
    const f = await fixture(); try {
      const before = (await f.db.query("select payload from fluid_private.naming_brainstorm_events where call_id=$1 order by created_at,event_id", [f.callId])).rows;
      const event = { callId: f.callId, kind: "unknown", responseId: "resp_observation_fixture_1", requestId: "req_observation_fixture", errorCode: "response_model_mismatch", observedAt: "2026-10-29T22:00:00Z" };
      await f.f.asSlot(f.slot, () => f.db.query("select public.shared_naming_worker_action($1,$2,$3,$4)", [f.lease, f.execution, "brainstorm_event", JSON.stringify(event)]));
      const after = (await f.db.query<{payload:unknown}>("select payload from fluid_private.naming_brainstorm_events where call_id=$1 order by created_at,event_id", [f.callId])).rows;
      expect(after.slice(0, before.length)).toEqual(before); expect(after.at(-1)).toEqual({ payload: event });
      expect(f.provider.create).not.toHaveBeenCalled(); expect(f.provider.retrieve).not.toHaveBeenCalled();
    } finally { await f.engine.close().catch(() => {}); await f.f.close(); }
  }, 60000);
  it("still rejects a forged owner before provider retrieval", async () => {
    const f = await fixture(); try {
      await expect(f.engine.recover!([{ ...f.pending[0]!, execution: { ...f.pending[0]!.execution, ownerId: OWNER_B } }])).rejects.toThrow(/shared_execution_denied/);
      expect(f.provider.retrieve).not.toHaveBeenCalled(); expect(f.provider.create).not.toHaveBeenCalled();
    } finally { await f.engine.close().catch(() => {}); await f.f.close(); }
  }, 60000);
});
