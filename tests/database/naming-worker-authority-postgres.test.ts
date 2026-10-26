import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { OWNER_A, type TestDatabase } from "./local-supabase";
import { brainPolicy, brainRpc, brainWorker, initialIntent } from "./naming-brain-fixture";
import { progressiveRequest, seedProgressiveFixture } from "./naming-brain-progressive-fixture";
import { createReceiptNativeFixture, receiptNativeConfigPath } from "./naming-receipt-native-fixture";
import { authoritySnapshot, continuePayload, expireAuthority, installAuthorityFixture, maintenance, seedAuthorityFixture, workerStatus, type AuthorityJob } from "./naming-worker-authority-fixture";

// Explicit private reviewer configuration only. This harness never manages the
// server and retains its uniquely created database/roles, including on failure.
const native = it.skipIf(!receiptNativeConfigPath);
let fixture: Awaited<ReturnType<typeof createReceiptNativeFixture>>, db: TestDatabase;
const evidence: Record<string, unknown> = { kind: "disposable PostgreSQL 18 native authority tests", productionEvidence: false };
const workerQuery = (client: Client, generation: number, action: string, payload: unknown = {}, worker = "fixture-worker") =>
  client.query("select public.naming_brain_worker_maintenance_v2($1,'fixture-deployment',$2::bigint,$3,$4::jsonb) result", [worker, generation, action, JSON.stringify(payload)]);
const statusQuery = (client: Client, worker: string, generation: number | null = null) =>
  client.query("select public.report_naming_brain_worker_status($1::jsonb,'fixture-deployment',$2,$3::bigint,60) result", [JSON.stringify(brainPolicy), worker, generation]);
async function waitForLock(client: Client) {
  const pid = (await client.query("select pg_backend_pid() pid")).rows[0].pid;
  return pid;
}
async function waitBlocked(pid: number) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const row = (await fixture.setup.query("select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === "Lock" && row.blockers.length) return row.blockers as number[];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("native_expected_lock_wait_not_observed");
}
async function lockOwner() {
  const client = await fixture.connectWorker(); await client.query("reset session authorization");
  await client.query("begin"); await client.query("select fluid_private.lock_strategy_owner($1)", [OWNER_A]);
  return client;
}
beforeAll(async () => {
  if (!receiptNativeConfigPath) return;
  fixture = await createReceiptNativeFixture(); db = fixture.db; await installAuthorityFixture(db);
  evidence.database = fixture.database; evidence.version = fixture.version;
}, 60_000);
afterAll(async () => {
  if (!fixture) return;
  await fixture.close();
  await mkdir(new URL("../../.tmp/", import.meta.url), { recursive: true });
  await writeFile(new URL("../../.tmp/naming-worker-authority-native-result.json", import.meta.url), JSON.stringify({ ...evidence, fixturePreserved: true, clientsClosed: true,
    walScope: "LSN deltas are contextual to the bounded disposable probe interval and can include unrelated backend/background WAL; not production I/O or per-request attribution." }, null, 2));
});

native("returns all empty probes under a held owner lock without changing tuple headers or evidence", async () => {
  await seedAuthorityFixture(db);
  const worker = await fixture.connectWorker(), holder = await lockOwner();
  await worker.query("set lock_timeout='150ms'");
  const before = await authoritySnapshot(db), times: number[] = [];
  const lsn = (await fixture.setup.query("select pg_current_wal_insert_lsn() value")).rows[0].value;
  try {
    for (const sql of ["select public.claim_naming_brain_job('fixture-worker','fixture-deployment',120) result", "select public.expire_naming_brain_leases('fixture-worker','fixture-deployment') result"]) {
      const start = performance.now(); expect((await worker.query(sql)).rows[0].result).toBe(sql.includes("claim_") ? null : 0); times.push(performance.now() - start);
    }
    expect(await authoritySnapshot(db)).toEqual(before);
    evidence.legacyEmptyWalBytes = Number((await fixture.setup.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text bytes", [lsn])).rows[0].bytes);
  } finally { await holder.query("rollback"); await holder.end(); }
  const generation = (await workerStatus(db)).generation!, v2holder = await lockOwner(), snapshot = await authoritySnapshot(db);
  const v2lsn = (await fixture.setup.query("select pg_current_wal_insert_lsn() value")).rows[0].value;
  try {
    for (const action of ["claim", "expire_leases", "preference_work"]) {
      const start = performance.now(), response = await workerQuery(worker, generation, action, action === "preference_work" ? { limit: 20 } : {});
      expect(response.rows[0].result).toEqual(action === "claim" ? null : action === "expire_leases" ? 0 : []); times.push(performance.now() - start);
    }
    expect(await authoritySnapshot(db)).toEqual(snapshot);
    evidence.emptyProbes = { calls: 5, milliseconds: times, tupleHeadersAndBusinessEvidenceUnchanged: true, ownerLockHeld: true, lockTimeoutMs: 150,
      contextualWalBytesExcludingEnrollment: Number((await fixture.setup.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text bytes", [v2lsn])).rows[0].bytes) };
  } finally { await v2holder.query("rollback"); await v2holder.end(); await worker.end(); }
}, 30_000);

native("renews the current owner and rejects a follower promptly under a held account lock", async () => {
  await seedAuthorityFixture(db); const generation = (await workerStatus(db)).generation!;
  const holder = await lockOwner(), worker = await fixture.connectWorker(); await worker.query("set lock_timeout='150ms'");
  const route = (await fixture.setup.query("select xmin::text,xmax::text,ctid::text,to_jsonb(t) value from fluid_private.strategy_billing_routes t")).rows;
  try {
    const before = await authoritySnapshot(db);
    expect((await statusQuery(worker, "other-worker")).rows[0].result).toMatchObject({ leader: false, generation: null, expiresAt: null, reason: "held" });
    expect(await authoritySnapshot(db)).toEqual(before);
    expect((await statusQuery(worker, "fixture-worker", generation)).rows[0].result).toMatchObject({ leader: true, generation, ready: true });
    expect((await fixture.setup.query("select xmin::text,xmax::text,ctid::text,to_jsonb(t) value from fluid_private.strategy_billing_routes t")).rows).toEqual(route);
    evidence.renewal = { noOwnerLockWait: true, followerNoTupleChanges: true, renewalControlWritesExpected: true };
  } finally { await holder.query("rollback"); await holder.end(); await worker.end(); }
}, 30_000);

native("serializes overlapping acquisition and fences the expired owner's renewal", async () => {
  await seedAuthorityFixture(db); const first = await workerStatus(db); await expireAuthority(db);
  const a = await fixture.connectWorker(), b = await fixture.connectWorker();
  try {
    const [one, two] = await Promise.all([statusQuery(a, "new-one"), statusQuery(b, "new-two")]);
    const results = [one.rows[0].result, two.rows[0].result]; expect(results.filter(r => r.leader)).toHaveLength(1);
    expect(results.find(r => r.leader).generation).toBe(first.generation! + 1);
    expect(await workerStatus(db, first.generation)).toMatchObject({ leader: false, reason: "fenced" });
    evidence.overlap = { backendPids: [await waitForLock(a), await waitForLock(b)], outcomes: results, exactlyOneLeader: true };
  } finally { await a.end(); await b.end(); }
}, 30_000);

native("rechecks candidate policy after actual owner-lock waiting", async () => {
  const project = await seedAuthorityFixture(db); await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent()]);
  const generation = (await workerStatus(db)).generation!, holder = await lockOwner(), worker = await fixture.connectWorker(), pid = await waitForLock(worker);
  try {
    const pending = workerQuery(worker, generation, "claim"); const blockers = await waitBlocked(pid);
    await holder.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1", [OWNER_A]); await holder.query("commit");
    expect((await pending).rows[0].result).toBeNull();
    expect((await db.query("select state,lease_token from public.jobs")).rows).toEqual([{ state: "queued", lease_token: null }]);
    expect((await db.query("select count(*)::int count from fluid_private.naming_worker_job_authority")).rows).toEqual([{ count: 0 }]);
    evidence.candidatePolicyRace = { actualWaitObserved: true, blockers, rejectedAfterCommit: true };
  } finally { await holder.query("rollback"); await holder.end(); await worker.end(); }
}, 30_000);

native("rechecks generation after an actual owner-lock wait rather than a stale preflight", async () => {
  const project = await seedAuthorityFixture(db); await brainRpc(db, "ensure_naming_brain_run", [project, initialIntent()]);
  const generation = (await workerStatus(db)).generation!, claim = await maintenance<{ job: AuthorityJob }>(db, generation, "claim");
  const holder = await lockOwner(), worker = await fixture.connectWorker(), pid = await waitForLock(worker);
  try {
    const pending = workerQuery(worker, generation, "assert_continue", continuePayload(claim.job)).then(r => ({ result: r.rows[0].result, code: null }), e => ({ result: null, code: e.code }));
    const blockers = await waitBlocked(pid);
    // Disposable controlled mutation under the real owner lock isolates the
    // post-wait visibility property; real CAS overlap is tested separately.
    await holder.query("update fluid_private.naming_worker_leadership set generation=generation+1 where owner_id=$1", [OWNER_A]); await holder.query("commit");
    expect(await pending).toEqual({ result: null, code: "PT409" });
    evidence.generationAfterWait = { actualWaitObserved: true, blockers, code: "PT409", mutationScope: "controlled disposable owner-locked generation update" };
  } finally { await holder.query("rollback"); await holder.end(); await worker.end(); }
}, 30_000);

native("queues real takeover before stale dispatch and rejects paid work while keeping leased evidence readable", async () => {
  const f = await seedProgressiveFixture(db), generation = (await workerStatus(db)).generation!;
  await db.query("update public.jobs set state='queued',lease_token=null,lease_expires_at=null where id=$1", [f.job.id]);
  const claim = await maintenance<{ job: AuthorityJob }>(db, generation, "claim"); f.job.leaseToken = claim.job.lease_token;
  const request = progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot });
  await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]));
  await expireAuthority(db);
  const holder = await lockOwner(), leader = await fixture.connectWorker(), old = await fixture.connectWorker(), leadPid = await waitForLock(leader), oldPid = await waitForLock(old);
  try {
    const takeover = statusQuery(leader, "second-worker"); const leadBlockers = await waitBlocked(leadPid);
    const dispatch = old.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb) result", [f.job.id, f.job.leaseToken, JSON.stringify(request)]);
    const oldBlockers = await waitBlocked(oldPid); await holder.query("commit");
    expect((await takeover).rows[0].result).toMatchObject({ leader: true, generation: generation + 1 });
    expect((await dispatch).rows[0].result).toBe(false);
    expect(await brainWorker(db, () => f.store.loadProgressiveState(f.job))).toBeTruthy();
    expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls")).rows).toEqual([{ count: 0 }]);
    evidence.takeoverBeforeDispatch = { actualWaitOrderObserved: true, leadBlockers, oldBlockers, oldPaidDispatchRefused: true, validLeaseReadAllowed: true };
  } finally { await holder.query("rollback"); await holder.end(); await leader.end(); await old.end(); }
}, 30_000);
