import { API_TEXT_MULTI_ACCOUNT_MIGRATION } from "./fixture-migrations";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { DEFAULT_SUBSCRIPTION_LIMITS } from "../../src/domain/strategy-jobs";
import { asApiTextWorker, asRole, asSubscriptionWorker, createTestDatabase, installApiTextRuntimeCandidate, installApiTextWorkerFixture, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

const policy = { version: 1, pricingVersion: "2026-10-03", handlerVersion: "strategy-openai-v1", model: "gpt-6.1-sol", maxInputTokens: 32768, maxOutputTokens: 4096, maxWebSearchCalls: 0, inputMicrousdPerMillionTokens: 2_000_000, cachedInputMicrousdPerMillionTokens: 100_000, cacheWriteMicrousdPerMillionTokens: 2_500_000, outputMicrousdPerMillionTokens: 10_000_000, webSearchMicrousdPerCall: 10_000, maximumCostMicrousd: 122_880 };
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality", "strategy.positioning"];
const deployment = "fixture-approved-deployment";
type Descriptor = { version: 1; jobId: string; operation: string; policyIdentity: string; deploymentId: string; dispatchIdentity: string; state: string; retryable: boolean; publicationGeneration: number; publishedMessageId: string | null; publishedAt: string | null };
type Lease = { id: string; lease_token: string; state: string; billing_mode: string; attempts: number };
describe("restricted API Strategy candidate (disposable PostgreSQL only)", () => {
  let db: TestDatabase;
  let hostileSetupCount = 0;
  beforeAll(async () => {
    const candidate = await readFile(new URL("../../supabase/candidates/restricted_api_text_runtime.sql", import.meta.url), "utf8");
    db = await createTestDatabase({ before: API_TEXT_MULTI_ACCOUNT_MIGRATION, beforeMigration: async (fixture, sql) => {
      if (sql !== candidate) return;
      expect((await fixture.query("select to_regclass('fluid_private.api_text_worker_principals') as existing")).rows[0]).toEqual({ existing: null });
      await fixture.exec("create role fixture_hostile_default nologin; alter default privileges grant execute on functions to fixture_hostile_default; alter default privileges grant all on tables to fixture_hostile_default");
      hostileSetupCount++;
    } });
    await installApiTextRuntimeCandidate(db);
    await db.exec("alter default privileges revoke execute on functions from fixture_hostile_default; alter default privileges revoke all on tables from fixture_hostile_default");
    await installApiTextWorkerFixture(db);
  }, 30_000);
  let project: string; let otherProject: string; let identity: string;
  beforeEach(async () => {
    await resetFixture(db);
    await db.exec("delete from fluid_private.strategy_runtime_policy");
    await db.exec("update public.usage_accounts set limit_microusd=5000000");
    await db.query("insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) select rolname,oid,case rolname when 'fixture_api_text_a' then $1::uuid else $2::uuid end from pg_roles where rolname in ('fixture_api_text_a','fixture_api_text_b')", [OWNER_A, OWNER_B]);
    project = (await seedProject(db)).id; otherProject = (await seedProject(db, OWNER_B)).id;
    identity = (await db.query<{ h: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as h", [JSON.stringify(policy)])).rows[0]!.h;
  });
  const worker = <T>(run: () => Promise<T>, owner = OWNER_A) => asApiTextWorker(db, owner, run);
  async function rpc<T = unknown>(sql: string, args: unknown[] = []): Promise<T> { return (await db.query<{ result: T }>(`select ${sql} as result`, args)).rows[0]!.result; }
  async function activate(owner = OWNER_A) {
    for (const operation of operations) {
      await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,true,$2::jsonb) on conflict(operation) do update set enabled=true,policy=excluded.policy", [operation, JSON.stringify(policy)]);
      await db.query("insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled) select $1,$2,role_oid,$3,$4,true from fluid_private.api_text_worker_principals where owner_id=$1", [owner, operation, identity, deployment]);
    }
    await rpc("fluid_private.set_strategy_billing_route($1,0,'openai_api')", [owner]);
  }
  async function submit(key = "api-fixture-request-0001", owner = OWNER_A, operation = operations[0]!) {
    return asRole(db, "authenticated", owner, () => rpc<{ id: string; dispatch: { version: 1; jobId: string; policyIdentity: string; deploymentId: string; dispatchIdentity: string } }>("public.enqueue_strategy_job($1,1,$2,$3,122880)", [owner === OWNER_A ? project : otherProject, operation, key]));
  }
  const get = (id: string) => worker(() => rpc<Descriptor | null>("public.get_api_text_dispatch($1)", [id]));
  const take = (id: string, owner = OWNER_A) => worker(() => rpc<{ disposition: string; state: string; job?: Lease }>("public.claim_api_text_job($1,'fixture-worker',60,$2,$3)", [id, identity, deployment]), owner);
  async function begin(job: Lease) {
    await worker(() => rpc("public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify([{ key: "respond", maximumCostMicrousd: 122880 }])]));
    await worker(() => rpc("public.begin_job_step($1,$2,'respond','fixture-request',122880)", [job.id, job.lease_token]));
  }
  afterAll(async () => { await db?.close(); });
  it("installs a fail-closed actual-session principal boundary without creating an active login", async () => {
    const result = await db.query<{ present: boolean }>("select to_regprocedure('public.api_text_worker_owner()') is not null as present");
    expect(result.rows[0]?.present).toBe(true);
    expect((await db.query("select public.api_text_worker_owner() as owner")).rows[0]).toEqual({ owner: null });
    expect((await db.query("select * from pg_roles where rolname='fluid_api_text_worker'")).rows).toEqual([]);
  });
  it("denies spoofed claims, privileged flags, memberships, changed OIDs and role-owned objects", async () => {
    expect(await worker(() => rpc("public.api_text_worker_owner()"))).toBe(OWNER_A);
    await worker(async () => { await db.query("select set_config('request.jwt.claim.sub',$1,false)", [OWNER_B]); expect(await rpc("public.api_text_worker_owner()")).toBe(OWNER_A); });
    await db.exec("set role fixture_api_text_a");
    expect(await rpc("public.api_text_worker_owner()")).toBeNull();
    await db.exec("reset role");
    await db.exec("alter role fixture_api_text_a inherit");
    expect(await worker(() => rpc("public.api_text_worker_owner()"))).toBeNull();
    await db.exec("alter role fixture_api_text_a noinherit; grant authenticated to fixture_api_text_a");
    expect(await worker(() => rpc("public.api_text_worker_owner()"))).toBeNull();
    await db.exec("revoke authenticated from fixture_api_text_a; create table public.fixture_owned(x integer); alter table public.fixture_owned owner to fixture_api_text_a");
    expect(await worker(() => rpc("public.api_text_worker_owner()"))).toBeNull();
    await db.exec("drop table public.fixture_owned; update fluid_private.api_text_worker_principals set role_oid=1 where role_name='fixture_api_text_a'");
    expect(await worker(() => rpc("public.api_text_worker_owner()"))).toBeNull();
  });
  it("requires explicit owner binding, leaves competitors unavailable, and atomically saves one immutable dispatch", async () => {
    await expect(submit()).rejects.toThrow("runtime_unavailable");
    await activate();
    const availability = await asRole(db,"authenticated",OWNER_A,() => rpc<{ operations: { operation: string }[] }>("public.get_strategy_availability(null)"));
    expect(availability.operations.map(row => row.operation)).toEqual(operations.filter(op => op !== "strategy.competitors").sort());
    await expect(submit("api-competitors-request",OWNER_A,"strategy.competitors")).rejects.toThrow("runtime_unavailable");
    const job = await submit(); const dispatch = await get(job.id);
    expect(dispatch).toMatchObject({ ...job.dispatch, operation: operations[0], state: "queued", publicationGeneration: 0, publishedAt: null, retryable: true });
    expect(await submit()).toEqual(job);
    expect((await db.query("select * from public.usage_reservations")).rows).toHaveLength(1);
    await expect(db.query("update fluid_private.api_text_dispatches set deployment_id='changed' where job_id=$1",[job.id])).rejects.toThrow("immutable_dispatch");
    expect(await worker(() => rpc("public.get_api_text_dispatch($1)",[job.id]),OWNER_B)).toBeNull();
    await expect(submit("other-owner-request",OWNER_B)).rejects.toThrow("runtime_unavailable");
  });
  it("fences exact job identity, policy, deployment and cross-owner valid lease while preserving settlement after withdrawal", async () => {
    await activate(); await activate(OWNER_B);
    const accepted = await submit(); const other = await submit("other-fixture-request",OWNER_B);
    expect((await take(other.id)).disposition).toBe("not_found");
    expect(await worker(() => rpc("public.check_api_text_runtime($1,$2::jsonb,'wrong')",[operations[0],JSON.stringify(policy)]))).toBe(false);
    const result = await take(accepted.id); expect(result.disposition).toBe("claimed"); const job = result.job!;
    expect(job.billing_mode).toBe("openai_api");
    expect((await take(accepted.id)).disposition).toBe("busy");
    await expect(worker(() => rpc("public.heartbeat_job($1,$2,60)",[job.id,job.lease_token]),OWNER_B)).rejects.toThrow("worker_owner_mismatch");
    await begin(job);
    expect(await worker(() => rpc("public.authorize_api_text_dispatch($1,$2,'respond',$3,$4)",[job.id,job.lease_token,identity,deployment]))).toBe(true);
    await db.exec("update fluid_private.api_strategy_bindings set enabled=false");
    expect(await worker(() => rpc("public.authorize_api_text_dispatch($1,$2,'respond',$3,$4)",[job.id,job.lease_token,identity,deployment]))).toBe(false);
    await worker(() => rpc("public.complete_job_step($1,$2,'respond','succeeded',800,'{}'::jsonb,'fixture-response')",[job.id,job.lease_token]));
    await worker(() => rpc("public.finish_job($1,$2,'succeeded',null)",[job.id,job.lease_token]));
    expect((await take(job.id)).disposition).toBe("terminal");
    expect((await db.query("select spent_microusd,reserved_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({ spent_microusd: 800, reserved_microusd: 0 });
  });
  it("uses the existing image/text ledger and pauses all paid work after uncertain outcome", async () => {
    await activate();
    await db.query("update public.usage_accounts set reserved_microusd=4900000 where owner_id=$1",[OWNER_A]);
    await expect(submit()).rejects.toThrow("budget_exceeded");
    await db.query("update public.usage_accounts set reserved_microusd=0 where owner_id=$1",[OWNER_A]);
    const accepted = await submit(); const job = (await take(accepted.id)).job!; await begin(job);
    await worker(() => rpc("public.complete_job_step($1,$2,'respond','ambiguous',0,null,null)",[job.id,job.lease_token]));
    expect((await get(job.id))?.state).toBe("needs_reconciliation");
    await expect(submit("api-fixture-request-0002")).rejects.toThrow("paid_outcome_unresolved");
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({ reserved_microusd: 122880 });
  });

  it("exposes only exact worker functions and seven RLS-filtered recovery columns", async () => {
    await activate(); await activate(OWNER_B);
    const a = (await take((await submit()).id)).job!; await begin(a);
    const b = (await take((await submit("other-api-request-0001",OWNER_B)).id,OWNER_B)).job!;
    await asApiTextWorker(db,OWNER_B,async () => {
      await rpc("public.register_job_plan($1,$2,$3::jsonb)",[b.id,b.lease_token,JSON.stringify([{key:"respond",maximumCostMicrousd:122880}])]);
      await rpc("public.begin_job_step($1,$2,'respond','other-request',122880)",[b.id,b.lease_token]);
    });
    await worker(async () => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[OWNER_B]);
      expect((await db.query("select job_id from public.job_steps")).rows).toEqual([{job_id:a.id}]);
      for (const table of ["jobs","projects","usage_accounts","usage_reservations"]) await expect(db.query(`select * from public.${table}`)).rejects.toMatchObject({code:"42501"});
      for (const column of ["output","actual_cost_microusd","provider_request_id"]) await expect(db.query(`select ${column} from public.job_steps`)).rejects.toMatchObject({code:"42501"});
      await expect(db.query("update public.job_steps set state='failed' where job_id=$1",[a.id])).rejects.toMatchObject({code:"42501"});
      await expect(db.query("select * from fluid_private.api_text_dispatches")).rejects.toMatchObject({code:"42501"});
      await expect(db.query("create table public.fixture_forbidden(x int)")).rejects.toMatchObject({code:"42501"});
      for (const signature of ["public.claim_job(text,integer)","public.expire_job_leases()","public.configure_subscription_runtime(uuid,text,jsonb,boolean)","public.claim_subscription_job(text,uuid,text,integer)","public.complete_naming_job_step(uuid,uuid,text,text,bigint,jsonb,text)","public.claim_logo_job(text,integer)","public.request_job_cancel(uuid)","public.report_strategy_worker_ready(text,jsonb,integer)"]) {
        expect(await rpc("has_function_privilege(session_user,$1,'execute')",[signature])).toBe(false);
      }
    });
    for (const role of ["anon","authenticated","service_role"] as const) {
      await expect(asRole(db,role,OWNER_A,() => rpc("public.claim_api_text_job($1,'spoof',60,$2,$3)",[a.id,identity,deployment]))).rejects.toMatchObject({code:"42501"});
      expect(await asRole(db,role,OWNER_A,() => rpc("public.api_text_worker_owner()"))).toBeNull();
    }
  });
  it("recovers only predispatch lease expiry with bounded increasing attempts; an expired in-flight lease is quarantined", async () => {
    await activate(); const accepted=await submit(); const first=(await take(accepted.id)).job!;
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[first.id]);
    expect(await worker(() => rpc("public.expire_api_text_job($1)",[first.id]))).toEqual({disposition:"available",state:"queued"});
    const second=(await take(first.id)).job!; expect(second.attempts).toBe(first.attempts+1); expect(second.lease_token).not.toBe(first.lease_token);
    await expect(worker(() => rpc("public.heartbeat_job($1,$2,60)",[first.id,first.lease_token]))).rejects.toThrow("lease_lost");
    await begin(second);
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[second.id]);
    expect(await worker(() => rpc("public.expire_api_text_job($1)",[second.id]))).toEqual({disposition:"terminal",state:"needs_reconciliation"});
    await expect(worker(() => rpc("public.complete_job_step($1,$2,'respond','succeeded',1,'{}'::jsonb,null)",[second.id,second.lease_token]))).rejects.toThrow("lease_lost");
    expect((await take(second.id)).disposition).toBe("terminal");
    expect(await worker(() => rpc("public.expire_api_text_job($1)",[second.id]),OWNER_B)).toEqual({disposition:"not_found",state:"not_found"});
  });
  it("generation-fences publication and permits only stalled safe predispatch redrive", async () => {
    await activate(); const accepted=await submit(); const descriptor=(await get(accepted.id))!;
    expect(await worker(() => rpc("public.mark_api_text_published($1,$2,0,'queue-message-1')",[accepted.id,descriptor.dispatchIdentity]))).toBe(true);
    expect(await worker(() => rpc("public.mark_api_text_published($1,$2,0,'queue-message-1')",[accepted.id,descriptor.dispatchIdentity]))).toBe(true);
    expect(await worker(() => rpc("public.mark_api_text_published($1,$2,0,'queue-message-2')",[accepted.id,descriptor.dispatchIdentity]))).toBe(false);
    expect(await worker(() => rpc("public.prepare_api_text_redrive($1,$2,0)",[accepted.id,descriptor.dispatchIdentity]))).toBeNull();
    const stale=await submit("stale-api-request-0002"); const d=(await get(stale.id))!;
    // Explicit local old Queue receipt; no provider call and no time mutation.
    await db.exec("alter table fluid_private.api_text_dispatches disable trigger api_text_dispatch_immutable");
    await db.query("update fluid_private.api_text_dispatches set generation_started_at=clock_timestamp()-interval '31 minutes',published_at=clock_timestamp()-interval '31 minutes',published_message_id='expired-queue' where job_id=$1",[stale.id]);
    await db.exec("alter table fluid_private.api_text_dispatches enable trigger api_text_dispatch_immutable");
    const rows=await worker(() => db.query<{result:Descriptor}>("select public.list_pending_api_text_dispatches(25) as result"));
    expect(rows.rows.map(row=>row.result.jobId)).toContain(stale.id);
    const redrive=await worker(() => rpc<Descriptor>("public.prepare_api_text_redrive($1,$2,0)",[stale.id,d.dispatchIdentity]));
    expect(redrive).toMatchObject({jobId:stale.id,dispatchIdentity:d.dispatchIdentity,publicationGeneration:1,publishedAt:null});
    expect(await worker(() => rpc("public.prepare_api_text_redrive($1,$2,0)",[stale.id,d.dispatchIdentity]))).toBeNull();
    expect(await worker(() => rpc("public.mark_api_text_published($1,$2,0,'late-old-receipt')",[stale.id,d.dispatchIdentity]))).toBe(false);
    expect(await worker(() => rpc("public.mark_api_text_published($1,$2,1,'new-generation-receipt')",[stale.id,d.dispatchIdentity]))).toBe(true);
    expect((await db.query("select * from public.usage_reservations where job_id=$1",[stale.id])).rows).toHaveLength(1);
    await expect(worker(() => rpc("public.list_pending_api_text_dispatches(26)"))).rejects.toThrow("invalid_limit");
  });
  it("preserves three zero-money subscription uncertainty rows byte-for-byte during API selection", async () => {
    const subPolicy={version:1,billingMode:"chatgpt_subscription",handlerVersion:"strategy-chatgpt-v1",registrationId:"historical-fixture",model:"unchanged-subscription-model",limits:DEFAULT_SUBSCRIPTION_LIMITS};
    await asSubscriptionWorker(db,OWNER_A,() => rpc("public.configure_subscription_runtime($1,$2,$3::jsonb,true)",[OWNER_A,operations[0],JSON.stringify(subPolicy)]));
    for(let index=0;index<3;index++) await db.query("insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,billing_mode,policy_identity,max_attempts,reserved_cost_microusd) values($1,$2,$3,1,repeat('a',64),$4::jsonb,$5,'needs_reconciliation','chatgpt_subscription',encode(sha256(convert_to($6::jsonb::text,'UTF8')),'hex'),1,0)",[OWNER_A,project,operations[index],JSON.stringify({version:1,billingMode:"chatgpt_subscription",policy:subPolicy}),`historical-fixture-${index}`,JSON.stringify(subPolicy)]);
    const before=(await db.query("select to_jsonb(j) as data from public.jobs j order by id")).rows;
    const policiesBefore=(await db.query("select to_jsonb(p) as data from fluid_private.subscription_runtime_policy p")).rows;
    await activate(); await submit();
    expect((await db.query("select to_jsonb(j) as data from public.jobs j where billing_mode='chatgpt_subscription' order by id")).rows).toEqual(before);
    expect((await db.query("select to_jsonb(p) as data from fluid_private.subscription_runtime_policy p")).rows).toEqual(policiesBefore);
    expect(await asSubscriptionWorker(db,OWNER_A,() => rpc("public.report_subscription_worker_ready($1,'historical-fixture',$2,$3::jsonb,60)",[OWNER_A,operations[0],JSON.stringify(subPolicy)]))).toBe(false);
  });
  it.each(operations)("honors API selection in subscription admission, claim, step and final readiness for %s", async (operation) => {
    const subPolicy={version:1,billingMode:"chatgpt_subscription",handlerVersion:"strategy-chatgpt-v1",registrationId:"route-fixture",model:"unchanged-subscription-model",limits:DEFAULT_SUBSCRIPTION_LIMITS};
    const sub= <T>(run:()=>Promise<T>)=>asSubscriptionWorker(db,OWNER_A,run);
    await sub(() => rpc("public.configure_subscription_runtime($1,$2,$3::jsonb,true)",[OWNER_A,operation,JSON.stringify(subPolicy)]));
    await sub(() => rpc("public.report_subscription_worker_ready($1,'route-fixture',$2,$3::jsonb,60)",[OWNER_A,operation,JSON.stringify(subPolicy)]));
    const subIdentity=await rpc<string>("encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex')",[JSON.stringify(subPolicy)]);
    const enqueueSub=(key:string)=>asRole(db,"authenticated",OWNER_A,()=>rpc<{id:string}>("public.enqueue_subscription_strategy_job($1,1,$2,$3,$4)",[project,operation,key,subIdentity]));
    const old=await enqueueSub("retained-subscription-request");
    const claimed=(await sub(()=>db.query<Lease>("select * from public.claim_subscription_job('fixture',$1,'route-fixture',60)",[OWNER_A]))).rows[0]!;
    await expect(rpc("fluid_private.set_strategy_billing_route($1,0,'openai_api')",[OWNER_A])).rejects.toThrow("strategy_work_active");
    // Explicit administrator-only withdrawal fixture exercises gates even when a
    // prohibited direct route edit is attempted outside the reviewed CAS helper.
    await db.query("insert into fluid_private.strategy_billing_routes values($1,'openai_api',1)",[OWNER_A]);
    await sub(()=>rpc("public.register_job_plan($1,$2,$3::jsonb)",[claimed.id,claimed.lease_token,JSON.stringify([{key:"respond",maximumCostMicrousd:0}])]));
    await expect(sub(()=>rpc("public.begin_job_step($1,$2,'respond','request',0)",[claimed.id,claimed.lease_token]))).rejects.toThrow("billing_mode_conflict");
    expect(await sub(()=>rpc("public.report_subscription_worker_ready($1,'route-fixture',$2,$3::jsonb,60)",[OWNER_A,operation,JSON.stringify(subPolicy)]))).toBe(false);
    await db.query("update public.jobs set state='queued',lease_token=null,lease_expires_at=null,attempts=0 where id=$1",[old.id]);
    expect((await sub(()=>db.query("select * from public.claim_subscription_job('fixture',$1,'route-fixture',60)",[OWNER_A]))).rows).toEqual([]);
    expect(await enqueueSub("retained-subscription-request")).toMatchObject({id:old.id});
    const fresh=(await seedProject(db)).id;
    await expect(asRole(db,"authenticated",OWNER_A,()=>rpc("public.enqueue_subscription_strategy_job($1,1,$2,'new-subscription-request',$3)",[fresh,operation,subIdentity]))).rejects.toThrow("billing_mode_conflict");
    await expect(submit("retained-subscription-request",OWNER_A,operation)).rejects.toThrow("idempotency_conflict");
  });
  it("retains cancellation costs, permits settlement replay and pauses on a real overrun", async () => {
    await activate();
    const queued=await submit(); await asRole(db,"authenticated",OWNER_A,()=>rpc("public.request_job_cancel($1)",[queued.id]));
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({reserved_microusd:0});
    const running=(await take((await submit("cancel-api-request-0002")).id)).job!; await begin(running);
    await asRole(db,"authenticated",OWNER_A,()=>rpc("public.request_job_cancel($1)",[running.id]));
    expect(await worker(()=>rpc("public.authorize_api_text_dispatch($1,$2,'respond',$3,$4)",[running.id,running.lease_token,identity,deployment]))).toBe(false);
    const complete=()=>worker(()=>rpc("public.complete_job_step($1,$2,'respond','failed',900,null,'known-charge')",[running.id,running.lease_token]));
    await complete(); await complete();
    await worker(()=>rpc("public.finish_job($1,$2,'cancelled',null)",[running.id,running.lease_token]));
    expect((await db.query("select spent_microusd,reserved_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({spent_microusd:900,reserved_microusd:0});
    const overrun=(await take((await submit("overrun-api-request-0003")).id)).job!; await begin(overrun);
    await worker(()=>rpc("public.complete_job_step($1,$2,'respond','succeeded',122881,'{}'::jsonb,'overrun')",[overrun.id,overrun.lease_token]));
    expect((await get(overrun.id))?.state).toBe("needs_reconciliation");
    expect((await db.query("select provider_actual_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({provider_actual_microusd:123781});
    await expect(submit("paused-api-request-0004")).rejects.toThrow("paid_outcome_unresolved");
  });

  it("fails exhausted predispatch recovery explicitly and releases only its never-dispatched reservation", async () => {
    await activate(); const accepted=await submit();
    for(let attempt=1;attempt<=3;attempt++) {
      const claim=await take(accepted.id); expect(claim.disposition).toBe("claimed"); expect(claim.job!.attempts).toBe(attempt);
      await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[accepted.id]);
      expect(await worker(()=>rpc("public.expire_api_text_job($1)",[accepted.id]))).toEqual(attempt===3?{disposition:"terminal",state:"failed"}:{disposition:"available",state:"queued"});
    }
    expect((await get(accepted.id))?.retryable).toBe(false);
    expect((await take(accepted.id)).disposition).toBe("terminal");
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({reserved_microusd:0});
  });

  it("removes hostile default ACLs from only the exact new capability inventory", async () => {
    expect(hostileSetupCount).toBe(1);
    for (const signature of ["public.claim_api_text_job(uuid,text,integer,text,text)","public.prepare_api_text_redrive(uuid,text,integer)","fluid_private.set_strategy_billing_route(uuid,integer,text)","fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)"]) {
      expect(await rpc("has_function_privilege('fixture_hostile_default',$1,'execute')",[signature])).toBe(false);
    }
    for (const table of ["fluid_private.api_text_dispatches","fluid_private.strategy_billing_routes","fluid_private.api_strategy_bindings","fluid_private.api_text_worker_principals"]) {
      expect(await rpc("has_table_privilege('fixture_hostile_default',$1,'select,insert,update,delete')",[table])).toBe(false);
    }
    expect(await rpc("(select relforcerowsecurity from pg_class where oid='public.job_steps'::regclass)")).toBe(true);
  });

  it("pauses real paid logo admission, claims, step start and final dispatch readiness after uncertain text", async () => {
    await activate();
    await db.exec("create role fixture_shared_logo login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant usage on schema public to fixture_shared_logo; grant execute on function public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.read_leased_logo_record(uuid,uuid,text,jsonb),public.report_logo_worker_ready(text,jsonb,integer) to fixture_shared_logo");
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_shared_logo'",[OWNER_A]);
    const descriptor={operation:"identity.logo_concept",policyIdentity:"a".repeat(64),handlerVersion:"logo-image-v1",provider:"openai",model:"gpt-image-2.5-sunburst-2026-09-08",engine:null,maxCostMicrousd:100};
    await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,$2,$3,$4,$5,$6,100,true)",[OWNER_A,descriptor.operation,descriptor.policyIdentity,descriptor.handlerVersion,descriptor.provider,descriptor.model]);
    const logoWorker=async<T,>(run:()=>Promise<T>)=>{ await db.exec("set session authorization fixture_shared_logo");try{return await run();}finally{await db.exec("set session authorization postgres");} };
    await logoWorker(()=>rpc("public.report_logo_worker_ready('shared-image',$1::jsonb,90)",[JSON.stringify([descriptor])]));
    const user=<T,>(sql:string,args:unknown[]=[])=>asRole(db,"authenticated",OWNER_A,()=>rpc<T>(sql,args));
    const workspace=await startLogoFixture(ownerQuery(db),{requestKey:randomUUID(),brief:{name:"Shared budget fixture",activity:"Synthetic",audience:"Fixture",personality:"Calm",logoTypes:["wordmark"]}});
    const reference=(await db.query<{reference_snapshot_id:string}>("select reference_snapshot_id from public.logo_stage_revisions where id=$1",[workspace.stages.brief_references!.id])).rows[0]!.reference_snapshot_id;
    const request={operation:"concepts",expected:workspace.heads,briefRevisionId:workspace.stages.brief_references!.id,referenceSnapshotId:reference};
    const quote=logoCostQuoteSchema.parse(await user("public.quote_logo_operation($1,$2::jsonb)",[workspace.projectId,JSON.stringify(request)]));
    const receipt=logoDispatchReceiptSchema.parse(await user("public.admit_logo_operation($1,$2::jsonb)",[workspace.projectId,JSON.stringify({requestKey:randomUUID(),quoteId:quote.id,acceptedMaxCostMicrousd:600,expected:workspace.heads})]));
    expect(receipt.jobIds).toHaveLength(6);
    const imageClaim=()=>logoWorker(()=>db.query<Lease & {plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('shared-image',60)"));
    const image1=(await imageClaim()).rows[0]!; const image2=(await imageClaim()).rows[0]!;
    await logoWorker(()=>rpc("public.begin_logo_job_step($1,$2,$3,'first-image',100)",[image1.id,image1.lease_token,image1.plan_manifest[0]!.key]));
    const text=(await take((await submit()).id)).job!;await begin(text);
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows[0]).toEqual({reserved_microusd:123480});
    await worker(()=>rpc("public.complete_job_step($1,$2,'respond','ambiguous',0,null,null)",[text.id,text.lease_token]));
    expect(await logoWorker(()=>rpc("public.read_leased_logo_record($1,$2,'runtime_readiness',null)",[image1.id,image1.lease_token]))).toBe(false);
    expect((await imageClaim()).rows).toEqual([]);
    await expect(logoWorker(()=>rpc("public.begin_logo_job_step($1,$2,$3,'second-image',100)",[image2.id,image2.lease_token,image2.plan_manifest[0]!.key]))).rejects.toThrow("logo_runtime_unavailable");
    await expect(user("public.quote_logo_operation($1,$2::jsonb)",[workspace.projectId,JSON.stringify(request)])).rejects.toThrow("logo_runtime_unavailable");
  });

  it("does not let 26 superseded dispatches starve an eligible pending repair", async () => {
    await activate();
    for(let index=0;index<26;index++) await submit(`superseded-api-request-${index}`);
    await db.query("update fluid_private.api_strategy_bindings set deployment_id='replacement-deployment' where owner_id=$1",[OWNER_A]);
    const current=await submit("current-api-request-0027");
    const repair=await worker(()=>db.query<{result:Descriptor}>("select public.list_pending_api_text_dispatches(25) as result"));
    expect(repair.rows.map(row=>row.result.jobId)).toEqual([current.id]);
    expect((await db.query("select count(*)::int as count from fluid_private.api_text_dispatches")).rows[0]).toEqual({count:27});
  });

  it("excludes a replaced same-owner principal from retryable repair eligibility", async () => {
    await activate(); const accepted=await submit();
    await db.query("update fluid_private.api_text_worker_principals set owner_id=$1 where role_name='fixture_api_text_b'",[OWNER_A]);
    await db.exec("update fluid_private.api_strategy_bindings set role_oid=(select oid from pg_roles where rolname='fixture_api_text_b')");
    expect((await get(accepted.id))?.retryable).toBe(false);
    expect((await worker(()=>db.query("select public.list_pending_api_text_dispatches(25)"))).rows).toEqual([]);
    expect(await asApiTextWorker(db,OWNER_B,()=>rpc("public.api_text_worker_owner()"))).toBe(OWNER_A);
    expect(await asApiTextWorker(db,OWNER_B,()=>rpc<Descriptor>("public.get_api_text_dispatch($1)",[accepted.id]))).toMatchObject({retryable:true});
    expect((await take(accepted.id)).disposition).toBe("unavailable");
    expect((await take(accepted.id,OWNER_B)).disposition).toBe("claimed");
  });

  it("keeps shared owner coordination free of account-before-project/job lock inversion", async () => {
    // Catalog/source-order guard complements behavioral tests. PGlite cannot
    // establish a real two-session deadlock schedule or pooler behavior.
    const definition=(signature:string)=>rpc<string>("pg_get_functiondef($1::regprocedure)",[signature]);
    const coordination=await definition("fluid_private.lock_strategy_owner(uuid)");
    expect(coordination).not.toContain("public.usage_accounts");
    const admission=await definition("public.enqueue_strategy_job(uuid,integer,text,text,bigint)");
    expect(admission.indexOf("v_project from public.projects")).toBeLessThan(admission.indexOf("from public.usage_accounts where owner_id = v_owner for update"));
    expect(admission.indexOf("api_text_paid_paused(v_owner)")).toBeGreaterThan(admission.indexOf("from public.usage_accounts where owner_id = v_owner for update"));
    expect(await definition("public.check_api_text_runtime(text,jsonb,text)")).toContain("public.usage_accounts where owner_id=v_owner for share");
    expect(await definition("fluid_private.set_strategy_billing_route(uuid,integer,text)")).toContain("public.usage_accounts where owner_id=p_owner for update");
  });

  it("redrives an aged missing publication receipt once per generation without changing the paid identity", async () => {
    expect(await rpc("exists(select 1 from pg_attribute where attrelid='fluid_private.api_text_dispatches'::regclass and attname='generation_started_at')")).toBe(true);
    await activate(); const accepted=await submit(); const first=(await get(accepted.id))!;
    // Disposable time-travel fixture only. The application cannot alter this age.
    await db.exec("alter table fluid_private.api_text_dispatches disable trigger api_text_dispatch_immutable");
    await db.query("update fluid_private.api_text_dispatches set generation_started_at=clock_timestamp()-interval '31 minutes' where job_id=$1",[accepted.id]);
    await db.exec("alter table fluid_private.api_text_dispatches enable trigger api_text_dispatch_immutable");
    const next=await worker(()=>rpc<Descriptor>("public.prepare_api_text_redrive($1,$2,0)",[accepted.id,first.dispatchIdentity]));
    expect(next).toMatchObject({jobId:accepted.id,dispatchIdentity:first.dispatchIdentity,publicationGeneration:1,publishedAt:null});
    expect(await worker(()=>rpc("public.prepare_api_text_redrive($1,$2,1)",[accepted.id,first.dispatchIdentity]))).toBeNull();
    const ageBefore=await rpc("(select generation_started_at from fluid_private.api_text_dispatches where job_id=$1)",[accepted.id]);
    await worker(()=>rpc("public.mark_api_text_published($1,$2,1,'confirmed-after-loss')",[accepted.id,first.dispatchIdentity]));
    expect(await rpc("(select generation_started_at from fluid_private.api_text_dispatches where job_id=$1)",[accepted.id])).toEqual(ageBefore);
    await expect(db.query("update fluid_private.api_text_dispatches set generation_started_at=clock_timestamp() where job_id=$1",[accepted.id])).rejects.toThrow("immutable_dispatch");
    expect((await db.query("select attempts,reserved_cost_microusd from public.jobs where id=$1",[accepted.id])).rows[0]).toEqual({attempts:0,reserved_cost_microusd:122880});
  });

  it("reports route and lease business conflicts as PT409 without signaling an engine serialization retry", async () => {
    await activate();
    await expect(rpc("fluid_private.set_strategy_billing_route($1,0,'openai_api')", [OWNER_A])).rejects.toMatchObject({ code: "PT409" });
    const accepted = await submit(); const job = (await take(accepted.id)).job!;
    await expect(worker(() => rpc("public.heartbeat_job($1,$2,60)", [job.id, OWNER_A]))).rejects.toMatchObject({ code: "PT409" });
    await expect(worker(() => rpc("public.heartbeat_job($1,$2,60)", [OWNER_B, job.lease_token]))).rejects.toMatchObject({ code: "PT409" });
  });

});
