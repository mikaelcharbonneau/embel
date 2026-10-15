import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStandaloneNamesDatabase } from "./standalone-ai-names-fixture";
import { asRole, asSubscriptionWorker, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { standaloneNamesJobResponseSchema, standaloneNamesOverviewSchema, standaloneNamesWorkerInputSchema } from "../../src/domain/standalone-names";
import { brief, intent, policy, resultFixture } from "../fixtures/standalone-names";

describe("standalone AI Names SQL candidate (disposable local fixture)", () => {
  let db: TestDatabase, identity: string;
  beforeAll(async () => {
    db = await createStandaloneNamesDatabase();
  }, 90000);
  afterAll(async () => { await db?.close(); });
  const rpc = async (name: string, args: unknown[] = [], owner = OWNER_A) => asRole(db, "authenticated", owner, async () =>
    (await db.query<{ value: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value);
  async function worker<T>(run: () => Promise<T>, owner = OWNER_A) {
    const role = owner === OWNER_A ? "fixture_subscription_worker_a" : "fixture_subscription_worker_b";
    // These are grants in this disposable synthetic fixture, never live setup.
    await db.exec(`grant execute on function public.report_standalone_names_ready(jsonb),public.claim_standalone_names(jsonb),public.pulse_standalone_names(uuid,uuid,boolean,text),public.finish_standalone_names(uuid,uuid,text,jsonb,text,text) to ${role}`);
    return asSubscriptionWorker(db, owner, run);
  }
  async function activate(selected = policy) {
    await worker(() => db.query("select public.configure_subscription_runtime($1,'naming.generate',$2::jsonb,true)", [OWNER_A, JSON.stringify(selected)]));
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,'naming.generate',$3::jsonb,90)", [OWNER_A, selected.registrationId, JSON.stringify(selected)]));
    await db.query("insert into fluid_private.standalone_names_runtime(owner_id,enabled) values($1,true) on conflict(owner_id) do update set enabled=true", [OWNER_A]);
    await worker(() => db.query("select public.report_standalone_names_ready($1::jsonb)", [JSON.stringify(selected)]));
    return (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') identity", [JSON.stringify(selected)])).rows[0]!.identity;
  }
  beforeEach(async () => { await resetFixture(db); identity = await activate(); });
  const enqueue = async (key = intent.idempotencyKey, patch = {}) => standaloneNamesJobResponseSchema.parse(await rpc("enqueue_standalone_names", [JSON.stringify({ ...intent, acceptedPolicyIdentity: identity, idempotencyKey: key, ...patch })]));
  async function claim() {
    const row = await worker(async () => (await db.query<{ input: unknown }>("select public.claim_standalone_names($1::jsonb) input", [JSON.stringify(policy)])).rows[0]!.input);
    return standaloneNamesWorkerInputSchema.parse(row);
  }
  async function complete() {
    const enqueued = await enqueue(); const input = await claim();
    await worker(() => db.query("select public.pulse_standalone_names($1,$2,true,null)", [input.job.id, input.leaseToken]));
    await worker(() => db.query("select public.finish_standalone_names($1,$2,'succeeded',$3::jsonb,'',null)", [input.job.id, input.leaseToken, JSON.stringify(resultFixture())]));
    return { enqueued, input };
  }

  it("keeps disabled setup unavailable and admits no hidden project", async () => {
    await db.exec("update fluid_private.standalone_names_runtime set enabled=false");
    expect(await rpc("get_standalone_names")).toMatchObject({ availability: { status: "unavailable", reason: "setup_required" }, jobs: [] });
    await expect(enqueue()).rejects.toMatchObject({ code: "P0001" });
    expect((await db.query("select count(*)::integer n from public.projects")).rows).toEqual([{ n: 0 }]);
  });
  it("derives the owner, persists exact retry, denies altered retry and does not consume a second allowance", async () => {
    const first = await enqueue(); const again = await enqueue(); expect(again.job.id).toBe(first.job.id);
    await expect(enqueue(intent.idempotencyKey, { brief: { ...brief, direction: "Changed" } })).rejects.toMatchObject({ code: "PT409" });
    await rpc("cancel_standalone_names", [first.job.id]); expect((await enqueue()).job.state).toBe("cancelled");
    expect((await db.query("select count(*)::integer n from public.standalone_name_jobs")).rows).toEqual([{ n: 1 }]);
    expect((await db.query("select count(*)::integer n from public.projects")).rows).toEqual([{ n: 0 }]);
    await expect(rpc("enqueue_standalone_names", [JSON.stringify({ ...intent, ownerId: OWNER_A, acceptedPolicyIdentity: identity })])).rejects.toMatchObject({ code: "22023" });
  });
  it("enforces owner isolation at read, cancel, retention and worker lease boundaries", async () => {
    const { job } = await enqueue(); const input = await claim();
    expect(await rpc("get_standalone_names", [], OWNER_B)).toMatchObject({ jobs: [] });
    for (const [name, args] of [["get_standalone_name_job", [job.id]], ["cancel_standalone_names", [job.id]], ["retain_standalone_name", [job.id, 0, true, true]]] as const) await expect(rpc(name, [...args], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(worker(() => db.query("select public.pulse_standalone_names($1,$2,false,null)", [job.id, input.leaseToken]), OWNER_B)).rejects.toMatchObject({ code: "PT409" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select * from public.standalone_name_jobs"))).rejects.toMatchObject({ code: "42501" });
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("select public.claim_standalone_names($1)", [policy]))).rejects.toMatchObject({ code: "42501" });
  });
  it("publishes immutable provider output and keeps shortlist/save independent", async () => {
    const { enqueued } = await complete();
    const saved = standaloneNamesJobResponseSchema.parse(await rpc("retain_standalone_name", [enqueued.job.id, 0, true, false]));
    expect(saved.job.likedIndexes).toEqual([0]); expect(saved.job.savedIndexes).toEqual([]);
    expect(await rpc("retain_standalone_name", [enqueued.job.id, 0, true, false])).toEqual(saved);
    await expect(rpc("retain_standalone_name", [enqueued.job.id, 19, true, false])).rejects.toMatchObject({ code: "22023" });
    await expect(db.query("update public.standalone_name_jobs set result='{}' where id=$1", [enqueued.job.id])).rejects.toMatchObject({ code: "55000" });
    const overview = standaloneNamesOverviewSchema.parse(await rpc("get_standalone_names"));
    expect(overview.jobs[0]?.result?.candidates).toHaveLength(1); expect(overview.jobs[0]).not.toHaveProperty("leaseToken"); expect(overview.jobs[0]).not.toHaveProperty("partialText");
  });
  it("resolves refinement names from an owned result and bounds depth/choices", async () => {
    const { enqueued } = await complete();
    const refinement = { sourceJobId: enqueued.job.id, candidateIndexes: [0], instruction: "Make it shorter" };
    const next = await enqueue("fixture-refine-00001", { refinement });
    expect(next.job).toMatchObject({ depth: 1, refinement: { ...refinement, sourceNames: ["Fixture Clay"] } });
    await rpc("cancel_standalone_names", [next.job.id]);
    await expect(enqueue("fixture-refine-00002", { refinement: { ...refinement, candidateIndexes: [1] } })).rejects.toMatchObject({ code: "22023" });
    await expect(enqueue("fixture-refine-00003", { brief: { ...brief, description: "A different brief" }, refinement })).rejects.toMatchObject({ code: "PT409" });
    await expect(rpc("enqueue_standalone_names", [JSON.stringify({ ...intent, refinement, acceptedPolicyIdentity: identity })], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });
  it("fences cancelled, expired and duplicate dispatch before any retry", async () => {
    const { job } = await enqueue(); const input = await claim();
    await worker(() => db.query("select public.pulse_standalone_names($1,$2,true,'partial')", [job.id, input.leaseToken]));
    await expect(worker(() => db.query("select public.pulse_standalone_names($1,$2,true,null)", [job.id, input.leaseToken]))).rejects.toMatchObject({ code: "PT409" });
    await rpc("cancel_standalone_names", [job.id]);
    await worker(() => db.query("select public.finish_standalone_names($1,$2,'succeeded',$3::jsonb,'partial text',null)", [job.id, input.leaseToken, JSON.stringify(resultFixture())]));
    expect(await rpc("get_standalone_name_job", [job.id])).toMatchObject({ job: { state: "needs_reconciliation", result: null } });
    expect((await db.query("select partial_text from public.standalone_name_jobs where id=$1", [job.id])).rows[0]).toEqual({ partial_text: "partial text" });
    await enqueue("fixture-new-lease-0001"); const next = await claim();
    await worker(() => db.query("select public.pulse_standalone_names($1,$2,true,null)", [next.job.id, next.leaseToken]));
    await db.query("update public.standalone_name_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [next.job.id]);
    await db.exec("update fluid_private.standalone_names_runtime set enabled=false,worker_ready_until=null");
    await worker(() => db.query("select public.claim_standalone_names(null::jsonb)"));
    expect(await rpc("get_standalone_name_job", [next.job.id])).toMatchObject({ job: { state: "needs_reconciliation", errorCode: "lease_expired" } });
    await expect(worker(() => db.query("select public.finish_standalone_names($1,$2,'succeeded',$3::jsonb,'',null)", [next.job.id, next.leaseToken, JSON.stringify(resultFixture())]))).rejects.toMatchObject({ code: "PT409" });
  });
  it("does not claim or cancel queued work during disconnected lease maintenance", async () => {
    const { job } = await enqueue();
    await db.exec("update fluid_private.standalone_names_runtime set enabled=false,worker_ready_until=null");
    expect((await worker(() => db.query("select public.claim_standalone_names(null::jsonb) input"))).rows).toEqual([{ input: null }]);
    expect(await rpc("get_standalone_name_job", [job.id])).toMatchObject({ job: { state: "queued", finishedAt: null } });
  });
  it("shares hourly admission and pending limits with later project jobs", async () => {
    identity = await activate({ ...policy, limits: { ...policy.limits, maxRequestsPerHour: 1, maxQueuedJobs: 1 } });
    const first = await enqueue(); await rpc("cancel_standalone_names", [first.job.id]);
    await expect(enqueue("fixture-over-quota-0001")).rejects.toMatchObject({ code: "P0001" });
    const project = await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ id: string }>("select * from public.create_project('naming_only','Fixture',$1::jsonb,$2)", [{ description: "Fixture" }, "a".repeat(64)])).rows[0]!.id);
    const bounded = { ...policy, limits: { ...policy.limits, maxRequestsPerHour: 1, maxQueuedJobs: 1 } };
    // Exercise the actual public.jobs trigger, which runs after the existing
    // owner advisory lock in production project enqueue functions.
    await expect(db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,policy_identity) values($1,$2,'naming.generate',1,$3,$4::jsonb,'fixture-project-after',0,1,'chatgpt_subscription',$5)",
      [OWNER_A, project, "a".repeat(64), JSON.stringify({ billingMode: "chatgpt_subscription", policy: bounded }), identity])).rejects.toMatchObject({ code: "P0001" });
    expect((await db.query("select count(*)::integer n from public.jobs")).rows).toEqual([{ n: 0 }]);
  });
});
