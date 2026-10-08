import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, asSubscriptionWorker, HASH, OWNER_A, OWNER_B, resetFixture } from "./local-supabase";
import { applyNaming250Migration, createNaming250Database } from "./naming-250-fixture";

// All identities, requests, names and outputs below are local fixtures.
const context = { description: "Explicit local Naming 250 fixture" };
const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };
const policy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId: "fixture-250-registration", model: "fixture-model", limits: { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 0, maxRequestsPerHour: 20, maxQueuedJobs: 3 } };
type Batch = { id: string; targetCount: number; sequence: number; jobId: string };
type Admission = { batch: Batch; job: { id: string } };
type Lease = { id: string; lease_token: string };
const zero = { invalid_candidate: 0, empty_identity: 0, below_minimum: 0, above_maximum: 0, duplicate_response: 0, duplicate_history: 0, over_target: 0 };

describe("Naming 250 forward migration (Naming-only local database)", () => {
  let db: Awaited<ReturnType<typeof createNaming250Database>>;
  let project: string; let identity: string;
  beforeAll(async () => { db = await createNaming250Database(false); }, 30_000);
  afterAll(async () => { await db?.close(); });
  const owner = <T>(fn: () => Promise<T>, uid = OWNER_A) => asRole(db, "authenticated", uid, fn);
  const worker = <T>(fn: () => Promise<T>) => asSubscriptionWorker(db, OWNER_A, fn);
  async function rpc<T>(name: string, args: unknown[], uid = OWNER_A): Promise<T> {
    return owner(async () => (await db.query<{ value: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0]!.value, uid);
  }
  async function create() {
    const row = await owner(() => db.query<{ id: string }>("select * from public.create_project('naming_only','Naming 250 fixture',$1::jsonb,$2)", [JSON.stringify(context), HASH]));
    await rpc("save_naming_preferences", [row.rows[0]!.id, 0, JSON.stringify(preferences)]);
    return row.rows[0]!.id;
  }
  async function admit(target = project, sequence = 0, key = `fixture-250-admission-${sequence}`) {
    return rpc<Admission>("enqueue_subscription_naming_job", [target, 1, 1, sequence, key, identity]);
  }
  async function publish(admission: Admission, count = admission.batch.targetCount, prefix = "Fixture") {
    const lease = await worker(async () => (await db.query<Lease>("select * from public.claim_subscription_job('fixture-250-worker',$1,$2,90)", [OWNER_A, policy.registrationId])).rows[0]!);
    expect(lease.id).toBe(admission.job.id);
    await worker(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [lease.id, lease.lease_token, JSON.stringify([{ key: "names", maximumCostMicrousd: 0 }])]));
    await worker(() => db.query("select public.begin_job_step($1,$2,'names','fixture-250-request',0)", [lease.id, lease.lease_token]));
    const output = { version: 1, operation: "naming.generate", provider: "openai", billingMode: "chatgpt_subscription", model: policy.model, responseId: "resp_fixture_250", requestId: null, generatedAt: "2026-10-05T04:12:33Z", usage: null, batchId: admission.batch.id, sequence: admission.batch.sequence, targetCount: admission.batch.targetCount,
      accepted: Array.from({ length: count }, (_, i) => ({ value: `${prefix}${i}`, identityKey: `${prefix}${i}`.toLowerCase(), rationale: `Explicit local explanation for ${prefix}${i}.` })),
      fulfillment: { status: count === admission.batch.targetCount ? "complete" : count === 0 ? "none" : "partial", targetCount: admission.batch.targetCount, acceptedCount: count, rejections: zero, message: count === admission.batch.targetCount ? null : "Explicit local shortfall." } };
    await worker(() => db.query("select public.complete_naming_job_step($1,$2,'names','succeeded',0,$3::jsonb,'resp_fixture_250')", [lease.id, lease.lease_token, JSON.stringify(output)]));
    await worker(() => db.query("select public.finish_job($1,$2,'succeeded')", [lease.id, lease.lease_token]));
    return { lease, output };
  }
  beforeEach(async () => {
    await resetFixture(db);
    await worker(() => db.query("select public.configure_subscription_runtime($1,'naming.generate',$2::jsonb,true)", [OWNER_A, JSON.stringify(policy)]));
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,'naming.generate',$3::jsonb,90)", [OWNER_A, policy.registrationId, JSON.stringify(policy)]));
    identity = (await db.query<{ value: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value", [JSON.stringify(policy)])).rows[0]!.value;
    project = await create();
  });

  it("admits and atomically persists 250 unique explained names without changing grants or Strategy", async () => {
    const before = await db.query<{ oid: number; proacl: string[] | null; prosrc: string }>("select oid,proacl,prosrc from pg_proc where oid in ('public.enqueue_subscription_naming_job(uuid,integer,integer,integer,text,text)'::regprocedure,'public.complete_naming_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure,'fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure) order by oid");
    await applyNaming250Migration(db);
    const admission = await admit(); expect(admission.batch.targetCount).toBe(250);
    await publish(admission);
    const rows = await db.query<{ total: number; identities: number; explained: number }>("select count(*)::int total,count(distinct identity_key)::int identities,count(*) filter(where length(btrim(rationale))>0)::int explained from public.name_candidates where batch_id=$1", [admission.batch.id]);
    expect(rows.rows[0]).toEqual({ total: 250, identities: 250, explained: 250 });
    const detail = await rpc<{ result: { candidateIds: string[]; fulfillment: { status: string } } }>("get_naming_batch", [project, admission.batch.id]);
    expect(detail.result.candidateIds).toHaveLength(250); expect(detail.result.fulfillment.status).toBe("complete");
    expect((await owner(() => db.query("select id from public.name_candidates"), OWNER_B)).rows).toEqual([]);
    await expect(rpc("get_naming_batch", [project, admission.batch.id], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    const after = await db.query<{ oid: number; proacl: string[] | null; prosrc: string }>("select oid,proacl,prosrc from pg_proc where oid in ('public.enqueue_subscription_naming_job(uuid,integer,integer,integer,text,text)'::regprocedure,'public.complete_naming_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure,'fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure) order by oid");
    expect(after.rows.map(({ oid, proacl }) => ({ oid, proacl }))).toEqual(before.rows.map(({ oid, proacl }) => ({ oid, proacl })));
    expect(after.rows.filter(row => row.prosrc === before.rows.find(old => old.oid === row.oid)?.prosrc)).toHaveLength(2);
    const retry = await admit(project, 0, "fixture-250-replay-other-key"); expect(retry.batch.id).toBe(admission.batch.id);
    expect((await db.query("select max_attempts,attempts from public.jobs where id=$1", [admission.job.id])).rows).toEqual([{ max_attempts: 1, attempts: 1 }]);
  });

  it("preserves the original 250 candidates and appends 50 with full admission exclusions", async () => {
    await applyNaming250Migration(db);
    const initial = await admit(); await publish(initial, 250, "Original");
    const before = await db.query("select id,value,identity_key,rationale,origin from public.name_candidates where batch_id=$1 order by id", [initial.batch.id]);
    const second = await admit(project, 1); expect(second.batch.targetCount).toBe(50);
    const frozen = (await db.query<{ input: { exclusionSnapshot: unknown[]; exclusionKeys: string[] } }>("select input from public.jobs where id=$1", [second.job.id])).rows[0]!.input;
    expect(frozen.exclusionSnapshot).toHaveLength(250); expect(frozen.exclusionKeys).toHaveLength(250);
    await publish(second, 50, "Appended");
    expect((await db.query("select id,value,identity_key,rationale,origin from public.name_candidates where batch_id=$1 order by id", [initial.batch.id])).rows).toEqual(before.rows);
    expect((await db.query("select count(*)::int total,count(distinct identity_key)::int identities from public.name_candidates where project_id=$1", [project])).rows).toEqual([{ total: 300, identities: 300 }]);
  });
});
