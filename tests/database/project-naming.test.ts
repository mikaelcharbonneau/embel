import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingStrategyBasisSchema, namingStrategyKeyFromBasis, projectNameCandidateSchema } from "../../src/domain/project-naming";
import { chatGPTNamingJobInputSchema, enqueueNamingBatchResponseSchema, getNamingFulfillment, namingBatchDetailResponseSchema, projectNamingOverviewSchema } from "../../src/domain/naming-jobs";
import { asRole, asSubscriptionWorker, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";

// PGlite only. All identities, model names, sources and provider responses are fixtures.
const context = contextSnapshotSchema.parse({ description: "Explicit local naming fixture" });
const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };
const policy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId: "fixture-naming-registration", model: "fixture-model", limits: { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 0, maxRequestsPerHour: 20, maxQueuedJobs: 3 } };
const counts = { invalid_candidate: 0, empty_identity: 0, below_minimum: 0, above_maximum: 0, duplicate_response: 0, duplicate_history: 0, over_target: 0 };
const at = "2026-10-04T12:00:00Z";
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  if (row.strategyBasis) row.strategyKey = namingStrategyKeyFromBasis(namingStrategyBasisSchema.parse(row.strategyBasis));
  return row;
}

describe("project Naming database boundaries (local fixture only)", () => {
  let db: TestDatabase; let project: string;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  const auth = <T>(run: () => Promise<T>, owner = OWNER_A) => asRole(db, "authenticated", owner, run);
  const worker = <T>(run: () => Promise<T>, owner = OWNER_A) => asSubscriptionWorker(db, owner, run);
  async function rpc(name: string, args: unknown[] = [], owner = OWNER_A) {
    return auth(async () => (await db.query<{ result: unknown }>(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as result`, args)).rows[0]!.result, owner);
  }
  async function create(owner = OWNER_A, scope = "naming_only") {
    return auth(async () => (await db.query<{ id: string }>("select * from public.create_project($1,'Naming fixture',$2::jsonb,$3)", [scope, JSON.stringify(context), HASH])).rows[0]!.id, owner);
  }
  beforeEach(async () => { await resetFixture(db); project = await create(); });
  async function configure(value = policy, owner = OWNER_A, operation = "naming.generate") {
    await worker(() => db.query("select public.configure_subscription_runtime($1,$2,$3::jsonb,true)", [owner, operation, JSON.stringify(value)]), owner);
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,90)", [owner, value.registrationId, operation, JSON.stringify(value)]), owner);
    return (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') identity", [JSON.stringify(value)])).rows[0]!.identity;
  }
  const save = (version = 0, value = preferences) => rpc("save_naming_preferences", [project, version, JSON.stringify(value)]);
  async function enqueue(sequence = 0, key = `fixture-naming-intent-${sequence}`, revision = 1, preferenceVersion = 1, identity?: string) {
    const accepted = identity ?? await configure();
    return enqueueNamingBatchResponseSchema.parse(normalize(await rpc("enqueue_subscription_naming_job", [project, revision, preferenceVersion, sequence, key, accepted])));
  }
  async function claim() {
    return worker(async () => (await db.query<{ id: string; lease_token: string; input: unknown }>("select * from public.claim_subscription_job('fixture-worker',$1,$2,90)", [OWNER_A, policy.registrationId])).rows[0]!);
  }
  async function begin() {
    const job = await claim();
    await worker(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify([{ key: "names", maximumCostMicrousd: 0 }])]));
    await worker(() => db.query("select public.begin_job_step($1,$2,'names','fixture-request',0)", [job.id, job.lease_token]));
    return job;
  }
  function output(batch: { id: string; sequence: number; targetCount: 100 | 250 | 50 }, names = ["Cedar", "Elm"]) {
    return { version: 1, operation: "naming.generate", provider: "openai", billingMode: "chatgpt_subscription", model: policy.model, responseId: "fixture-response", requestId: null, generatedAt: at, usage: null,
      batchId: batch.id, sequence: batch.sequence, targetCount: batch.targetCount, accepted: names.map(value => ({ value, identityKey: value.toLowerCase(), rationale: "Explicit local fixture." })), fulfillment: getNamingFulfillment(batch.targetCount, names.length, counts) };
  }
  async function complete(job: { id: string; lease_token: string }, result: unknown, owner = OWNER_A) {
    return worker(() => db.query("select public.complete_naming_job_step($1,$2,'names','succeeded',0,$3::jsonb,'fixture-response')", [job.id, job.lease_token, JSON.stringify(result)]), owner);
  }
  async function generate() {
    await save(); const enqueued = await enqueue(); const job = await begin(); const result = output(enqueued.batch); await complete(job, result);
    await worker(() => db.query("select public.finish_job($1,$2,'succeeded')", [job.id, job.lease_token]));
    const detail = namingBatchDetailResponseSchema.parse(normalize(await rpc("get_naming_batch", [project, enqueued.batch.id])));
    return { enqueued, job, result, ids: detail.result!.candidateIds };
  }
  async function importName(value = "User Name", key = "fixture-local-import-0001", target = project, owner = OWNER_A, revision = 1, captured = context) {
    return rpc("import_local_name", [target, revision, JSON.stringify({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", value, createdAt: at, origin: "manual", history: [] }), JSON.stringify(captured), value.toLowerCase().replace(/\s/g, ""), key], owner) as Promise<{ entry: { candidate: { id: string; origin: unknown } } }>;
  }

  it("reads an unsaved session without invented preferences or provider availability", async () => {
    const overview = projectNamingOverviewSchema.parse(normalize(await rpc("get_project_naming", [project])));
    expect(overview.session).toBeNull(); expect(overview.preferences).toBeNull(); expect(overview.availability).toMatchObject({ status: "unavailable", reason: "naming_policy_unavailable" });
    await expect(rpc("get_project_naming", [project], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });
  it("appends preferences, conflicts on stale input and leaves project revision unchanged", async () => {
    await save(); await save(1, { ...preferences, notes: "Second answer" });
    await expect(save(1)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select version from public.naming_preferences order by version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
    expect((await db.query("select current_revision from public.projects")).rows[0]).toEqual({ current_revision: 1 });
    await expect(auth(() => db.query("update public.naming_preferences set preferences='{}'"))).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("delete from public.naming_preferences")).rejects.toMatchObject({ code: "55000" });
  });
  it("publishes an immutable partial batch with a correctly parsed frozen worker input", async () => {
    const { enqueued, ids } = await generate();
    const stored = (await db.query<{ input: unknown }>("select input from public.jobs where id=$1", [enqueued.job.id])).rows[0]!.input;
    expect(chatGPTNamingJobInputSchema.parse(stored).batch.targetCount).toBe(250);
    const overview = projectNamingOverviewSchema.parse(normalize(await rpc("get_project_naming", [project])));
    expect(overview.candidates.items.map(row => row.candidate.value)).toEqual(["Cedar", "Elm"]);
    expect(overview.jobs[0]!.state).toBe("succeeded"); expect(overview.batches.items[0]!.result!.fulfillment.status).toBe("partial");
    expect(ids).toHaveLength(2);
    await expect(db.query("update public.name_candidates set value='Replaced' where id=$1", [ids[0]])).rejects.toMatchObject({ code: "55000" });
    expect((await auth(() => db.query("select * from public.name_candidates"), OWNER_B)).rows).toEqual([]);
    await expect(worker(() => db.query("select * from public.name_candidates"))).rejects.toMatchObject({ code: "42501" });
  });
  it.each([0,250])("publishes exactly %i accepted names with honest terminal fulfillment", async (count) => {
    await save();const enqueued=await enqueue();const job=await begin();await complete(job,output(enqueued.batch,Array.from({length:count},(_,index)=>`FixtureName${index}`)));
    const detail=namingBatchDetailResponseSchema.parse(normalize(await rpc("get_naming_batch",[project,enqueued.batch.id])));
    expect(detail.result!.candidateIds).toHaveLength(count);expect(detail.result!.fulfillment.status).toBe(count===250?"complete":"none");
    expect(detail.job.results[0]!.output.accepted).toHaveLength(count);
    expect((await db.query("select count(*)::integer total from public.name_candidates")).rows).toEqual([{total:count}]);
  });
  it("freezes value/key pairs so a canonical but false direct-RPC key fails worker input validation", async () => {
    await save();await rpc("import_local_name",[project,1,JSON.stringify({id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",value:"Cedar",createdAt:at,origin:"manual",history:[]}),JSON.stringify(context),"elm","fixture-poisoned-key-0001"]);
    const enqueued=await enqueue();const frozen=(await db.query<{input:unknown}>("select input from public.jobs where id=$1",[enqueued.job.id])).rows[0]!.input;
    expect(frozen).toMatchObject({exclusionKeys:["elm"],exclusionSnapshot:[{value:"Cedar",identityKey:"elm"}]});
    expect(chatGPTNamingJobInputSchema.safeParse(frozen).success).toBe(false);
  });
  it("rejects oversized history snapshots before admitting a job and never truncates history", async () => {
    await save();const accepted=await configure();
    await db.query(`with names as(select gen_random_uuid() id,rpad('Fixture'||i::text,160,'x') value from generate_series(1,700) i)
      insert into public.name_candidates(id,owner_id,project_id,value,identity_key,context_revision,strategy_basis,origin,rationale)
      select id,$1,$2,value,lower(value),1,fluid_private.naming_strategy_basis($3::jsonb),
      jsonb_build_object('kind','local_import','ownerId',$1::uuid,'projectId',$2::uuid,'candidateId',id,'contextRevision',1,
       'source',jsonb_build_object('id',id,'value',value,'origin','manual','createdAt',$4::text,'history','[]'::jsonb),'capturedContext',$3::jsonb),'Explicit local size-bound fixture.' from names`,[OWNER_A,project,JSON.stringify(context),at]);
    await expect(enqueue(0,"fixture-history-capacity01",1,1,accepted)).rejects.toMatchObject({code:"PT409",message:"naming_history_capacity"});
    expect((await db.query("select id from public.jobs")).rows).toEqual([]);expect((await db.query("select id from public.naming_batches")).rows).toEqual([]);
    expect((await db.query("select count(*)::integer total from public.name_candidates")).rows).toEqual([{total:700}]);
  });
  it("replays the same intent after outage and permits a second batch at the same project revision", async () => {
    const { enqueued } = await generate();
    const same = await enqueue(0, "fixture-other-nonce-0001"); expect(same.batch.id).toBe(enqueued.batch.id);
    const second = await enqueue(1); expect(second.batch.sequence).toBe(2); expect(second.batch.targetCount).toBe(50); expect(second.job.input_revision).toBe(1);
    await worker(() => db.query("select public.disable_subscription_runtime($1,$2)", [OWNER_A, policy.registrationId]));
    const replay = await rpc("enqueue_subscription_naming_job", [project, 1, 1, 1, "fixture-naming-intent-1", second.batch.acceptedPolicyIdentity]);
    expect(replay).toMatchObject({ batch: { id: second.batch.id } });
    await expect(rpc("enqueue_subscription_naming_job", [project, 1, 2, 1, "fixture-changed-intent-001", second.batch.acceptedPolicyIdentity])).rejects.toMatchObject({ code: "PT409" });
  });
  it("rejects stale revision, stale sequence, stale policy and overlapping project work", async () => {
    await save(); const first = await enqueue();
    await expect(enqueue(1)).rejects.toMatchObject({ code: "PT409" });
    await expect(enqueue(0, "fixture-new-policy-0001", 1, 1, "f".repeat(64))).rejects.toMatchObject({ code: "PT409" });
    await rpc("request_job_cancel", [first.job.id]);
    await expect(enqueue(4)).rejects.toMatchObject({ code: "PT409" });
    await expect(enqueue(1, "fixture-stale-revision-01", 2)).rejects.toMatchObject({ code: "PT409" });
  });
  it("shares subscription queue and hour limits across Strategy and Naming", async () => {
    await save(); const bounded = { ...policy, limits: { ...policy.limits, maxQueuedJobs: 1, maxRequestsPerHour: 2 } };
    const identity = await configure(bounded); const strategy = { ...bounded, handlerVersion: "strategy-chatgpt-v1" };
    const strategyIdentity = await configure(strategy, OWNER_A, "strategy.reformulate");
    const first = await rpc("enqueue_subscription_strategy_job", [project, 1, "strategy.reformulate", "fixture-shared-quota-0001", strategyIdentity]) as { id: string };
    await expect(enqueue(0, "fixture-naming-quota-0001", 1, 1, identity)).rejects.toMatchObject({ code: "P0001" });
    await rpc("request_job_cancel", [first.id]); const admitted = await enqueue(0, "fixture-naming-quota-0001", 1, 1, identity);
    await rpc("request_job_cancel", [admitted.job.id]); await expect(enqueue(1, "fixture-naming-quota-0002", 1, 1, identity)).rejects.toMatchObject({ code: "P0001" });
    expect(await rpc("get_strategy_availability", [project])).toMatchObject({ status: "unavailable", reason: "quota_unavailable" });
  });
  it("does not expose Naming as Strategy and rejects arbitrary policy handlers", async () => {
    await configure(); expect(await rpc("get_strategy_availability", [project])).not.toMatchObject({ operations: [{ operation: "naming.generate" }] });
    await expect(configure({ ...policy, handlerVersion: "arbitrary" })).rejects.toMatchObject({ code: "22023" });
    await expect(configure({ ...policy, limits: { ...policy.limits, maxObservedWebSearchCalls: 1 } })).rejects.toMatchObject({ code: "22023" });
    await expect(configure(policy, OWNER_A, "strategy.reformulate")).rejects.toMatchObject({ code: "23514" });
  });
  it("fences worker ownership/lease and disallows generic success without publication", async () => {
    await save();const enqueued = await enqueue();const job=await begin(); const result=output(enqueued.batch);
    await expect(complete(job,result,OWNER_B)).rejects.toMatchObject({ code:"42501" });
    await expect(complete({...job,lease_token:"99999999-9999-4999-8999-999999999999"},result)).rejects.toMatchObject({ code:"PT409" });
    await expect(auth(()=>db.query("select public.complete_naming_job_step($1,$2,'names','succeeded',0,$3::jsonb,'fixture-response')",[job.id,job.lease_token,JSON.stringify(result)]))).rejects.toMatchObject({code:"42501"});
    await expect(worker(()=>db.query("select public.complete_job_step($1,$2,'names','succeeded',0,$3::jsonb,'fixture-response')",[job.id,job.lease_token,JSON.stringify(result)]))).rejects.toMatchObject({code:"55000"});
    await complete(job,result);await complete(job,result);
    await expect(complete(job,output(enqueued.batch,["Changed"]))).rejects.toMatchObject({code:"55000"});
    expect((await db.query("select * from public.name_candidates")).rows).toHaveLength(2);
  });
  it("rolls back the complete step and every candidate if publication fails", async()=>{
    await save();const enqueued=await enqueue();const job=await begin();
    await db.exec("create function public.fixture_reject_candidate() returns trigger language plpgsql as $$ begin if new.value='Elm' then raise exception 'fixture insertion failed'; end if;return new;end $$;create trigger fixture_reject before insert on public.name_candidates for each row execute function public.fixture_reject_candidate()");
    try { await expect(complete(job,output(enqueued.batch))).rejects.toMatchObject({code:"P0001"});
      expect((await db.query("select state from public.job_steps")).rows).toEqual([{state:"in_flight"}]);expect((await db.query("select * from public.name_candidates")).rows).toEqual([]);expect((await db.query("select * from public.naming_batch_results")).rows).toEqual([]);
    }finally{await db.exec("drop trigger fixture_reject on public.name_candidates;drop function public.fixture_reject_candidate()");}
  });
  it("keeps later user captures separate from the immutable admission history",async()=>{
    await save();const enqueued=await enqueue();const job=await begin();await importName("Cedar");await complete(job,output(enqueued.batch));
    const detail=namingBatchDetailResponseSchema.parse(normalize(await rpc("get_naming_batch",[project,enqueued.batch.id])));
    expect(detail.result!.fulfillment).toMatchObject({acceptedCount:2,rejections:{duplicate_history:0}});expect(detail.job.results[0]!.output.accepted.map(x=>x.value)).toEqual(["Cedar","Elm"]);
    expect((await db.query("select origin->>'kind' kind from public.name_candidates where value='Cedar' order by created_at")).rows).toEqual([{kind:"local_import"},{kind:"generated"}]);
  });
  it("rejects stale policy or cancellation while preserving in-flight results for recovery",async()=>{
    await save();const enqueued=await enqueue();const job=await begin();await configure({...policy,model:"changed-model"});
    await expect(complete(job,output(enqueued.batch))).rejects.toMatchObject({code:"55000"});expect((await db.query("select * from public.name_candidates")).rows).toEqual([]);
  });
  it("selects atomically, treats likes separately and preserves earlier selections on edits",async()=>{
    const {ids}=await generate();await rpc("set_name_retention",[project,ids[0],0,true,false]);
    expect((await rpc("get_project_naming",[project]) as {currentSelection:unknown}).currentSelection).toBeNull();
    await rpc("select_project_name",[project,ids[0],1,false]);await rpc("select_project_name",[project,ids[1],2,false]);
    expect((await db.query("select current_revision from public.projects")).rows).toEqual([{current_revision:3}]);
    await expect(rpc("select_project_name",[project,ids[0],2,false])).rejects.toMatchObject({code:"PT409"});
    await expect(rpc("append_project_revision",[project,3,JSON.stringify({...context,selectedName:"Forgery",intake:{...context.intake,suppliedName:"Elm"}}),HASH])).rejects.toMatchObject({code:"22023"});
    await rpc("append_project_revision",[project,3,JSON.stringify({...context,selectedName:"Manual",intake:{...context.intake,suppliedName:"Manual"}}),HASH]);
    expect((await db.query("select current_selection_id from public.naming_sessions")).rows).toEqual([{current_selection_id:null}]);expect((await db.query("select * from public.name_selections")).rows).toHaveLength(2);
  });
  it("requires explicit earlier-context acknowledgment but name selections do not stale batches",async()=>{
    const {ids}=await generate();await rpc("select_project_name",[project,ids[0],1,false]);await rpc("select_project_name",[project,ids[1],2,false]);
    await rpc("append_project_revision",[project,3,JSON.stringify({...context,positioning:"Changed positioning",selectedName:"Elm",intake:{...context.intake,suppliedName:"Elm"}}),HASH]);
    await expect(rpc("select_project_name",[project,ids[0],4,false])).rejects.toMatchObject({code:"PT409"});await rpc("select_project_name",[project,ids[0],4,true]);
  });
  it("imports before preferences without claiming generated ownership and keeps foreign links out",async()=>{
    const imported=await importName();const value=projectNameCandidateSchema.parse(normalize(imported.entry.candidate));expect(value.origin.kind).toBe("local_import");
    const overview=projectNamingOverviewSchema.parse(normalize(await rpc("get_project_naming",[project])));expect(overview.session!.currentPreferencesVersion).toBe(0);expect(overview.preferences).toBeNull();
    const other=await create(OWNER_B);await expect(rpc("select_project_name",[other,value.id,1,true],OWNER_B)).rejects.toMatchObject({code:"P0002"});
    await expect(rpc("import_local_name",[project,1,JSON.stringify({id:value.id,value:"Fake",createdAt:at,origin:"generated",history:[]}),JSON.stringify(context),"fake","fixture-forged-import-001"])).rejects.toMatchObject({code:"22023"});
    await expect(db.query("insert into public.name_retention(candidate_id,owner_id,project_id) values($1,$2,$3)",[value.id,OWNER_B,other])).rejects.toMatchObject({code:"23503"});
  });
  it("stores only user-supplied transform claims and derives immutable root/parent bindings",async()=>{
    const {ids}=await generate();const input={kind:"tweaks",seed:"Cedar",operations:["uppercase"]};
    const valid={candidates:[{value:"CEDAR",identityKey:"cedar",explanation:"Applied Unicode uppercase mapping."}],truncated:false,notes:[]};
    const transformed=await rpc("persist_name_transform",[project,ids[0],null,JSON.stringify(input),JSON.stringify(valid),"fixture-transform-000001"]) as {entries:Array<{candidate:unknown}>};
    const candidate=projectNameCandidateSchema.parse(normalize(transformed.entries[0]!.candidate));expect(candidate.origin).toMatchObject({kind:"transform",authorship:"user_supplied",parentCandidateId:ids[0],root:{kind:"generated",candidateId:ids[0]}});
    const forged=await rpc("persist_name_transform",[project,ids[0],null,JSON.stringify(input),JSON.stringify({...valid,candidates:[{...valid.candidates[0],value:"Forged",identityKey:"forged"}]}),"fixture-transform-forged1"]) as {entries:Array<{candidate:unknown}>};
    expect(projectNameCandidateSchema.safeParse(normalize(forged.entries[0]!.candidate)).success).toBe(false);
    expect((forged.entries[0]!.candidate as {origin:{authorship:string}}).origin.authorship).toBe("user_supplied");
  });
  it("copies an owned account candidate into a complete brand with separate copied provenance",async()=>{
    const imported=await importName();const candidateId=imported.entry.candidate.id;
    const promoted=await rpc("create_brand_from_project_name",[project,candidateId,1,"Copied brand",false,"fixture-account-copy-001"]) as {project:{id:string};currentSelection:{candidate:unknown}};
    const copy=projectNameCandidateSchema.parse(normalize(promoted.currentSelection.candidate));expect(copy.projectId).toBe(promoted.project.id);expect(copy.origin).toMatchObject({kind:"account_copy",authorship:"user_supplied",sourceProjectId:project,sourceCandidateId:candidateId});
    expect((await rpc("create_brand_from_project_name",[project,candidateId,1,"Copied brand",false,"fixture-account-copy-001"]) as {project:{id:string}}).project.id).toBe(promoted.project.id);
    await expect(rpc("create_brand_from_project_name",[project,candidateId,1,"No access",false,"fixture-foreign-copy-001"],OWNER_B)).rejects.toMatchObject({code:"P0002"});
  });
  it("requires explicit stale promotion acknowledgement and binds exact replay to it",async()=>{
    const imported=await importName();const candidateId=imported.entry.candidate.id;
    await rpc("set_name_retention",[project,candidateId,0,true,false]);
    const changed={...context,description:"Changed current source strategy"};
    await rpc("append_project_revision",[project,1,JSON.stringify(changed),HASH]);
    expect(await rpc("get_account_names")).toMatchObject({items:[{earlierContext:true}]});
    await expect(rpc("create_brand_from_project_name",[project,candidateId,2,"Acknowledged brand",false,"fixture-stale-promotion01"])).rejects.toMatchObject({code:"PT409",message:"earlier_context_requires_acknowledgment"});
    expect((await db.query("select id from public.projects")).rows).toHaveLength(1);
    const promoted=await rpc("create_brand_from_project_name",[project,candidateId,2,"Acknowledged brand",true,"fixture-stale-promotion01"]) as {project:{id:string;context:typeof context};currentSelection:{selection:{acceptedEarlierContext:boolean};candidate:{strategyBasis:{description:string}}}};
    expect(promoted.project.context.description).toBe(changed.description);expect(promoted.currentSelection.candidate.strategyBasis.description).toBe(context.description);expect(promoted.currentSelection.selection.acceptedEarlierContext).toBe(true);
    expect(await rpc("create_brand_from_project_name",[project,candidateId,2,"Acknowledged brand",true,"fixture-stale-promotion01"])).toEqual(promoted);
    await expect(rpc("create_brand_from_project_name",[project,candidateId,2,"Acknowledged brand",false,"fixture-stale-promotion01"])).rejects.toMatchObject({code:"PT409"});
    await expect(rpc("create_brand_from_project_name",[project,candidateId,1,"Outdated revision",true,"fixture-stale-source001"])).rejects.toMatchObject({code:"PT409"});
  });

  it("contains a worker history collision against the exact admission snapshot",async()=>{
    await importName("Cedar");await save();const enqueued=await enqueue();const job=await begin();await complete(job,output(enqueued.batch));
    const detail=namingBatchDetailResponseSchema.parse(normalize(await rpc("get_naming_batch",[project,enqueued.batch.id])));
    expect(detail.result!.fulfillment).toMatchObject({acceptedCount:1,rejections:{duplicate_history:1}});expect(detail.job.results[0]!.output.accepted.map(row=>row.value)).toEqual(["Elm"]);
  });

});
