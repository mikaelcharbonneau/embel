import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedStorageFixture, SHARED_STORAGE_ACTOR, SHARED_STORAGE_SESSION, OWNER_A, OWNER_B } from "./shared-storage-fixture";
import { logoCapabilitiesSchema } from "../../src/domain/logo-capabilities";
import { qualifySharedStoragePolicies } from "../../src/server/runtime/shared-storage-policy-qualification";
describe("shared fixed-slot Storage (synthetic Auth claims; real disposable SQL/RLS, no live services)", () => {
 let f: Awaited<ReturnType<typeof createSharedStorageFixture>>;
 beforeAll(async () => { f = await createSharedStorageFixture(); }, 60_000);
 afterAll(async () => { await f?.close(); });
 beforeEach(async () => { await f.db.exec("begin"); await f.resetLease(); }); afterEach(async () => { await f.db.exec("rollback; set session authorization postgres"); });
 it("qualifies both Storage fences as the actual restricted slot without private-schema access or proof RPC", async () => {
  await f.db.exec(`set session authorization ${f.roleName}`);
  try {
   expect((await f.db.query<{ allowed: boolean }>("select has_schema_privilege(session_user,'fluid_private','USAGE') allowed")).rows[0]!.allowed).toBe(false);
   const calls: string[] = [];
   await qualifySharedStoragePolicies({ query(sql) { calls.push(sql); return f.db.query(sql); } });
   expect(calls).toHaveLength(1); expect(calls[0]).toContain("WITH shared_storage_required");
  } finally { await f.db.exec("set session authorization postgres"); }
 });
 it("installs no enabled identity and denies private table/function privileges to arbitrary default grantees", async () => {
  // Only this explicit fixture seeds one finite slot/actor, not the candidate.
  for (const role of ["authenticated", "anon", "service_role", "fixture_production_acl_probe", f.roleName]) {
   expect((await f.db.query<{ ok: boolean }>("select has_table_privilege($1,'fluid_private.shared_storage_grants','SELECT,INSERT,UPDATE,DELETE') ok", [role])).rows[0]!.ok).toBe(false);
   expect((await f.db.query<{ ok: boolean }>("select has_function_privilege($1,'fluid_private.shared_storage_auth_context()','EXECUTE') ok", [role])).rows[0]!.ok).toBe(false);
  }
 });
 it("derives exact owner/job/lease/reservation/path from actual shared claim, then permits create-only output and readback", async () => {
  const p = await f.prepare(); const proof = await f.grant(p.execution, p.reservation, "write");
  expect(proof).toMatchObject({ ownerId: OWNER_A, authUserId: SHARED_STORAGE_ACTOR, sessionId: SHARED_STORAGE_SESSION, execution: p.execution, member: "output", reservation: p.reservation });
  await f.put(p.reservation); expect(await f.get(p.reservation)).toHaveLength(1);
  await expect(f.put(p.reservation)).rejects.toBeDefined();
 });
 it.each(["session", "actor", "issuer", "expiry"])("denies forged %s claims despite correct public IDs", async defect => {
  const p = await f.prepare(); const bad = defect === "session" ? { session_id: "11111111-1111-4111-8111-111111111111" }
   : defect === "actor" ? { sub: OWNER_A } : defect === "issuer" ? { iss: "https://other.example/auth/v1" } : { exp: 1 };
  await expect(f.grant(p.execution, p.reservation, "write", bad)).rejects.toBeDefined();
 });
 it("does not turn an unbound/disabled service actor into an ordinary customer Storage principal", async () => {
  const p = await f.prepare(); await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation);
  await f.db.query("update fluid_private.shared_storage_actors set enabled=false where auth_user_id=$1", [SHARED_STORAGE_ACTOR]);
  expect(await f.get(p.reservation)).toEqual([]); await expect(f.put({ ...p.reservation, storagePath: `${SHARED_STORAGE_ACTOR}/${p.job.projectId}/${p.reservation.reference.assetId}/${p.reservation.reference.versionId}` })).rejects.toBeDefined();
  await f.db.exec("delete from fluid_private.shared_storage_grants"); await f.db.query("delete from fluid_private.shared_storage_actors where auth_user_id=$1", [SHARED_STORAGE_ACTOR]);
  const ordinaryFallback = { ...p.reservation, storagePath: `${SHARED_STORAGE_ACTOR}/${p.job.projectId}/${p.reservation.reference.assetId}/${p.reservation.reference.versionId}` };
  await f.db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [ordinaryFallback.storagePath, SHARED_STORAGE_ACTOR]);
  // The fixture's ordinary owner_id policy would allow this row without the
  // persistent service-identity classification, even after actor-map removal.
  expect(await f.get(ordinaryFallback)).toEqual([]);
 });
 it("rejects wrong execution token/lease/reservation and forbids update/delete/list/sign operations", async () => {
  const p = await f.prepare();
  await expect(f.grant({ ...p.execution, executionToken: "11111111-1111-4111-8111-111111111111" }, p.reservation, "write")).rejects.toBeDefined();
  await expect(f.grant({ ...p.execution, leaseToken: "11111111-1111-4111-8111-111111111111" }, p.reservation, "write")).rejects.toBeDefined();
  await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation);
  for (const operation of ["object.list", "object.sign", "object.update", "object.delete"]) {
   expect(await f.object(operation, async () => (await f.db.query("select name from storage.objects")).rows)).toEqual([]);
  }
  expect((await f.object("object.update", () => f.db.query("update storage.objects set name=name returning name"))).rows).toEqual([]);
  expect((await f.object("object.delete", () => f.db.query("delete from storage.objects returning name"))).rows).toEqual([]);
 });
 it("denies every new write after Stop and allows only issued immutable output observation", async () => {
  const p = await f.prepare(); await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation);
  await f.owner(OWNER_A, () => f.db.query("select public.request_job_cancel($1)", [p.job.id]));
  await expect(f.grant(p.execution, p.reservation, "write")).rejects.toBeDefined();
  expect(await f.get(p.reservation)).toEqual([]);
  await f.grant(p.execution, p.reservation, "observe"); expect(await f.get(p.reservation)).toHaveLength(1);
  await expect(f.put(p.reservation)).rejects.toBeDefined();
 });
 it("fences old generation writes after takeover, without granting arbitrary observation objects", async () => {
  const p = await f.prepare(); await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation); await f.takeover();
  await expect(f.grant(p.execution, p.reservation, "write")).rejects.toBeDefined();
  await f.grant(p.execution, p.reservation, "observe"); expect(await f.get(p.reservation)).toHaveLength(1);
  await expect(f.grant(p.execution, { ...p.reservation, id: "11111111-1111-4111-8111-111111111111" }, "observe")).rejects.toBeDefined();
  await expect(f.put(p.reservation)).rejects.toBeDefined();
 });
 it("returns actual readonly heartbeat state after takeover without extending the old job lease", async () => {
  const p = await f.prepare(); await f.takeover();
  const before = (await f.db.query("select lease_expires_at,state,lease_token from public.jobs where id=$1", [p.job.id])).rows;
  const reply = await f.action(p.execution, "heartbeat", [p.job.id, p.job.leaseToken, 120], p.slot);
  expect((reply.result as { state: string }[])[0]!.state).toBe("running");
  expect((await f.db.query("select lease_expires_at,state,lease_token from public.jobs where id=$1", [p.job.id])).rows).toEqual(before);
 });
 it("revokes Storage use immediately when the actual Auth session disappears", async () => {
  const p = await f.prepare(); await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation);
  await f.db.query("delete from auth.sessions where id=$1", [SHARED_STORAGE_SESSION]);
  expect(await f.get(p.reservation)).toEqual([]); expect((await f.db.query("select count(*)::int n from fluid_private.shared_storage_grants")).rows).toEqual([{ n: 1 }]);
 });
 it("reuses one physical slot/actor for two customers without retaining the first owner's authority", async () => {
  const a = await f.prepare(OWNER_A); await f.grant(a.execution, a.reservation, "write"); await f.put(a.reservation); await f.complete(a);
  expect((await f.owner(OWNER_A, () => f.db.query("select name from storage.objects where name=$1", [a.reservation.storagePath]))).rows).toHaveLength(1);
  expect((await f.owner(OWNER_B, () => f.db.query("select name from storage.objects where name=$1", [a.reservation.storagePath]))).rows).toEqual([]);
  const b = await f.prepare(OWNER_B); expect(b.execution.slotId).toBe(a.execution.slotId); expect(b.execution.ownerId).toBe(OWNER_B);
  await f.grant(b.execution, b.reservation, "write"); await f.put(b.reservation);
  await expect(f.grant(a.execution, a.reservation, "write")).rejects.toBeDefined();
  await expect(f.grant(b.execution, a.reservation, "read")).rejects.toBeDefined();
 });
 it("denies committed Logo history to banned or logged-out customer JWTs and restores it only with a fresh live session", async () => {
  const p = await f.prepare(); await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation); await f.complete(p);
  const read = () => f.owner(OWNER_A, async () => (await f.db.query("select name from storage.objects where name=$1", [p.reservation.storagePath])).rows);
  expect(await read()).toHaveLength(1);
  await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]); expect(await read()).toEqual([]);
  await f.db.query("update auth.users set banned_until=null where id=$1", [OWNER_A]);
  const original = f.customerSessions[OWNER_A]!; await f.db.query("delete from auth.sessions where id=$1", [original]); expect(await read()).toEqual([]);
  const fresh = randomUUID(); await f.db.query("insert into auth.sessions(id,user_id) values($1,$2)", [fresh, OWNER_A]); f.customerSessions[OWNER_A] = fresh;
  try { expect(await read()).toHaveLength(1); } finally { f.customerSessions[OWNER_A] = original; }
 });
 it("parks actual unknown output without blocking another tenant, while preserving only immutable issued readback", async () => {
  const a = await f.prepare(OWNER_A); await f.grant(a.execution, a.reservation, "write"); await f.put(a.reservation);
  const frozen = a.job.input as { slotId: string; attemptId: string }, key = `logo-preview-v1:${frozen.slotId}:${frozen.attemptId}`;
  await f.action(a.execution, "begin", [a.job.id, a.job.leaseToken, key, `synthetic:${a.job.id}`, a.job.reservedCostMicrousd]);
  await f.action(a.execution, "complete", [a.job.id, a.job.leaseToken, key, "ambiguous", 0, JSON.stringify({ error: "provider_outcome_unknown" }), null]);
  expect((await f.db.query("select state from fluid_private.shared_worker_executions where execution_id=$1", [a.execution.executionId])).rows).toEqual([{ state: "observing" }]);
  const b = await f.prepare(OWNER_B); expect(b.execution.ownerId).toBe(OWNER_B); await f.grant(b.execution, b.reservation, "write");
  await expect(f.grant(a.execution, a.reservation, "write")).rejects.toBeDefined();
  await f.grant(a.execution, a.reservation, "observe"); expect(await f.get(a.reservation)).toHaveLength(1);
 });
 it("does not revive a pre-ban admission or Storage write grant after customer unban", async () => {
  const p = await f.prepare(); await f.grant(p.execution, p.reservation, "write");
  await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [OWNER_A]);
  await f.db.query("update auth.users set banned_until=null where id=$1", [OWNER_A]);
  await expect(f.grant(p.execution, p.reservation, "write")).rejects.toBeDefined(); await expect(f.put(p.reservation)).rejects.toBeDefined();
 });
 it("requires physical session and usable refresh-token absence for cleanup, independently of slot expiry", async () => {
  const closed = () => f.auth(async () => (await f.db.query<{ value: boolean }>("select public.shared_logo_storage_session_closed() value")).rows[0]!.value);
  expect(await closed()).toBe(false); await f.db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1", [f.slotId]);
  expect(await closed()).toBe(false); await f.db.query("delete from auth.sessions where id=$1", [SHARED_STORAGE_SESSION]);
  await f.db.query("insert into auth.refresh_tokens(session_id,user_id,revoked) values($1,$2,false)", [SHARED_STORAGE_SESSION, SHARED_STORAGE_ACTOR]);
  expect(await closed()).toBe(false); await f.db.query("update auth.refresh_tokens set revoked=true where session_id=$1", [SHARED_STORAGE_SESSION]);
  expect(await closed()).toBe(true);
 });
 it("projects supported shared readiness without per-owner heartbeats or read-time policy creation", async () => {
  const w = await f.project(), before = (await f.db.query("select count(*)::int n from fluid_private.logo_runtime_policies where owner_id=$1", [OWNER_A])).rows;
  const cap = logoCapabilitiesSchema.parse(await f.owner(OWNER_A, async () => (await f.db.query<{ value: unknown }>("select public.shared_logo_operation($1,'capabilities',null) value", [w.projectId])).rows[0]!.value));
  expect(cap.operations["identity.logo_concept"].status).toBe("available"); expect(cap.operations["identity.logo_refine"].status).toBe("available");
  for (const key of ["identity.logo_vectorize", "identity.logo_directions", "identity.logo_export", "identity.logo_vector_propose"] as const) expect(cap.operations[key]?.status).toBe("unavailable");
  expect((await f.db.query("select count(*)::int n from fluid_private.logo_runtime_policies where owner_id=$1", [OWNER_A])).rows).toEqual(before);
 });
 it("recovers only existing issued output and appends readback evidence without rewriting unknown provider history", async () => {
  const a = await f.prepare(); await f.grant(a.execution, a.reservation, "write"); await f.put(a.reservation);
  const frozen = a.job.input as { slotId: string; attemptId: string }, key = `logo-preview-v1:${frozen.slotId}:${frozen.attemptId}`;
  await f.action(a.execution, "begin", [a.job.id, a.job.leaseToken, key, `synthetic:${a.job.id}`, a.job.reservedCostMicrousd]);
  await f.action(a.execution, "complete", [a.job.id, a.job.leaseToken, key, "ambiguous", 0, JSON.stringify({ error: "provider_outcome_unknown" }), null]);
  const recovery = (await f.action(a.execution, "recovery", [])).result as { observationJob: { state: string; lease_token: string | null }; observationLeaseToken: string; outputs: unknown[] };
  expect(recovery.observationJob).toMatchObject({ state: "needs_reconciliation", lease_token: null }); expect(recovery.observationLeaseToken).toBe(a.execution.leaseToken);
  expect(recovery.outputs).toEqual([{ reservation: a.reservation, publication: a.publication }]);
  const verification = { status: "verified", checkedAt: new Date().toISOString(), contentHash: a.publication.contentHash, mimeType: "image/png", byteLength: a.bytes.length };
  await expect(f.action(a.execution, "observe_recovered_asset", [a.execution.leaseToken, a.reservation.id, { ...verification, contentHash: "f".repeat(64) }])).rejects.toBeDefined();
  expect((await f.action(a.execution, "observe_recovered_asset", [a.execution.leaseToken, a.reservation.id, verification])).result).toMatchObject({ status: "observed_only", providerOutcome: "retained_unknown" });
  await f.action(a.execution, "observe_recovered_asset", [a.execution.leaseToken, a.reservation.id, { ...verification, checkedAt: new Date(Date.now() + 1).toISOString() }]);
  expect((await f.db.query("select state,actual_cost_microusd from public.jobs where id=$1", [a.job.id])).rows).toEqual([{ state: "needs_reconciliation", actual_cost_microusd: 0 }]);
  expect((await f.db.query("select state from public.job_steps where job_id=$1", [a.job.id])).rows).toEqual([{ state: "ambiguous" }]);
  expect((await f.db.query("select count(*)::int n from fluid_private.shared_logo_output_observations")).rows).toEqual([{ n: 1 }]);
  expect((await f.action(a.execution, "finish_known", [])).result).toEqual({ status: "retained_unknown" });
 });
 it("does not invent output recovery authority when no write was issued", async () => {
  const p = await f.prepare(), result = (await f.action(p.execution, "recovery", [])).result as { outputs: unknown[] }; expect(result.outputs).toEqual([]);
  await expect(f.action(p.execution, "observe_recovered_asset", [p.execution.leaseToken, p.reservation.id, { status: "verified", checkedAt: new Date().toISOString(),
   contentHash: p.publication.contentHash, mimeType: "image/png", byteLength: p.bytes.length }])).rejects.toBeDefined();
 });
 it("recovers a known completed step and acknowledges closed terminal state without reopening mutation authority", async () => {
  const p = await f.prepare(); await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation); await f.complete(p, false);
  expect((await f.action(p.execution, "recovery", [])).result).toMatchObject({ executionClosed: false, observationJob: { state: "running" } });
  expect((await f.action(p.execution, "finish_known", [])).result).toEqual({ status: "terminal", state: "succeeded" });
  // Model a missing acknowledgement by ignoring that reply, then read the
  // actual terminal ledger; no finish/provider mutation is replayed.
  expect((await f.action(p.execution, "recovery", [])).result).toMatchObject({ executionClosed: true, observationJob: { state: "succeeded", lease_token: null }, outputs: [] });
  await expect(f.action(p.execution, "finish", [p.job.id, p.job.leaseToken, "succeeded"])).rejects.toBeDefined();
  await expect(f.action({ ...p.execution, executionToken: "11111111-1111-4111-8111-111111111111" }, "recovery", [])).rejects.toBeDefined();
 });
});
