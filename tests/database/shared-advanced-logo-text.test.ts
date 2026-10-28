import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedAdvancedLogoFixture, type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { sharedExecutionSchema, type SharedExecution } from "../../worker/shared-pool/contracts";
import { logoVectorProposalRecordSchema, logoVectorProposalUsageCost } from "../../src/domain/logo-vector-proposal-jobs";
import { OWNER_A, OWNER_B } from "./local-supabase";

const usage = { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, cost = logoVectorProposalUsageCost(usage);
function retained(payload: unknown) { const bytes = Buffer.from(JSON.stringify(payload)); return { encoding: "base64", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, truncated: false }; }
describe("future uncapped shared Logo text contracts preserve exact expense and tenant authority (SQL fixture)", () => {
 let f: SharedAdvancedLogoFixture;
 beforeAll(async () => { f = await createSharedAdvancedLogoFixture(); await f.runtimeReady(); }, 90_000);
 afterAll(async () => { await f?.close(); });
 async function claim(jobId: string) {
  const claimed = await f.action(null, "claim", ["shared-advanced-text-fixture", 120]); const execution = sharedExecutionSchema.parse(claimed.execution);
  expect(execution.jobId).toBe(jobId); return execution;
 }
 async function begin(execution: SharedExecution, key: string) {
  const job = await f.rawJob(execution.jobId); await f.action(execution, "plan", [execution.jobId, execution.leaseToken, job.plan_manifest]);
  expect((await f.action(execution, "begin", [execution.jobId, execution.leaseToken, key, `synthetic:${execution.jobId}`, 0])).result).toBe("started");
 }
 function observation(execution: SharedExecution, kind: "proposal" | "directions", unknown = false) {
  const common = { provider: "openai", model: "gpt-6.1-sol", providerRequestId: `synthetic-${execution.jobId}`, responseId: `resp_${execution.jobId.replaceAll("-", "")}`,
   responseHash: "a".repeat(64), observedAt: new Date().toISOString(), responseComplete: true, serviceTier: "default", toolCalls: 0, usage,
   billing: unknown ? { status: "unknown", confirmedMicrousd: null } : { status: "recorded", confirmedMicrousd: cost } };
  return kind === "proposal" ? { ...common, version: 1, kind: "logo_vector_proposal_text", textPolicy: f.proposalCapability.textPolicy }
   : { ...common, version: 3, kind: "logo_directions_text", billingMode: "openai_api", spendControl: "uncapped", apiPolicy: f.directionsCapability.apiPolicy, artifactHash: null };
 }
 it("quotes and completes proposals for two owners with independent policies/receipts and no monetary ceiling", async () => {
  for (const owner of [OWNER_A, OWNER_B]) {
   const p = await f.prepareProposal(owner); expect(p.quote).toMatchObject({ version: 3, billingMode: "openai_api", spendControl: "uncapped" });
   expect(p.quote).not.toHaveProperty("maxCostMicrousd"); expect(p.request).not.toHaveProperty("acceptedMaxCostMicrousd");
   const e = await claim(p.jobId); await begin(e, "propose-vector-edit");
   const observed = (await f.action(e, "receipt", [e.jobId, e.leaseToken, observation(e, "proposal")])).result as { id: string };
   const payload = { version: 1, status: "proposed", edit: { kind: "rotation", componentId: p.context.components[0]!.id, degrees: 10 }, explanation: "One synthetic rotation." };
   const result = { status: "valid", payload, reason: null, retainedOutput: retained(payload) };
   const staged = (await f.action(e, "stage_proposal", [e.jobId, e.leaseToken, result, observed.id])).result as { id: string };
   await f.action(e, "complete", [e.jobId, e.leaseToken, "propose-vector-edit", "succeeded", cost,
    { version: 1, kind: "logo_vector_proposal", preparedId: staged.id, providerResponseReceiptId: observed.id }, `synthetic-${e.jobId}`]);
   await f.action(e, "finish", [e.jobId, e.leaseToken, "succeeded"]);
   const saved = await f.owner(owner, async () => logoVectorProposalRecordSchema.parse((await f.db.query<{ value: unknown }>("select public.read_logo_vector_proposal($1,$2) value", [e.projectId, staged.id])).rows[0]!.value));
   expect(saved.ownerId).toBe(owner); expect(saved.state).toBe("succeeded"); expect(saved.actualCostMicrousd).toBe(cost);
   const ledger = (await f.db.query<{ reserved: number; actual: number; captured: number; state: string }>("select reserved_microusd reserved,actual_microusd actual,captured_microusd captured,state from public.usage_reservations where job_id=$1", [e.jobId])).rows[0]!;
   expect(ledger).toEqual({ reserved: 0, actual: cost, captured: 0, state: "settled" });
   await expect(f.owner(owner === OWNER_A ? OWNER_B : OWNER_A, () => f.db.query("select public.read_logo_vector_proposal($1,$2)", [e.projectId, staged.id]))).rejects.toMatchObject({ code: "P0002" });
  }
 });
 it("completes API directions with genuine font-check SQL and positive expense on a zero reservation", async () => {
  const p = await f.prepareDirections(), e = await claim(p.jobId); await begin(e, "propose-directions");
  const observed = (await f.action(e, "receipt", [e.jobId, e.leaseToken, observation(e, "directions")])).result as { id: string };
  const publication = (await f.action(e, "stage_directions", [e.jobId, e.leaseToken, p.source.result, observed.id, p.source.checks])).result as { id: string };
  await f.action(e, "complete", [e.jobId, e.leaseToken, "propose-directions", "succeeded", cost,
   { version: 2, kind: "logo_directions", publicationId: publication.id, providerResponseReceiptId: observed.id }, `synthetic-${e.jobId}`]);
  await f.action(e, "finish", [e.jobId, e.leaseToken, "succeeded"]);
  expect((await f.db.query<{ state: string; actual: number }>("select state,actual_cost_microusd actual from public.jobs where id=$1", [e.jobId])).rows[0]).toEqual({ state: "succeeded", actual: cost });
  expect((await f.db.query("select id from public.logo_direction_records where project_id=$1 and kind='direction'", [e.projectId])).rows).toHaveLength(3);
 });
 it("retains unknown billing and issued response bytes without marking an uncertain proposal successful", async () => {
  const p = await f.prepareProposal(), e = await claim(p.jobId); await begin(e, "propose-vector-edit");
  await f.action(e, "receipt", [e.jobId, e.leaseToken, observation(e, "proposal", true)]);
  const row = (await f.db.query<{ state: string; actual: number; token: string | null }>("select state,actual_cost_microusd actual,lease_token token from public.jobs where id=$1", [e.jobId])).rows[0]!;
  expect(row).toEqual({ state: "needs_reconciliation", actual: 0, token: null });
  await expect(f.action(e, "begin", [e.jobId, e.leaseToken, "propose-vector-edit", "replacement", 0])).rejects.toMatchObject({ code: "42501" });
  await f.action(e, "complete", [e.jobId, e.leaseToken, "propose-vector-edit", "ambiguous", 0, { error: "provider_outcome_unknown" }, null]);
  const recovery = (await f.action(e, "recovery", [])).result as { capability: unknown; observationJob: { state: string } };
  expect(recovery.capability).toEqual(f.proposalCapability); expect(recovery.observationJob.state).toBe("needs_reconciliation");
 });
});
