import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { decodeJwt } from "jose";
import { createSharedLogoStorageAuthorization } from "../../worker/shared-storage/authorization";
import { createSharedStorageFixture, SHARED_STORAGE_ACTOR, SHARED_STORAGE_SESSION, SHARED_STORAGE_ORIGIN } from "../database/shared-storage-fixture";
import { conceptCapability } from "../database/logo-generative-storage-fixture";
function token(claims: Record<string, unknown>) { return [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url"), "fixture"].join("."); }
describe("shared Storage HTTP adapter (mock HTTP, actual disposable SQL/RLS; synthetic Auth claims)", () => {
 let f: Awaited<ReturnType<typeof createSharedStorageFixture>>;
 beforeAll(async () => { f = await createSharedStorageFixture(); }, 60_000); afterAll(async () => { await f?.close(); });
 beforeEach(async () => { await f.db.exec("begin"); await f.resetLease(); }); afterEach(async () => { await f.db.exec("rollback; set session authorization postgres"); });
 async function fixture(duplicateResponse: { status: number; body: Record<string, unknown> } = { status: 409, body: { code: "ResourceAlreadyExists", statusCode: 409 } }) {
  const p = await f.prepare(), blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  let corruptProof = false, oversized = false, redirect = false, foreignSession = false;
  const transport = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
   const url = new URL(String(raw)), headers = new Headers(init?.headers), claims = decodeJwt(headers.get("authorization")!.slice(7));
   expect(url.origin).toBe(SHARED_STORAGE_ORIGIN); expect(headers.get("apikey")).toBe("sb_publishable_fixture");
   expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit"); expect(init?.cache).toBe("no-store");
   if (redirect) { const response = Response.json({}); Object.defineProperty(response, "redirected", { value: true }); return response; }
   if (url.pathname === "/auth/v1/user") return Response.json({ id: SHARED_STORAGE_ACTOR, is_anonymous: false, email_confirmed_at: "2026-01-01T00:00:00Z" });
   if (url.pathname === "/rest/v1/rpc/authorize_shared_logo_storage") {
    const body = JSON.parse(init!.body as string);
    const result = await f.auth(async () => (await f.db.query<{ value: Record<string, unknown> }>("select public.authorize_shared_logo_storage($1,$2,$3,$4,$5,$6) value",
     [body.p_execution, body.p_execution_token, body.p_job, body.p_lease, body.p_reservation, body.p_mode])).rows[0]!.value, claims);
    return Response.json(corruptProof ? { ...result, ownerId: "11111111-1111-4111-8111-111111111111" } : result);
   }
   expect(url.pathname).toBe(`/storage/v1/object/${init?.method === "POST" ? "" : "authenticated/"}fluid-assets/${p.reservation.storagePath}`);
   if (init?.method === "POST") {
    expect(headers.get("x-upsert")).toBe("false"); expect(headers.has("authorization")).toBe(true);
    try { await f.put(p.reservation); }
    catch (error) { return (error as { code?: string }).code === "23505" ? Response.json(duplicateResponse.body, { status: duplicateResponse.status }) : Response.json({ code: "fixture_denied" }, { status: 403 }); }
    blobs.set(p.reservation.storagePath, { bytes: new Uint8Array(init.body as Uint8Array), mimeType: headers.get("content-type")! });
    return Response.json({ Id: p.reservation.reference.versionId, Key: `fluid-assets/${p.reservation.storagePath}` });
   }
   const allowed = await f.get(p.reservation, claims), blob = blobs.get(p.reservation.storagePath);
   return allowed.length && blob ? new Response(oversized ? new Uint8Array(blob.bytes.length + 1) : new Uint8Array(blob.bytes), { headers: { "content-type": `${blob.mimeType}; charset=binary` } }) : new Response(null, { status: 404 });
  });
  const authorization = createSharedLogoStorageAuthorization({ targetOrigin: SHARED_STORAGE_ORIGIN, publishableKey: "sb_publishable_fixture", slot: f.slot,
   execution: p.execution, capability: conceptCapability, session: { authUserId: SHARED_STORAGE_ACTOR, sessionId: SHARED_STORAGE_SESSION,
    async tokenProvider() { return token(f.claims(foreignSession ? { session_id: "11111111-1111-4111-8111-111111111111" } : {})); } } }, { fetch: transport });
  return { ...p, transport, authorization, scope: { job: p.job, reservation: p.reservation, publication: p.publication },
   corrupt() { corruptProof = true; }, oversize() { oversized = true; }, redirect() { redirect = true; }, foreignSession() { foreignSession = true; } };
 }
 it("uses exact SQL grants for immutable upload, duplicate replay and verified original-byte readback", async () => {
  const p = await fixture(); await p.authorization.assertAvailable(p.job); const object = await p.authorization.authorizeWrite(p.scope);
  await object.putIfAbsent(p.bytes, "image/png"); await object.putIfAbsent(p.bytes, "image/png");
  expect(await object.read()).toEqual({ bytes: new Uint8Array(p.bytes), mimeType: "image/png" });
  expect(p.transport.mock.calls.filter(([url, init]) => String(url).includes("/storage/v1/") && init?.method === "POST")).toHaveLength(2);
  p.authorization.close(); await expect(object.read()).rejects.toThrow("Shared slot Storage is unavailable");
 });
 it.each([
  { status: 400, body: { code: "KeyAlreadyExists", statusCode: "409" } },
  { status: 400, body: { error: "Duplicate", statusCode: "409", message: "The resource already exists" } },
 ])("accepts documented duplicate format $body after immutable upload and verifies the original bytes", async response => {
  const p = await fixture(response);
  try {
   const object = await p.authorization.authorizeWrite(p.scope);
   await object.putIfAbsent(p.bytes, "image/png"); await object.putIfAbsent(p.bytes, "image/png");
   expect(await object.read()).toEqual({ bytes: new Uint8Array(p.bytes), mimeType: "image/png" });
  } finally { p.authorization.close(); }
 });
 it.each([
  { status: 400, body: { error: "Duplicate", statusCode: "400" } },
  { status: 403, body: { error: "Duplicate", statusCode: "409" } },
  { status: 400, body: { error: "AccessDenied", statusCode: "409", message: "The resource already exists" } },
  { status: 400, body: { code: "AccessDenied", error: "Duplicate", statusCode: "409" } },
 ])("rejects a mismatched duplicate response $body", async response => {
  const p = await fixture(response);
  try {
   const object = await p.authorization.authorizeWrite(p.scope); await object.putIfAbsent(p.bytes, "image/png");
   await expect(object.putIfAbsent(p.bytes, "image/png")).rejects.toThrow("Shared slot Storage is unavailable");
  } finally { p.authorization.close(); }
 });
 it.each(["owner", "lease", "path", "bytes"])("refuses a forged %s before object HTTP", async defect => {
  const p = await fixture(), scope = structuredClone(p.scope);
  if (defect === "owner") scope.job.ownerId = "11111111-1111-4111-8111-111111111111";
  if (defect === "lease") scope.job.leaseToken = "11111111-1111-4111-8111-111111111111";
  if (defect === "path") scope.reservation.storagePath += "/suffix";
  if (defect === "bytes") { const object = await p.authorization.authorizeWrite(scope); await expect(object.putIfAbsent(new Uint8Array(p.bytes.length), "image/png")).rejects.toThrow(); }
  else await expect(p.authorization.authorizeWrite(scope)).rejects.toThrow();
  expect(p.transport.mock.calls.some(([url]) => String(url).includes("/storage/v1/"))).toBe(false);
 });
 it.each(["proof", "session", "redirect"])("fails closed for foreign %s without exposing private responses", async defect => {
  const p = await fixture(); if (defect === "proof") p.corrupt(); if (defect === "session") p.foreignSession(); if (defect === "redirect") p.redirect();
  await expect(p.authorization.authorizeWrite(p.scope)).rejects.toThrow("Shared slot Storage is unavailable");
  expect(p.transport.mock.calls.some(([url]) => String(url).includes("/storage/v1/"))).toBe(false);
 });
 it("bounds downloaded bytes and does not accept an overlong response", async () => {
  const p = await fixture(), object = await p.authorization.authorizeWrite(p.scope); await object.putIfAbsent(p.bytes, "image/png"); p.oversize();
  await expect(object.read()).rejects.toThrow("Shared slot Storage is unavailable");
 });
 it("permits issued-output readback after Stop while refusing another upload", async () => {
  const p = await fixture(), object = await p.authorization.authorizeWrite(p.scope); await object.putIfAbsent(p.bytes, "image/png");
  await f.owner(p.job.ownerId, () => f.db.query("select public.request_job_cancel($1)", [p.job.id]));
  expect((await object.read()).bytes).toEqual(new Uint8Array(p.bytes)); await expect(object.putIfAbsent(p.bytes, "image/png")).rejects.toThrow();
 });
 it("observes already-uploaded bytes using actual unknown job state and separate original lease, without a fake active claim", async () => {
  const p = await fixture(), object = await p.authorization.authorizeWrite(p.scope); await object.putIfAbsent(p.bytes, "image/png");
  const frozen = p.job.input as { slotId: string; attemptId: string }, key = `logo-preview-v1:${frozen.slotId}:${frozen.attemptId}`;
  await f.action(p.execution, "begin", [p.job.id, p.job.leaseToken, key, `fixture:${p.job.id}`, p.job.reservedCostMicrousd]);
  await f.action(p.execution, "complete", [p.job.id, p.job.leaseToken, key, "ambiguous", 0, JSON.stringify({ error: "provider_outcome_unknown" }), null]);
  const actualJob = { ...p.job, status: "needs_reconciliation" as const, leaseToken: null };
  const readback = await p.authorization.authorizeObservedOutput({ ...p.scope, job: actualJob, observationLeaseToken: p.execution.leaseToken });
  expect((await readback.read()).bytes).toEqual(new Uint8Array(p.bytes));
  await expect(p.authorization.authorizeWrite({ ...p.scope, job: { ...p.job, status: "needs_reconciliation" } })).rejects.toThrow();
  expect(p.transport.mock.calls.filter(([url, init]) => String(url).includes("/storage/v1/") && init?.method === "POST")).toHaveLength(1);
 });
 it("recovers only the original object after a real SQL deployment/generation takeover", async () => {
  const p = await fixture(), object = await p.authorization.authorizeWrite(p.scope);
  await object.putIfAbsent(p.bytes, "image/png");
  const admissionBefore = (await f.db.query("select to_jsonb(a) value from fluid_private.shared_job_admissions a where job_id=$1", [p.job.id])).rows;
  const frozen = p.job.input as { slotId: string; attemptId: string }, key = `logo-preview-v1:${frozen.slotId}:${frozen.attemptId}`;
  await f.action(p.execution, "begin", [p.job.id, p.job.leaseToken, key, `fixture:${p.job.id}`, p.job.reservedCostMicrousd]);
  await f.action(p.execution, "complete", [p.job.id, p.job.leaseToken, key, "ambiguous", 0, JSON.stringify({ error: "publication_unknown" }), null]);
  await f.takeover("dpl_corrected_storage_fixture");
  const actualJob = { ...p.job, status: "needs_reconciliation" as const, leaseToken: null };
  const reader = await p.authorization.authorizeObservedOutput({ ...p.scope, job: actualJob, observationLeaseToken: p.execution.leaseToken });
  expect((await reader.read()).bytes).toEqual(new Uint8Array(p.bytes));
  expect((await f.db.query("select to_jsonb(a) value from fluid_private.shared_job_admissions a where job_id=$1", [p.job.id])).rows).toEqual(admissionBefore);
  expect((await f.db.query("select state from public.job_steps where job_id=$1", [p.job.id])).rows).toEqual([{ state: "ambiguous" }]);
  expect((await f.db.query("select count(*)::int n from public.logo_raster_results where job_id=$1", [p.job.id])).rows).toEqual([{ n: 0 }]);
  // @ts-expect-error An observation-only job has no active lease and must be refused by the write entrypoint.
  await expect(p.authorization.authorizeWrite({ ...p.scope, job: actualJob })).rejects.toThrow();
  expect(p.transport.mock.calls.filter(([url, init]) => String(url).includes("/storage/v1/") && init?.method === "POST")).toHaveLength(1);
 });

});
