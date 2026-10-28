import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedAdvancedLogoFixture, type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { sharedExecutionSchema } from "../../worker/shared-pool/contracts";

/** Only synthetic provider observations are supplied. Actual SQL must retain
 * their independently priced expense through uncertain acknowledgements. */
describe("uncapped directions unknown acknowledgements and late observed expense", () => {
 let f: SharedAdvancedLogoFixture | undefined;
 afterEach(async () => { await f?.close(); f = undefined; });
 it.each(["before", "after"])("retains a known bill observed %s the original bare uncertainty without duplicating capture", async when => {
  f = await createSharedAdvancedLogoFixture(); await f.runtimeReady();
  const p = await f.prepareDirections(), result = await f.action(null, "claim", ["shared-expense-fixture", 120]), e = sharedExecutionSchema.parse(result.execution);
  expect(e.jobId).toBe(p.jobId);
  await f.action(e, "begin", [e.jobId, e.leaseToken, "propose-directions", `synthetic:${e.jobId}`, 0]);
  const observation = { version: 3, kind: "logo_directions_text", provider: "openai", model: "gpt-6.1-sol", billingMode: "openai_api", spendControl: "uncapped",
   apiPolicy: f.directionsCapability.apiPolicy, responseId: `resp_${e.jobId.replaceAll("-", "")}`, providerRequestId: `synthetic-${e.jobId}`, responseHash: "a".repeat(64),
   observedAt: new Date().toISOString(), responseComplete: true, toolCalls: 0, serviceTier: "default", usage: { inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3 },
   billing: { status: "recorded", confirmedMicrousd: 34 }, artifactHash: null };
  const unknown = () => f!.action(e, "complete", [e.jobId, e.leaseToken, "propose-directions", "ambiguous", 0, { error: "provider_outcome_unknown" }, null]);
  if (when === "before") await f.action(e, "receipt", [e.jobId, e.leaseToken, observation]);
  await unknown();
  if (when === "after") await f.action(e, "receipt", [e.jobId, e.leaseToken, observation]);
  await unknown();
  const row = (await f.db.query<{ state: string; actual: number; reserved: number; output: unknown }>("select state,actual_cost_microusd actual,reserved_cost_microusd reserved,output from public.job_steps where job_id=$1", [e.jobId])).rows[0]!;
  expect(row).toEqual({ state: "ambiguous", actual: 34, reserved: 0, output: { error: "provider_outcome_unknown" } });
  expect((await f.rawJob(e.jobId)).state).toBe("needs_reconciliation");
  const ledger = (await f.db.query<{ actual: number; captured: number; provider: number }>("select r.actual_microusd actual,r.captured_microusd captured,a.provider_actual_microusd provider from public.usage_reservations r join public.usage_accounts a using(owner_id) where r.job_id=$1", [e.jobId])).rows[0]!;
  expect(ledger).toEqual({ actual: 34, captured: 0, provider: 34 });
  expect((await f.db.query("select id from public.logo_direction_publications where job_id=$1", [e.jobId])).rows).toHaveLength(0);
 }, 90_000);
});
