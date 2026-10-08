import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { nameIdentityKey, namingStrategyBasisSchema, namingStrategyKeyFromBasis, projectNameCandidateSchema } from "../../src/domain/project-naming";
import { getNamingFulfillment } from "../../src/domain/naming-jobs";
import { asRole, asSubscriptionWorker, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "../database/local-supabase";

// Independent local PGlite fixtures. No live logins, grants, credentials or calls.
const context = contextSnapshotSchema.parse({ description: "Synthetic independent naming review" });
const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };
const policy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId: "qa-naming-registration-a", model: "qa-explicit-model",
  limits: { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 0, maxRequestsPerHour: 20, maxQueuedJobs: 3 } };
const rejections = { invalid_candidate: 0, empty_identity: 0, below_minimum: 0, above_maximum: 0, duplicate_response: 0, duplicate_history: 0, over_target: 0 };
const at = "2026-10-04T12:00:00Z";
type Batch = { id: string; sequence: number; targetCount: 100 | 250 | 50; acceptedPolicyIdentity: string };
type Admission = { batch: Batch; job: { id: string } };
type Lease = { id: string; lease_token: string };
type Entry = { candidate: { id: string; value: string; origin: Record<string, unknown>; strategyBasis: unknown } };
type CandidateRow = { id: string; value: string; identity_key: string; batch_id: string | null; origin: Record<string, unknown> };

function candidateDTO(raw: Entry["candidate"]) {
  return { ...raw, strategyKey: namingStrategyKeyFromBasis(namingStrategyBasisSchema.parse(raw.strategyBasis)) };
}

describe("independent Project Naming database adversarial boundaries", () => {
  let db: TestDatabase; let projectA: string; let projectB: string; let identity: string; let serial = 0;
  const key = () => `qa-naming-intent-${String(++serial).padStart(6, "0")}`;
  const auth = <T>(run: () => Promise<T>, owner: string | null = OWNER_A) => asRole(db, "authenticated", owner, run);
  const worker = <T>(run: () => Promise<T>, owner = OWNER_A) => asSubscriptionWorker(db, owner, run);
  async function rpc<T = unknown>(name: string, args: unknown[] = [], owner: string | null = OWNER_A): Promise<T> {
    return auth(async () => (await db.query<{ result: T }>(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) result`, args)).rows[0]!.result, owner);
  }
  async function create(scope = "naming_only", owner = OWNER_A, value = context) {
    return auth(async () => (await db.query<{ id: string }>("select * from public.create_project($1,'Independent fixture',$2::jsonb,$3)", [scope, JSON.stringify(value), HASH])).rows[0]!.id, owner);
  }
  async function configure(value = policy, operation = "naming.generate", owner = OWNER_A) {
    await worker(() => db.query("select public.configure_subscription_runtime($1,$2,$3::jsonb,true)", [owner, operation, JSON.stringify(value)]), owner);
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,90)", [owner, value.registrationId, operation, JSON.stringify(value)]), owner);
    return (await db.query<{ value: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value", [JSON.stringify(value)])).rows[0]!.value;
  }
  const save = (project = projectA, owner = OWNER_A) => rpc("save_naming_preferences", [project, 0, JSON.stringify(preferences)], owner);
  const admit = (project = projectA, sequence = 0, intent = key(), accepted = identity) => rpc<Admission>("enqueue_subscription_naming_job", [project, 1, 1, sequence, intent, accepted]);
  async function begin() {
    const job = await worker(async () => (await db.query<Lease>("select * from public.claim_subscription_job('qa-naming-worker',$1,$2,90)", [OWNER_A, policy.registrationId])).rows[0]!);
    expect(job).toBeDefined();
    await worker(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify([{ key: "qa-names", maximumCostMicrousd: 0 }])]));
    await worker(() => db.query("select public.begin_job_step($1,$2,'qa-names','qa-naming-request',0)", [job.id, job.lease_token]));
    return job;
  }
  function output(batch: Batch, names = ["Cedar", "Willow"]) {
    return { version: 1, operation: "naming.generate", provider: "openai", billingMode: "chatgpt_subscription", model: policy.model,
      responseId: "resp_qa_naming", requestId: "req_qa_naming", generatedAt: at, usage: null, batchId: batch.id, sequence: batch.sequence, targetCount: batch.targetCount,
      accepted: names.map(value => ({ value, identityKey: nameIdentityKey(value), rationale: "Synthetic review candidate." })), fulfillment: getNamingFulfillment(batch.targetCount, names.length, rejections) };
  }
  const complete = (job: Lease, result: unknown, owner = OWNER_A, cost = 0) => worker(() => db.query("select public.complete_naming_job_step($1,$2,'qa-names','succeeded',$3,$4::jsonb,'resp_qa_naming')", [job.id, job.lease_token, cost, JSON.stringify(result)]), owner);
  const importName = (value = "Cedar", target = projectA, owner = OWNER_A) => rpc<{ entry: Entry }>("import_local_name", [target, 1,
    JSON.stringify({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", value, createdAt: at, origin: "manual", history: [] }), JSON.stringify(context), nameIdentityKey(value), key()], owner);
  const candidateRows = () => db.query<CandidateRow>("select id,value,identity_key,batch_id,origin from public.name_candidates order by value");
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    serial = 0; await resetFixture(db); projectA = await create(); projectB = await create("naming_only", OWNER_B);
    identity = await configure(); await configure({ ...policy, registrationId: "qa-naming-registration-b" }, "naming.generate", OWNER_B);
    await save(); await save(projectB, OWNER_B);
  });

  it("publishes exactly 250 immutable candidates and keeps a zero-result batch honest", async () => {
    const first = await admit(); const job = await begin();
    await complete(job, output(first.batch, Array.from({ length: 250 }, (_, i) => `Fixture ${i}`)));
    await worker(() => db.query("select public.finish_job($1,$2,'succeeded')", [job.id, job.lease_token]));
    expect((await candidateRows()).rows).toHaveLength(250);
    const second = await admit(projectA, 1); const next = await begin(); await complete(next, output(second.batch, []));
    const rows = await db.query<{ result: { fulfillment: { status: string; acceptedCount: number; targetCount: number } } }>("select result from public.naming_batch_results order by completed_at");
    expect(rows.rows.map(row => row.result.fulfillment)).toMatchObject([{ status: "complete", acceptedCount: 250, targetCount: 250 }, { status: "none", acceptedCount: 0, targetCount: 50 }]);
    expect((await candidateRows()).rows).toHaveLength(250);
  });

  it.each(["foreign_owner", "wrong_lease", "expired_lease", "cancelled", "policy_changed", "model", "billing", "batch", "cost"])("fences %s at the actual completion transaction", async mode => {
    const admitted = await admit(); const job = await begin(); const result = output(admitted.batch);
    let owner = OWNER_A; let cost = 0;
    if (mode === "foreign_owner") owner = OWNER_B;
    if (mode === "wrong_lease") job.lease_token = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    if (mode === "expired_lease") await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    if (mode === "cancelled") await rpc("request_job_cancel", [job.id]);
    if (mode === "policy_changed") await configure({ ...policy, model: "newly-selected-model" });
    if (mode === "model") result.model = "substituted-model";
    if (mode === "billing") result.billingMode = "openai_api";
    if (mode === "batch") result.batchId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    if (mode === "cost") cost = 1;
    await expect(complete(job, result, owner, cost)).rejects.toThrow();
    expect((await candidateRows()).rows).toEqual([]);
    expect((await db.query("select * from public.naming_batch_results")).rows).toEqual([]);
    expect((await db.query("select state from public.job_steps")).rows).toEqual([{ state: "in_flight" }]);
  });

  it("rejects altered cost on an otherwise identical successful replay", async () => {
    const admitted = await admit(); const job = await begin(); const result = output(admitted.batch);
    await complete(job, result);
    await expect(complete(job, result, OWNER_A, 1)).rejects.toThrow();
    expect((await candidateRows()).rows).toHaveLength(2);
  });

  it.each(["string_sequence", "usage_totals", "unknown_output", "unknown_candidate", "negative_rejections", "wrong_fulfillment", "empty_caution", "duplicate_response"])("rejects malformed completion %s without publishing any rows", async mode => {
    const admitted = await admit(); const job = await begin(); const result = output(admitted.batch);
    let raw: unknown = result;
    if (mode === "string_sequence") raw = { ...result, sequence: "1" };
    if (mode === "usage_totals") raw = { ...result, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 8 } };
    if (mode === "unknown_output") raw = { ...result, ownerId: OWNER_B };
    if (mode === "unknown_candidate") raw = { ...result, accepted: [{ ...result.accepted[0], provider: "invented" }, result.accepted[1]] };
    if (mode === "negative_rejections") raw = { ...result, fulfillment: { ...result.fulfillment, rejections: { ...rejections, duplicate_history: -1 } } };
    if (mode === "wrong_fulfillment") raw = { ...result, fulfillment: { ...result.fulfillment, acceptedCount: 99 } };
    if (mode === "empty_caution") raw = { ...result, accepted: [{ ...result.accepted[0], caution: "" }, result.accepted[1]] };
    if (mode === "duplicate_response") raw = { ...result, accepted: [result.accepted[0], result.accepted[0]] };
    await expect(complete(job, raw)).rejects.toThrow();
    expect((await candidateRows()).rows).toEqual([]);
    expect((await db.query("select * from public.naming_batch_results")).rows).toEqual([]);
  });

  it("rejects browser/service-role publication and worker impersonation despite forged JWT claims", async () => {
    const admitted = await admit(); const job = await begin(); const result = JSON.stringify(output(admitted.batch));
    for (const role of ["authenticated", "anon", "service_role"] as const) await expect(asRole(db, role, OWNER_A, () => db.query("select public.complete_naming_job_step($1,$2,'qa-names','succeeded',0,$3::jsonb,'resp_qa_naming')", [job.id, job.lease_token, result]))).rejects.toMatchObject({ code: "42501" });
    await worker(async () => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_A]);
      try { await expect(db.query("select public.complete_naming_job_step($1,$2,'qa-names','succeeded',0,$3::jsonb,'resp_qa_naming')", [job.id, job.lease_token, result])).rejects.toMatchObject({ code: "42501" }); }
      finally { await db.query("select set_config('request.jwt.claim.sub','',false)"); }
    }, OWNER_B);
    expect((await candidateRows()).rows).toEqual([]);
  });

  it("retains names imported after admission as separate captures and replays generation once", async () => {
    const admitted = await admit(); const job = await begin(); const result = output(admitted.batch);
    const imported = await importName("CED-AR"); await complete(job, result); await complete(job, result);
    const rows = await candidateRows(); expect(rows.rows).toHaveLength(3);
    expect(rows.rows.find(row => row.id === imported.entry.candidate.id)).toMatchObject({ value: "CED-AR", identity_key: "cedar", batch_id: null });
    const step = (await db.query<{ output: { accepted: unknown[]; fulfillment: { acceptedCount: number; rejections: unknown } } }>("select output from public.job_steps where job_id=$1", [job.id])).rows[0]!.output;
    expect(step.accepted).toMatchObject([{ value: "Cedar" }, { value: "Willow" }]);
    expect(step.fulfillment).toMatchObject({ acceptedCount: 2, rejections: { duplicate_history: 0 } });
    expect((await db.query("select * from public.naming_batch_results")).rows).toHaveLength(1);
  });

  it("does not let a post-admission poisoned key remove a valid generated name or falsify counts", async () => {
    const admitted = await admit(); const job = await begin();
    await rpc("import_local_name", [projectA, 1, JSON.stringify({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", value: "Cedar", createdAt: at, origin: "manual", history: [] }), JSON.stringify(context), "elm", key()]);
    const result = output(admitted.batch, ["Cedar", "Elm"]);
    await complete(job, result); await complete(job, result);
    const step = (await db.query<{ output: ReturnType<typeof output> }>("select output from public.job_steps where job_id=$1", [job.id])).rows[0]!.output;
    expect(step.accepted.map(row => row.value)).toEqual(["Cedar", "Elm"]);
    expect(step.fulfillment).toMatchObject({ acceptedCount: 2, rejections: { duplicate_history: 0 } });
    const overview = await rpc<{ candidates: { items: Entry[] } }>("get_project_naming", [projectA, "{}"]);
    const candidates = overview.candidates.items.map(row => candidateDTO(row.candidate));
    const generated = candidates.filter(row => row.origin.kind === "generated");
    expect(generated.map(row => row.value).sort()).toEqual(["Cedar", "Elm"]);
    for (const row of generated) {
      expect(row.origin).toMatchObject({ provider: "openai", model: policy.model, responseId: "resp_qa_naming", jobId: job.id, batchId: admitted.batch.id });
      expect(projectNameCandidateSchema.safeParse(row).success).toBe(true);
    }
    // The malformed manual capture stays unverified and cannot acquire generated provenance.
    const imported = candidates.filter(row => row.origin.kind === "local_import");
    expect(imported).toHaveLength(1);
    expect(projectNameCandidateSchema.safeParse(imported[0]).success).toBe(false);
    expect((await db.query("select * from public.naming_batch_results")).rows).toHaveLength(1);
  });

  it("still removes a canonical collision that belongs to the immutable admission history", async () => {
    await importName("CED-AR"); const admitted = await admit(); const job = await begin();
    const result = output(admitted.batch); await complete(job, result); await complete(job, result);
    const step = (await db.query<{ output: ReturnType<typeof output> }>("select output from public.job_steps where job_id=$1", [job.id])).rows[0]!.output;
    expect(step.accepted.map(row => row.value)).toEqual(["Willow"]);
    expect(step.fulfillment).toMatchObject({ acceptedCount: 1, rejections: { duplicate_history: 1 } });
    expect((await candidateRows()).rows).toHaveLength(2);
  });

  it("rolls back prior candidate inserts, completion and batch result when a later candidate is invalid", async () => {
    const admitted = await admit(); const job = await begin(); const result = output(admitted.batch);
    result.accepted[1]!.rationale = "";
    await expect(complete(job, result)).rejects.toThrow();
    expect((await candidateRows()).rows).toEqual([]);
    expect((await db.query("select * from public.naming_batch_results")).rows).toEqual([]);
    expect((await db.query("select state from public.job_steps")).rows).toEqual([{ state: "in_flight" }]);
  });

  it("denies direct row mutation and isolates every owned naming table", async () => {
    const imported = await importName(); await importName("Private B", projectB, OWNER_B);
    await rpc("set_name_retention", [projectA, imported.entry.candidate.id, 0, true, true]);
    await rpc("select_project_name", [projectA, imported.entry.candidate.id, 1, false]);
    for (const table of ["naming_sessions", "naming_preferences", "naming_batches", "naming_batch_results", "name_candidates", "name_transforms", "name_retention", "name_selections"]) {
      const rows = await auth(() => db.query<{ owner_id: string }>(`select owner_id from public.${table}`));
      expect(rows.rows.every(row => row.owner_id === OWNER_A)).toBe(true);
      await expect(auth(() => db.query(`delete from public.${table}`))).rejects.toMatchObject({ code: "42501" });
      await expect(worker(() => db.query(`select * from public.${table}`))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(db.query("update public.name_candidates set value='Changed' where id=$1", [imported.entry.candidate.id])).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("delete from public.name_selections")).rejects.toMatchObject({ code: "55000" });
    await expect(rpc("get_project_name", [projectB, imported.entry.candidate.id], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });

  it("filters populated batch, result, transform and selection histories for both real database principals", async () => {
    for (const [owner, project, registration] of [[OWNER_A, projectA, policy.registrationId], [OWNER_B, projectB, "qa-naming-registration-b"]] as const) {
      const available = await rpc<{ policyIdentity: string }>("get_naming_availability", [project], owner);
      const admitted = await rpc<Admission>("enqueue_subscription_naming_job", [project, 1, 1, 0, key(), available.policyIdentity], owner);
      const job = await worker(async () => (await db.query<Lease>("select * from public.claim_subscription_job('qa-two-owner-worker',$1,$2,90)", [owner, registration])).rows[0]!, owner);
      await worker(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify([{ key: "qa-names", maximumCostMicrousd: 0 }])]), owner);
      await worker(() => db.query("select public.begin_job_step($1,$2,'qa-names','qa-two-owner-request',0)", [job.id, job.lease_token]), owner);
      await complete(job, output(admitted.batch), owner);
      const parent = (await db.query<{ id: string }>("select id from public.name_candidates where owner_id=$1 and value='Cedar'", [owner])).rows[0]!.id;
      await rpc("persist_name_transform", [project, parent, null, JSON.stringify({ kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }),
        JSON.stringify({ candidates: [{ value: "CEDAR", identityKey: "cedar", explanation: "Applied Unicode uppercase mapping." }], truncated: false, notes: [] }), key()], owner);
      await rpc("set_name_retention", [project, parent, 0, true, false], owner);
      await rpc("select_project_name", [project, parent, 1, false], owner);
    }
    for (const owner of [OWNER_A, OWNER_B]) for (const table of ["naming_sessions", "naming_preferences", "naming_batches", "naming_batch_results", "name_candidates", "name_transforms", "name_retention", "name_selections"]) {
      const rows = await auth(() => db.query<{ owner_id: string }>(`select owner_id from public.${table}`), owner);
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every(row => row.owner_id === owner)).toBe(true);
    }
  });

  it("never elevates forged transform content or account copies to generated authorship", async () => {
    const admitted = await admit(); const job = await begin(); await complete(job, output(admitted.batch));
    const parent = (await candidateRows()).rows[0]!.id as string;
    const transform = await rpc<{ entries: Entry[] }>("persist_name_transform", [projectA, parent, null,
      JSON.stringify({ kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }), JSON.stringify({ candidates: [{ value: "Fabricated", identityKey: "fabricated", explanation: "False uppercase claim" }], truncated: false, notes: [] }), key()]);
    const forged = transform.entries[0]!.candidate;
    expect(forged.origin).toMatchObject({ kind: "transform", authorship: "user_supplied", root: { kind: "generated", candidateId: parent } });
    expect(projectNameCandidateSchema.safeParse(candidateDTO(forged)).success).toBe(false);
    const selected = await rpc<{ currentSelection: { candidate: Entry["candidate"] } }>("select_project_name", [projectA, forged.id, 1, false]);
    expect(selected.currentSelection.candidate.origin.authorship).toBe("user_supplied");
    const copy = await rpc<{ currentSelection: { candidate: Entry["candidate"] } }>("create_brand_from_project_name", [projectA, forged.id, 2, "Unverified fixture copy", false, key()]);
    expect(copy.currentSelection.candidate.origin).toMatchObject({ kind: "account_copy", authorship: "user_supplied", sourceProjectId: projectA, sourceCandidateId: forged.id });
    expect(projectNameCandidateSchema.safeParse(candidateDTO(copy.currentSelection.candidate)).success).toBe(false);
  });

  it("rejects forged generated imports and cross-project parents even for one owner", async () => {
    const imported = await importName(); const second = await create();
    await expect(rpc("import_local_name", [projectA, 1, JSON.stringify({ id: imported.entry.candidate.id, value: "Fake", createdAt: at, origin: "generated", history: [], provider: "openai" }), JSON.stringify(context), "fake", key()])).rejects.toThrow();
    await expect(rpc("persist_name_transform", [second, imported.entry.candidate.id, null, JSON.stringify({ kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }), JSON.stringify({ candidates: [], truncated: false, notes: [] }), key()])).rejects.toMatchObject({ code: "P0002" });
    await expect(rpc("create_brand_from_project_name", [projectA, imported.entry.candidate.id, 1, "Cross-owner copy", false, key()], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });

  it("includes a selection-only name in retained views without inventing a favorite", async () => {
    const imported = await importName(); await rpc("select_project_name", [projectA, imported.entry.candidate.id, 1, false]);
    const overview = await rpc<{ candidates: { items: Entry[] } }>("get_project_naming", [projectA, JSON.stringify({ filter: "retained" })]);
    expect(overview.candidates.items.map(row => row.candidate.id)).toEqual([imported.entry.candidate.id]);
    const account = await rpc<{ items: Entry[] }>("get_account_names", [JSON.stringify({ filter: "retained" })]);
    expect(account.items.map(row => row.candidate.id)).toEqual([imported.entry.candidate.id]);
    expect((await db.query("select * from public.name_retention")).rows).toEqual([]);
  });

  it.each(["visual_identity_only", "complete_brand", "empty_description"])("keeps %s unavailable at both availability and admission boundaries", async scope => {
    const project = await create(scope === "empty_description" ? "naming_only" : scope, OWNER_A, scope === "empty_description" ? contextSnapshotSchema.parse({}) : context);
    await save(project);
    expect(await rpc("get_naming_availability", [project])).toMatchObject({ status: "unavailable", reason: scope === "visual_identity_only" ? "scope_unavailable" : "strategy_incomplete" });
    await expect(admit(project)).rejects.toMatchObject({ code: "PT409" });
    expect((await db.query("select * from public.jobs")).rows).toEqual([]);
  });

  it("shares hourly quota across Strategy and Naming and replays an admitted intent through an outage", async () => {
    const bounded = { ...policy, limits: { ...policy.limits, maxRequestsPerHour: 2, maxQueuedJobs: 1 } };
    identity = await configure(bounded); const strategyIdentity = await configure({ ...bounded, handlerVersion: "strategy-chatgpt-v1" }, "strategy.reformulate");
    const strategy = await rpc<{ id: string }>("enqueue_subscription_strategy_job", [projectA, 1, "strategy.reformulate", key(), strategyIdentity]);
    await expect(admit()).rejects.toThrow(/quota_unavailable/); await rpc("request_job_cancel", [strategy.id]);
    const intent = key(); const admitted = await admit(projectA, 0, intent);
    await worker(() => db.query("select public.disable_subscription_runtime($1,$2)", [OWNER_A, policy.registrationId]));
    expect((await admit(projectA, 0, intent)).batch.id).toBe(admitted.batch.id);
    await expect(rpc("enqueue_subscription_naming_job", [projectA, 1, 2, 0, intent, identity])).rejects.toMatchObject({ code: "PT409" });
    await configure(bounded); await expect(admit(projectA, 1)).rejects.toThrow(/quota_unavailable/);
    expect((await db.query("select id from public.jobs")).rows).toHaveLength(2);
  });

  it("rolls back a mixed-model runtime bundle and keeps strategy availability operation-specific", async () => {
    const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality", "strategy.positioning", "naming.generate"];
    const entries = operations.map(operation => ({ operation, policy: { ...policy, handlerVersion: operation === "naming.generate" ? "naming-chatgpt-v1" : "strategy-chatgpt-v1" } }));
    const mixed = structuredClone(entries); mixed[5]!.policy.model = "substituted-model";
    await expect(worker(() => db.query("select public.configure_subscription_runtime($1,$2::jsonb)", [OWNER_A, JSON.stringify(mixed)]))).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select operation from fluid_private.subscription_runtime_policy where owner_id=$1", [OWNER_A])).rows).toEqual([{ operation: "naming.generate" }]);
    await worker(() => db.query("select public.configure_subscription_runtime($1,$2::jsonb)", [OWNER_A, JSON.stringify(entries)]));
    for (const entry of entries) await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,90)", [OWNER_A, policy.registrationId, entry.operation, JSON.stringify(entry.policy)]));
    const strategy = await rpc<{ operations: Array<{ operation: string }> }>("get_strategy_availability", [projectA]);
    expect(strategy.operations.map(item => item.operation).sort()).toEqual(operations.filter(item => item.startsWith("strategy.")).sort());
    await expect(auth(() => db.query("select public.configure_subscription_runtime($1,$2::jsonb)", [OWNER_A, JSON.stringify(entries)]))).rejects.toMatchObject({ code: "42501" });
  });
});
