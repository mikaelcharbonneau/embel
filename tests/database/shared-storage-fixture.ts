import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTestDatabase, OWNER_A, OWNER_B } from "./local-supabase";
import { installGenerativeStorageFixture, conceptCapability } from "./logo-generative-storage-fixture";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from "../../src/domain/logo-jobs";
import { sharedExecutionSchema, sharedSlotLeaseSchema, type SharedExecution } from "../../worker/shared-pool/contracts";
import { parseClaimedJob } from "../../worker/postgres-store";
import { digestBytes, syntheticPng } from "../features/logo-vector/raster-fixtures";
import type { IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import type { IdentityAssetPublication } from "../../src/domain/logo-deliverables";

export { OWNER_A, OWNER_B };
export const SHARED_STORAGE_ACTOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const SHARED_STORAGE_SESSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const SHARED_STORAGE_ORIGIN = "http://127.0.0.1:54321";
/** Disposable SQL only. Auth claims/sessions, role installation and PNG bytes
 * are SYNTHETIC. This is real SQL/RLS execution, not live Auth/Storage proof. */
export async function createSharedStorageFixture() {
 const db = await createTestDatabase();
 try {
  await installGenerativeStorageFixture(db);
  for (const name of ["candidates/logo_local_concepts.sql", "activation/logo_concepts_50_publication_adjudication.sql", "candidates/logo_local_refinements.sql"])
   await db.exec(await readFile(new URL(`../../supabase/${name}`, import.meta.url), "utf8"));
  await db.exec("alter table auth.users add column email_confirmed_at timestamptz; alter table auth.users add column banned_until timestamptz; alter table auth.users add column deleted_at timestamptz");
  await db.exec("create table auth.refresh_tokens(session_id uuid,user_id text not null,revoked boolean not null default false)");
  for (const name of ["identity_transactions.sql", "shared_worker_pool.sql", "shared_account_http.sql", "shared_worker_logo.sql", "shared_storage_authority.sql"])
   await db.exec(await readFile(new URL(`../../supabase/candidates/${name}`, import.meta.url), "utf8"));
  const slotId = randomUUID(), roleName = "embel_shared_logo_storage_fixture", deploymentId = "dpl_shared_storage_fixture";
  await db.exec(`create role ${roleName} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
   grant usage on schema public to ${roleName};
   grant execute on function public.claim_shared_worker_slot(uuid,uuid,text,integer),public.renew_shared_worker_slot(jsonb,integer),public.shared_logo_worker_action(jsonb,jsonb,text,jsonb) to ${roleName}`);
  await db.query("insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled) select $1,'logo',1,rolname,oid,$2,true from pg_roles where rolname=$3", [slotId, deploymentId, roleName]);
  const refinementCapability = { ...conceptCapability, operation: "identity.logo_refine" };
  for (const cap of [conceptCapability, refinementCapability]) await db.query("insert into fluid_private.shared_worker_policies values($1,$2,$3,$4)", [slotId, cap.operation, cap.policyIdentity, cap]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp()),($2,clock_timestamp())", [OWNER_A, OWNER_B]);
  const customerSessions: Record<string, string> = { [OWNER_A]: randomUUID(), [OWNER_B]: randomUUID() };
  for (const ownerId of [OWNER_A, OWNER_B]) await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [customerSessions[ownerId], ownerId]);
  await db.query("insert into fluid_private.shared_http_target values(true,'development',$1)", [SHARED_STORAGE_ORIGIN]);
  await db.query("insert into fluid_private.shared_service_actors values($1,'logo_storage')", [SHARED_STORAGE_ACTOR]);
  await db.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp())", [SHARED_STORAGE_ACTOR]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [SHARED_STORAGE_SESSION, SHARED_STORAGE_ACTOR]);
  await db.query("insert into fluid_private.shared_storage_target values(true,$1)", [SHARED_STORAGE_ORIGIN]);
  await db.query("insert into fluid_private.shared_storage_actors(auth_user_id,slot_id,enabled) values($1,$2,true)", [SHARED_STORAGE_ACTOR, slotId]);
  async function scoped<T>(role: string, run: () => Promise<T>, claims: Record<string, unknown> = {}) {
   const outer = !db.isInTransaction(); if (outer) await db.exec("begin");
   await db.exec("savepoint shared_storage_call");
   await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [String(claims.sub ?? ""), JSON.stringify(claims)]);
   await db.exec(`set session authorization ${role}`);
   try { const result = await run(); await db.exec("set session authorization postgres; release savepoint shared_storage_call"); if (outer) await db.exec("commit"); return result; }
   catch (error) { await db.exec("rollback to savepoint shared_storage_call; set session authorization postgres; release savepoint shared_storage_call"); if (outer) await db.exec("rollback"); throw error; }
  }
  async function owner<T>(ownerId: string, run: () => Promise<T>) { return scoped("authenticated", run, claims({ sub: ownerId, session_id: customerSessions[ownerId] })); }
  function claims(overrides: Record<string, unknown> = {}) { return { sub: SHARED_STORAGE_ACTOR, session_id: SHARED_STORAGE_SESSION, role: "authenticated", aud: "authenticated",
   iss: `${SHARED_STORAGE_ORIGIN}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false, ...overrides }; }
  const auth = <T>(run: () => Promise<T>, overrides: Record<string, unknown> = {}) => scoped("authenticated", run, claims(overrides));
  const slot = () => lease;
  let lease = sharedSlotLeaseSchema.parse(await scoped(roleName, async () => (await db.query<{ value: unknown }>("select public.claim_shared_worker_slot($1,$2,$3,120) value", [slotId, randomUUID(), deploymentId])).rows[0]!.value));
  const verifySession = () => auth(async () => (await db.query<{ value: unknown }>("select public.shared_logo_storage_session() value")).rows[0]!.value);
  await verifySession();
  async function takeover(nextDeployment = deploymentId) {
   await db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second',deployment_id=$2 where slot_id=$1", [slotId,nextDeployment]);
   lease = sharedSlotLeaseSchema.parse(await scoped(roleName, async () => (await db.query<{ value: unknown }>("select public.claim_shared_worker_slot($1,$2,$3,120) value", [slotId, randomUUID(), nextDeployment])).rows[0]!.value));
   await verifySession(); return lease;
  }
  async function action(execution: SharedExecution | null, name: string, args: unknown[], captured = lease) {
   return scoped(roleName, async () => (await db.query<{ value: { execution: unknown; result: unknown } }>("select public.shared_logo_worker_action($1,$2,$3,$4) value", [captured, execution, name, JSON.stringify(args)])).rows[0]!.value);
  }
  async function project(ownerId = OWNER_A) {
   return owner(ownerId, async () => logoWorkspaceV2Schema.parse((await db.query<{ value: unknown }>("select public.start_logo_project($1) value", [{ requestKey: randomUUID(), brief: {
    name: "Synthetic shared Storage", activity: "Isolated SQL tests", audience: "Testers", personality: "Calm", logoTypes: ["wordmark"] } }])).rows[0]!.value));
  }
  async function prepare(ownerId = OWNER_A) {
   const workspace = await project(ownerId), snapshot = (await db.query<{ id: string }>("select reference_snapshot_id id from public.logo_stage_revisions where id=$1", [workspace.stages.brief_references!.id])).rows[0]!.id;
   const quote = await owner(ownerId, async () => logoCostQuoteSchema.parse((await db.query<{ value: unknown }>("select public.shared_logo_operation($1,'quote',$2) value", [workspace.projectId, {
    operation: "concepts", expected: workspace.heads, briefRevisionId: workspace.stages.brief_references!.id, referenceSnapshotId: snapshot }])).rows[0]!.value));
   const request = { requestKey: randomUUID(), quoteId: quote.id, expected: workspace.heads };
   const admitted = await owner(ownerId, async () => logoDispatchReceiptSchema.parse((await db.query<{ value: unknown }>("select public.shared_logo_operation($1,'admit',$2) value", [workspace.projectId, request])).rows[0]!.value));
   const claimed = await action(null, "claim", ["synthetic-shared-logo", 120]), execution = sharedExecutionSchema.parse(claimed.execution);
   const job = parseClaimedJob((claimed.result as unknown[])[0]);
   if (job.ownerId !== ownerId || !admitted.jobIds.includes(job.id)) throw Error("Unexpected shared fixture job");
   for (const id of admitted.jobIds.filter(id => id !== job.id)) await owner(ownerId, () => db.query("select public.request_job_cancel($1)", [id]));
   const inputRevisions = (await action(execution, "read", [job.id, job.leaseToken, "input_revisions", null])).result as IdentityAssetPublication["inputRevisions"];
   const bytes = syntheticPng(8, 8, (x, y) => [x * 21, y * 22, 137, 255]);
   const sourceId = (job.input as { attemptId: string }).attemptId;
   const publication: IdentityAssetPublication = { requestKey: sourceId, source: { kind: "concept", sourceId }, inputRevisions,
    mimeType: "image/png", contentHash: digestBytes(bytes), byteLength: bytes.byteLength };
   const reservation = (await action(execution, "prepare_asset", [job.projectId, JSON.stringify({ kind: "stage", publication }), job.id, job.leaseToken])).result as IdentityAssetReservation;
   return { workspace, request, admitted, execution, job, reservation, publication, bytes, slot: { ...lease } };
  }
  async function grant(execution: SharedExecution, reservation: IdentityAssetReservation | null, mode: string, overrides: Record<string, unknown> = {}) {
   return auth(async () => (await db.query<{ value: unknown }>("select public.authorize_shared_logo_storage($1,$2,$3,$4,$5,$6) value",
    [execution.executionId, execution.executionToken, execution.jobId, execution.leaseToken, reservation?.id ?? null, mode])).rows[0]!.value, overrides);
  }
  async function object<T>(operation: string, run: () => Promise<T>, overrides: Record<string, unknown> = {}) {
   await db.query("select set_config('storage.operation',$1,false)", [operation]); return auth(run, overrides);
  }
  const put = (r: IdentityAssetReservation) => object("object.upload", () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [r.storagePath, SHARED_STORAGE_ACTOR]));
  const get = (r: IdentityAssetReservation, overrides: Record<string, unknown> = {}) => object("object.get_authenticated", async () => (await db.query("select name from storage.objects where name=$1", [r.storagePath])).rows, overrides);
  async function complete(p: Awaited<ReturnType<typeof prepare>>, finish = true) {
   const frozen = p.job.input as { batchId: string; slotId: string; attemptId: string }, key = `logo-preview-v1:${frozen.slotId}:${frozen.attemptId}`;
   await action(p.execution, "begin", [p.job.id, p.job.leaseToken, key, `fixture:${p.job.id}`, p.job.reservedCostMicrousd]);
   await action(p.execution, "observe_asset", [p.reservation.id, JSON.stringify({ status: "verified", checkedAt: new Date().toISOString(),
    contentHash: p.publication.contentHash, mimeType: "image/png", byteLength: p.bytes.byteLength }), p.job.id, p.job.leaseToken]);
   const provider = (await action(p.execution, "receipt", [p.job.id, p.job.leaseToken, JSON.stringify({ provider: "openai", model: conceptCapability.model,
    providerRequestId: `synthetic-${p.job.id}`, responseHash: "a".repeat(64), observedAt: new Date().toISOString(), billing: { status: "recorded", confirmedMicrousd: 1 },
    artifactHash: p.publication.contentHash, normalizedPixelHash: "b".repeat(64) })])).result as { id: string };
   await action(p.execution, "complete", [p.job.id, p.job.leaseToken, key, "succeeded", 1, JSON.stringify({ version: 2, kind: "logo_concept", batchId: frozen.batchId,
    slotId: frozen.slotId, attemptId: frozen.attemptId, publicationId: p.reservation.id, providerResponseReceiptId: provider.id }), `synthetic-${p.job.id}`]);
   if (finish) await action(p.execution, "finish", [p.job.id, p.job.leaseToken, "succeeded"]);
  }
  async function resetLease() { lease = sharedSlotLeaseSchema.parse((await db.query<{ value: unknown }>("select fluid_private.shared_worker_slot_json(s) value from fluid_private.shared_worker_slots s where slot_id=$1", [slotId])).rows[0]!.value); }
  return { db, roleName, slotId, slot, action, owner, auth, claims, customerSessions, project, prepare, grant, put, get, object, verifySession, takeover, resetLease, complete,
   async close() { await db.exec("set session authorization postgres"); await db.close(); } };
 } catch (error) { await db.close(); throw error; }
}
export type SharedStorageFixture = Awaited<ReturnType<typeof createSharedStorageFixture>>;
