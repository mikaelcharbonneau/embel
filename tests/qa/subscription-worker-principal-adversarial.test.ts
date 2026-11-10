import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SUBSCRIPTION_LIMITS } from "../../src/domain/strategy-jobs";
import { asRole, asSubscriptionWorker, claim, createTestDatabase, enqueue, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

// Actual local PostgreSQL permission checks under two distinct session_user
// identities. These are synthetic LOGIN roles, not live Supabase connections.
// SET SESSION AUTHORIZATION emulates the authenticated database principal; it
// does not establish password authentication or multi-connection concurrency.
describe("independent subscription worker database-principal isolation", () => {
  let db: TestDatabase;
  const operation = "strategy.reformulate";
  const owners = [OWNER_A, OWNER_B] as const;
  const projects = new Map<string, string>();
  const identities = new Map<string, string>();
  type Job = { id: string; owner_id: string; lease_token: string };
  const registration = (owner: string) => `qa-principal-${owner}`;
  const policy = (owner: string) => ({ version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId: registration(owner), model: "qa-principal-model", limits: DEFAULT_SUBSCRIPTION_LIMITS });
  const worker = <T>(owner: string, run: () => Promise<T>) => asSubscriptionWorker(db, owner, run);

  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await resetFixture(db); projects.clear(); identities.clear();
    for (const owner of owners) {
      projects.set(owner, (await seedProject(db, owner)).id);
      identities.set(owner, (await db.query<{ hash: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as hash", [JSON.stringify(policy(owner))])).rows[0]!.hash);
      await worker(owner, async () => {
        await db.query("select public.configure_subscription_runtime($1,$2,$3::jsonb,true)", [owner, operation, JSON.stringify(policy(owner))]);
        await db.query("select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,60)", [owner, registration(owner), operation, JSON.stringify(policy(owner))]);
      });
    }
    // Attack-only extra EXECUTE: the runtime does not need progress. This proves
    // the shared function's intrinsic fence even if a generic grant is added.
    await db.exec("grant execute on function public.report_job_progress(uuid,uuid,integer) to fixture_subscription_worker_a,fixture_subscription_worker_b");
  });

  async function submit(owner: string) {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ job: { id: string } }>(
      "select public.enqueue_subscription_strategy_job($1,1,$2,$3,$4) as job",
      [projects.get(owner), operation, `qa-principal-job-${owner}`, identities.get(owner)],
    )).rows[0]!.job);
  }
  async function take(owner: string) {
    await submit(owner);
    return worker(owner, async () => (await db.query<Job>("select * from public.claim_subscription_job('qa-principal-worker',$1,$2,60)", [owner, registration(owner)])).rows[0]!);
  }
  async function begin(owner: string, job: Job) {
    await worker(owner, async () => {
      await db.query("select public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify([{ key: "respond", maximumCostMicrousd: 0 }])]);
      await db.query("select public.begin_job_step($1,$2,'respond','qa-principal-request',0)", [job.id, job.lease_token]);
    });
  }
  function leaseAttacks(job: Job) {
    return [
      ["select public.heartbeat_job($1,$2,60)", [job.id, job.lease_token]],
      ["select public.report_job_progress($1,$2,10)", [job.id, job.lease_token]],
      ["select public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify([{ key: "respond", maximumCostMicrousd: 0 }])]],
      ["select public.begin_job_step($1,$2,'respond','qa-principal-request',0)", [job.id, job.lease_token]],
      ["select public.complete_job_step($1,$2,'respond','failed',0)", [job.id, job.lease_token]],
      ["select public.finish_job($1,$2,'failed')", [job.id, job.lease_token]],
      ["select public.append_subscription_partial($1,$2,'foreign write')", [job.id, job.lease_token]],
    ] as const;
  }

  it("uses session_user instead of forged owner arguments or JWT claims for every configuration action", async () => {
    for (const [owner, foreign] of [[OWNER_A, OWNER_B], [OWNER_B, OWNER_A]] as const) {
      await worker(owner, async () => {
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [foreign]);
        const identity = (await db.query<{ login: string; current: string }>("select session_user as login,current_user as current")).rows[0]!;
        expect(identity.login).toBe(identity.current);
        expect(identity.login).not.toBe("postgres"); expect(identity.login).not.toBe("service_role");
        const bindings = (await db.query<{ owner_id: string; registration_id: string }>("select * from public.get_subscription_runtime_bindings()")).rows;
        expect(bindings.map(row => row.owner_id)).toEqual([owner]);
        expect(bindings[0]!.registration_id).toBe(registration(owner));
        const calls = [
          ["select public.configure_subscription_runtime($1,$2,$3::jsonb,true)", [foreign, operation, JSON.stringify(policy(foreign))]],
          ["select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,60)", [foreign, registration(foreign), operation, JSON.stringify(policy(foreign))]],
          ["select public.disable_subscription_runtime($1,$2)", [foreign, registration(foreign)]],
          ["select * from public.claim_subscription_job('qa-forged-owner',$1,$2,60)", [foreign, registration(foreign)]],
        ] as const;
        for (const [sql, args] of calls) await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: "42501" });
        await expect(db.exec("set role service_role")).rejects.toMatchObject({ code: "42501" });
        await expect(db.exec("set role authenticated")).rejects.toMatchObject({ code: "42501" });
        await db.query("select set_config('request.jwt.claim.sub','',false)");
      });
    }
    expect((await db.query<{ enabled: boolean }>("select enabled from fluid_private.subscription_runtime_policy")).rows.every(row => row.enabled)).toBe(true);
  });

  it("rejects foreign known lease tokens at all shared worker RPCs in both directions", async () => {
    const a = await take(OWNER_A), b = await take(OWNER_B);
    await begin(OWNER_A, a); await begin(OWNER_B, b);
    for (const [owner, foreignJob] of [[OWNER_A, b], [OWNER_B, a]] as const) {
      await worker(owner, async () => {
        for (const [sql, args] of leaseAttacks(foreignJob)) await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: "42501" });
      });
    }
    expect((await db.query<{ state: string; progress: number }>("select state,progress from public.jobs")).rows).toEqual([{ state: "running", progress: 0 }, { state: "running", progress: 0 }]);
    expect((await db.query("select * from public.subscription_job_partials")).rows).toEqual([]);
  });

  it("allows only owned subscription step reads and denies direct data or policy writes", async () => {
    const a = await take(OWNER_A), b = await take(OWNER_B);
    await begin(OWNER_A, a); await begin(OWNER_B, b);
    const apiProject = await seedProject(db, OWNER_A);
    const api = await enqueue(db, apiProject.id, "qa-principal-api-job", 100, OWNER_A);
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values($1,$2,$3,'api-step','qa-api-request','in_flight',0)", [api.id, OWNER_A, apiProject.id]);
    for (const [owner, own] of [[OWNER_A, a], [OWNER_B, b]] as const) {
      await worker(owner, async () => {
        expect((await db.query("select job_id,owner_id from public.job_steps")).rows).toEqual([{ job_id: own.id, owner_id: owner }]);
        const forbidden = [
          "select * from public.projects", "select * from public.project_revisions", "select * from public.usage_accounts",
          "select * from public.jobs", "select * from public.job_steps", "select output from public.job_steps", "select provider_request_id from public.job_steps",
          "select * from fluid_private.subscription_runtime_policy", "select * from fluid_private.subscription_registrations",
          "select * from fluid_private.subscription_worker_principals", "update fluid_private.subscription_worker_principals set owner_id=owner_id",
          "update public.job_steps set state='succeeded'", "delete from public.job_steps", "update public.jobs set state='succeeded'",
          "update fluid_private.subscription_runtime_policy set enabled=false", "select * from public.claim_job('qa-bypass',60)",
        ];
        for (const sql of forbidden) await expect(db.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      });
    }
  });

  it("denies service_role subscription configuration and mutation even with valid owner IDs and lease tokens", async () => {
    const job = await take(OWNER_A); await begin(OWNER_A, job);
    await asRole(db, "service_role", null, async () => {
      // Legacy service-role reads on foundation jobs/job_steps remain admin
      // privileges. The new private partial table grants no such access.
      await expect(db.query("select * from public.subscription_job_partials")).rejects.toMatchObject({ code: "42501" });
      const calls = [
        ["select public.configure_subscription_runtime($1,$2,$3::jsonb,true)", [OWNER_A, operation, JSON.stringify(policy(OWNER_A))]],
        ["select * from public.get_subscription_runtime_bindings()", []],
        ["select public.report_subscription_worker_ready($1,$2,$3,$4::jsonb,60)", [OWNER_A, registration(OWNER_A), operation, JSON.stringify(policy(OWNER_A))]],
        ["select public.disable_subscription_runtime($1,$2)", [OWNER_A, registration(OWNER_A)]],
        ["select * from public.claim_subscription_job('qa-service-bypass',$1,$2,60)", [OWNER_A, registration(OWNER_A)]],
        ...leaseAttacks(job),
      ] as const;
      for (const [sql, args] of calls) await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("cannot mutate same-owner or foreign API jobs even when their current lease token is known", async () => {
    for (const apiOwner of owners) {
      const api = await enqueue(db, projects.get(apiOwner)!, `qa-principal-api-known-lease-${apiOwner}`, 100, apiOwner);
      const leased = await claim(db);
      expect(leased.id).toBe(api.id);
      await worker(OWNER_A, async () => {
        for (const [sql, args] of leaseAttacks({ ...leased, owner_id: apiOwner })) await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: "42501" });
      });
    }
  });

  it("expires only the caller's subscription leases and never another owner's or API lease", async () => {
    const a = await take(OWNER_A), b = await take(OWNER_B);
    await enqueue(db, projects.get(OWNER_A)!, "qa-principal-expiry-api", 100, OWNER_A);
    const api = await claim(db);
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=any($1::uuid[])", [[a.id, b.id, api.id]]);
    expect((await worker(OWNER_A, () => db.query<{ count: number }>("select public.expire_job_leases() as count"))).rows[0]!.count).toBe(1);
    expect((await db.query<{ id: string; state: string }>("select id,state from public.jobs where id=any($1::uuid[]) order by id", [[a.id, b.id, api.id]])).rows).toEqual([
      { id: a.id, state: "failed" }, { id: b.id, state: "running" }, { id: api.id, state: "running" },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect((await asRole(db, "service_role", null, () => db.query<{ count: number }>("select public.expire_job_leases() as count"))).rows[0]!.count).toBe(1);
    expect((await db.query<{ state: string }>("select state from public.jobs where id=$1", [b.id])).rows[0]!.state).toBe("running");
    expect((await worker(OWNER_B, () => db.query<{ count: number }>("select public.expire_job_leases() as count"))).rows[0]!.count).toBe(1);
  });

  it("retains lease expiry fencing for the correctly mapped owner", async () => {
    const job = await take(OWNER_A); await begin(OWNER_A, job);
    await worker(OWNER_A, () => db.query("select public.append_subscription_partial($1,$2,'retained owned partial')", [job.id, job.lease_token]));
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    await worker(OWNER_A, async () => {
      for (const [sql, args] of leaseAttacks(job)) await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: "PT409", message: "lease_lost" });
    });
    expect((await db.query("select partial_text from public.subscription_job_partials where job_id=$1", [job.id])).rows).toEqual([{ partial_text: "retained owned partial" }]);
  });

  it("fails closed when the login mapping disappears, including existing leases and step reads", async () => {
    const job = await take(OWNER_A); await begin(OWNER_A, job);
    await db.query("delete from fluid_private.subscription_worker_principals where owner_id=$1", [OWNER_A]);
    // Do not call the provisioning fixture helper again: it would restore the
    // deliberately removed mapping. Keep the existing direct RPC grants.
    await db.exec("set session authorization fixture_subscription_worker_a");
    try {
      expect((await db.query("select public.subscription_worker_owner() as owner")).rows).toEqual([{ owner: null }]);
      expect((await db.query("select job_id from public.job_steps")).rows).toEqual([]);
      await expect(db.query("select * from public.get_subscription_runtime_bindings()")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select public.expire_job_leases()")).rejects.toMatchObject({ code: "42501" });
      for (const [sql, args] of leaseAttacks(job)) await expect(db.query(sql, [...args]), sql).rejects.toMatchObject({ code: "42501" });
    } finally { await db.exec("set session authorization postgres"); }
  });

  it("rejects role recreation with the same name but a different database OID", async () => {
    const previous = (await db.query<{ role_oid: number }>("select role_oid from fluid_private.subscription_worker_principals where owner_id=$1", [OWNER_A])).rows[0]!.role_oid;
    // A recreated login has no ACL history. Give it the identity helper so the OID check, not a missing grant, rejects it.
    await db.exec("drop owned by fixture_subscription_worker_a; drop role fixture_subscription_worker_a; create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    await db.exec("grant execute on function public.subscription_worker_owner(),public.subscription_worker_can_read_step(uuid,uuid) to fixture_subscription_worker_a");
    const current = (await db.query<{ oid: number }>("select oid from pg_roles where rolname='fixture_subscription_worker_a'")).rows[0]!.oid;
    expect(current).not.toBe(previous);
    await worker(OWNER_A, async () => {
      expect((await db.query("select public.subscription_worker_owner() as owner")).rows).toEqual([{ owner: null }]);
      await expect(db.query("select * from public.get_subscription_runtime_bindings()")).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("rejects a mapped login after privilege or membership widening", async () => {
    const disallowed = ["inherit", "bypassrls", "createdb", "createrole", "replication", "nologin"] as const;
    for (const flag of disallowed) {
      await db.exec(`alter role fixture_subscription_worker_a ${flag}`);
      try {
        await worker(OWNER_A, async () => {
          expect((await db.query("select public.subscription_worker_owner() as owner")).rows).toEqual([{ owner: null }]);
          await expect(db.query("select * from public.get_subscription_runtime_bindings()")).rejects.toMatchObject({ code: "42501" });
        });
      } finally { await db.exec("alter role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls"); }
    }
    await db.exec("create role qa_inherited_worker_group nologin; grant qa_inherited_worker_group to fixture_subscription_worker_a");
    try {
      await worker(OWNER_A, async () => {
        expect((await db.query("select public.subscription_worker_owner() as owner")).rows).toEqual([{ owner: null }]);
        await expect(db.query("select * from public.get_subscription_runtime_bindings()")).rejects.toMatchObject({ code: "42501" });
      });
    } finally { await db.exec("revoke qa_inherited_worker_group from fixture_subscription_worker_a; drop role qa_inherited_worker_group"); }
  });
});
