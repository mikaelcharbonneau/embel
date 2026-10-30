import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readFile } from "node:fs/promises";
import { createSharedAdvancedLogoFixture, type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { OWNER_A, OWNER_B } from "./local-supabase";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { logoCostQuoteSchema, logoConceptJobInputSchema, logoRefinementJobInputSchema } from "../../src/domain/logo-jobs";
import { sharedExecutionSchema } from "../../worker/shared-pool/contracts";
import { parseClaimedJob } from "../../worker/postgres-store";

/** Real disposable SQL execution; synthetic Auth, Storage and provider evidence.
 * Costs below are fixture evidence, never actual provider use or charges. */
describe("uncapped shared Logo rasters", () => {
 let f: SharedAdvancedLogoFixture;
 const capability = { operation: "identity.logo_concept", policyIdentity: "a5".repeat(32), handlerVersion: "logo-image-v1", provider: "openai", model: IMAGE_MODEL,
  engine: null, spendControl: "uncapped", estimatedCostMicrousd: 1 };
 beforeAll(async () => {
  f = await createSharedAdvancedLogoFixture();
  await f.db.exec(await readFile(new URL("../../supabase/candidates/shared_logo_raster_uncapped.sql", import.meta.url), "utf8"));
  for (const operation of ["identity.logo_concept", "identity.logo_refine"]) {
   const policy = { ...capability, operation, policyIdentity: operation === "identity.logo_concept" ? capability.policyIdentity : "b5".repeat(32) };
   await f.db.query("update fluid_private.shared_worker_policies set policy_identity=$2,policy=$3 where slot_id=$1 and operation=$4", [f.slotId, policy.policyIdentity, policy, operation]);
  }
  await f.runtimeReady();
 }, 90_000);
 afterAll(async () => { await f?.close(); });

 it("quotes six concepts without a monetary ceiling and admits once with a zero allowance", async () => {
  const p = await f.prepare();
  const quote = logoCostQuoteSchema.parse((await f.db.query<{ record: unknown }>("select record from public.logo_cost_quotes where id=$1", [p.request.quoteId])).rows[0]!.record);
  expect(quote).toMatchObject({ version: 3, spendControl: "uncapped", estimatedCostMicrousd: 6 });
  expect(quote).not.toHaveProperty("maxCostMicrousd");
  expect(p.admitted.jobIds).toHaveLength(6);
  expect(p.job.reservedCostMicrousd).toBe(0);
  expect(logoConceptJobInputSchema.parse(p.job.input)).toMatchObject({ version: 3, spendControl: "uncapped" });
  const replay = await f.owner(OWNER_A, async () => (await f.db.query<{ value: unknown }>("select public.shared_logo_operation($1,'admit',$2) value", [p.workspace.projectId, p.request])).rows[0]!.value);
  expect(replay).toEqual(p.admitted);
  await expect(f.owner(OWNER_A, () => f.db.query("select public.shared_logo_operation($1,'admit',$2)", [p.workspace.projectId, { ...p.request, expected: { ...p.request.expected, projectRevision: p.request.expected.projectRevision + 1 } }]))).rejects.toMatchObject({ code: "PT409" });
  await expect(f.owner(OWNER_B, () => f.db.query("select public.shared_logo_operation($1,'admit',$2)", [p.workspace.projectId, p.request]))).rejects.toMatchObject({ code: "P0002" });
  await f.owner(OWNER_A, () => f.db.query("select public.request_job_cancel($1)", [p.job.id]));
  await f.action(p.execution, "finish", [p.job.id, p.job.leaseToken, "cancelled"]);
 });

 it("publishes a valid concept above the estimate and records the real expense exactly once", async () => {
  const p = await f.prepare(), frozen = logoConceptJobInputSchema.parse(p.job.input), key = `logo-preview-v1:${frozen.slotId}:${frozen.attemptId}`;
  const cost = 25_000_000;
  await f.action(p.execution, "begin", [p.job.id, p.job.leaseToken, key, `fixture:${p.job.id}`, 0]);
  const observation = { provider: "openai", model: IMAGE_MODEL, providerRequestId: `synthetic-${p.job.id}`, responseHash: "a".repeat(64), observedAt: new Date().toISOString(),
   billing: { status: "recorded", confirmedMicrousd: cost }, artifactHash: p.publication.contentHash, normalizedPixelHash: "b".repeat(64) };
  const receipt = (await f.action(p.execution, "receipt", [p.job.id, p.job.leaseToken, JSON.stringify(observation)])).result as { id: string };
  expect((await f.action(p.execution, "receipt", [p.job.id, p.job.leaseToken, JSON.stringify(observation)])).result).toEqual(receipt);
  await expect(f.action(p.execution, "receipt", [p.job.id, p.job.leaseToken, JSON.stringify({ ...observation, billing: { status: "recorded", confirmedMicrousd: 0 } })])).rejects.toMatchObject({ code: "PT409" });
  await expect(f.action({ ...p.execution, ownerId: OWNER_B }, "read", [p.job.id, p.job.leaseToken, "concept_inputs", null])).rejects.toMatchObject({ code: "42501" });
  await f.grant(p.execution, p.reservation, "write"); await f.put(p.reservation);
  await f.action(p.execution, "observe_asset", [p.reservation.id, JSON.stringify({ status: "verified", checkedAt: new Date().toISOString(), contentHash: p.publication.contentHash, mimeType: "image/png", byteLength: p.bytes.byteLength }), p.job.id, p.job.leaseToken]);
  await f.action(p.execution, "complete", [p.job.id, p.job.leaseToken, key, "succeeded", cost, JSON.stringify({ version: 2, kind: "logo_concept", batchId: frozen.batchId,
   slotId: frozen.slotId, attemptId: frozen.attemptId, publicationId: p.reservation.id, providerResponseReceiptId: receipt.id }), observation.providerRequestId]);
  await f.action(p.execution, "finish", [p.job.id, p.job.leaseToken, "succeeded"]);
  expect(await f.rawJob(p.job.id)).toMatchObject({ state: "succeeded", actual_cost_microusd: cost });
  const ledger = (await f.db.query<{ actual: number; captured: number; reserved: number; state: string; allowance: number; provider: number }>(`select r.actual_microusd actual,r.captured_microusd captured,r.reserved_microusd reserved,r.state,a.limit_microusd allowance,a.provider_actual_microusd provider
   from public.usage_reservations r join public.usage_accounts a on a.owner_id=r.owner_id where job_id=$1`, [p.job.id])).rows[0]!;
  expect(ledger).toEqual({ actual: cost, captured: 0, reserved: 0, state: "settled", allowance: 0, provider: cost });
  expect((await f.db.query<{ state: string }>("select state from public.logo_asset_publications where id=$1", [p.reservation.id])).rows[0]!.state).toBe("committed");

  // The saved concept can be refined through the same uncapped contract.
  const workspace = (await f.owner(OWNER_A, () => f.db.query<{ value: { heads: unknown } }>("select public.get_logo_workspace($1) value", [p.workspace.projectId]))).rows[0]!.value;
  const quote = logoCostQuoteSchema.parse((await f.owner(OWNER_A, () => f.db.query<{ value: unknown }>("select public.shared_logo_operation($1,'quote',$2) value", [p.workspace.projectId,
   { operation: "refine_preview", expected: workspace.heads, source: { kind: "concept", batchId: frozen.batchId, slotId: frozen.slotId, attemptId: frozen.attemptId }, instruction: "Make the symbol rounder" }]))).rows[0]!.value);
  const refined = await f.admitAdvanced(p.workspace.projectId, quote), claimed = await f.action(null, "claim", ["uncapped-refinement-fixture", 120]), execution = sharedExecutionSchema.parse(claimed.execution), job = parseClaimedJob((claimed.result as unknown[])[0]);
  expect(job.id).toBe(refined.jobId); expect(job.reservedCostMicrousd).toBe(0);
  expect(logoRefinementJobInputSchema.parse(job.input)).toMatchObject({ version: 3, spendControl: "uncapped", source: { kind: "preview" } });
  await f.owner(OWNER_A, () => f.db.query("select public.request_job_cancel($1)", [job.id]));
  await f.action(execution, "finish", [job.id, job.leaseToken, "cancelled"]);
 });
 it("rejects money ceilings and keeps new admission helpers inaccessible to customer and worker logins", async () => {
  for (const change of [{ maxCostMicrousd: 1 }, { estimatedCostMicrousd: -1 }, { estimatedCostMicrousd: "1" }, { spendControl: "capped" }]) {
   const result = await f.db.query<{ valid: boolean }>("select fluid_private.shared_logo_raster_policy_valid($1,$2) valid", [capability.operation, { ...capability, ...change }]);
   expect(result.rows[0]!.valid).toBe(false);
  }
  for (const role of ["anon", "authenticated", "service_role", "fixture_production_acl_probe", f.roleName]) {
   const result = await f.db.query<{ allowed: boolean }>("select has_function_privilege($1,'fluid_private.shared_logo_create_raster_jobs(public.logo_cost_quotes,jsonb,jsonb)','execute') allowed", [role]);
   expect(result.rows[0]!.allowed).toBe(false);
  }
 });

 it("admits with an unavailable estimate without substituting a price or ceiling", async () => {
  const policy = { ...capability, estimatedCostMicrousd: null };
  await f.db.query("update fluid_private.shared_worker_policies set policy=$2 where slot_id=$1 and operation=$3", [f.slotId, policy, capability.operation]);
  await f.runtimeReady();
  try {
   const p = await f.prepare();
   const quote = logoCostQuoteSchema.parse((await f.db.query<{ record: unknown }>("select record from public.logo_cost_quotes where id=$1", [p.request.quoteId])).rows[0]!.record);
   expect(quote).toMatchObject({ estimatedCostMicrousd: null, spendControl: "uncapped" });
   await f.owner(OWNER_A, () => f.db.query("select public.request_job_cancel($1)", [p.job.id]));
   await expect(f.action(p.execution, "begin", [p.job.id, p.job.leaseToken, `logo-preview-v1:${(p.job.input as {slotId:string}).slotId}:${(p.job.input as {attemptId:string}).attemptId}`, `fixture:${p.job.id}`, 0])).rejects.toMatchObject({ code: "42501" });
   expect((await f.db.query("select id from public.job_steps where job_id=$1", [p.job.id])).rows).toHaveLength(0);
   await f.action(p.execution, "finish", [p.job.id, p.job.leaseToken, "cancelled"]);
  } finally {
   await f.db.query("update fluid_private.shared_worker_policies set policy=$2 where slot_id=$1 and operation=$3", [f.slotId, capability, capability.operation]);
   await f.runtimeReady();
  }
 });

 it.each(["unknown", "late"] as const)("preserves %s provider evidence without another dispatch or an invented refund", async kind => {
  const p = await f.prepare(), input = logoConceptJobInputSchema.parse(p.job.input), key = `logo-preview-v1:${input.slotId}:${input.attemptId}`;
  const before = (await f.db.query<{ cost: number }>("select provider_actual_microusd cost from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]!.cost;
  await f.action(p.execution, "begin", [p.job.id, p.job.leaseToken, key, `fixture:${p.job.id}`, 0]);
  if (kind === "late") await f.db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [p.job.id]);
  const observation = { provider: "openai", model: IMAGE_MODEL, providerRequestId: `synthetic-${p.job.id}`, responseHash: "a".repeat(64), observedAt: new Date().toISOString(),
   billing: kind === "unknown" ? { status: "unknown", confirmedMicrousd: null } : { status: "recorded", confirmedMicrousd: 20 }, artifactHash: p.publication.contentHash, normalizedPixelHash: "b".repeat(64) };
  const result = (await f.action(p.execution, "receipt", [p.job.id, p.job.leaseToken, observation])).result;
  expect(result).toMatchObject({ billing: observation.billing });
  expect(await f.rawJob(p.job.id)).toMatchObject({ state: "needs_reconciliation", lease_token: null, error_code: kind === "late" ? "provider_response_after_lease" : "provider_billing_unknown" });
  expect((await f.action(p.execution, "receipt", [p.job.id, p.job.leaseToken, observation])).result).toEqual(result);
  expect((await f.db.query<{ cost: number }>("select provider_actual_microusd cost from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]!.cost).toBe(before + (kind === "late" ? 20 : 0));
  await expect(f.action(p.execution, "begin", [p.job.id, p.job.leaseToken, key, `fixture:${p.job.id}`, 0])).rejects.toBeDefined();
  expect((await f.db.query("select id from public.logo_provider_responses where job_id=$1", [p.job.id])).rows).toHaveLength(1);
  await f.action(p.execution, "recovery", []);
 });

});
