import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingManagedProtocol, type NamingManagedDiagnostic } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { runOneJob } from "../../worker/runner";
import { createTestDatabase, type TestDatabase } from "../database/local-supabase";
import { brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";

describe("managed create rejection through SDK, transport, worker and real SQL (synthetic HTTP)", () => {
 let db: TestDatabase; let project: string;
 beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
 beforeEach(async () => { project = await seedBrainFixture(db); });
 afterAll(async () => { await db?.close(); });

 async function run(status: number, requestId: string | null) {
  let creates = 0;
  const diagnostics: NamingManagedDiagnostic[] = [];
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-fixture", onDiagnostic: value => diagnostics.push(value), fetch: async (input, init) => {
   const request = new Request(input, init);
   expect(new URL(request.url).pathname).toBe("/v1/agents/sessions"); expect(request.method).toBe("POST"); creates++;
   return new Response(JSON.stringify({ error: { message: "Discard this private synthetic provider body", type: "invalid_request_error", code: "unknown_parameter", param: "spend_control" } }), { status,
    headers: { "content-type": "application/json", ...(requestId ? { "x-request-id": requestId } : {}) } });
  } });
  const store = new NamingBrainJobStore(db, "fixture-deployment");
  const handlers = createNamingBrainHandlers({ store, assertReady: async () => {}, runtime: (job, input) => createNamingAgentRuntime({ model: input.policy.model, protocol, persistence: store.runtimePersistence(job), assertContinuation: () => store.assertContinuation(job) }) });
  const admitted = await brainRpc<{ run: { jobId: string; runId: string } }>(db, "ensure_naming_brain_run", [project, initialIntent()]);
  const result = await brainWorker(db, () => runOneJob({ store, handlers, workerId: "fixture-worker" }));
  return { creates, diagnostics, result, admitted };
 }

 it("finishes an evidenced HTTP400 create rejection as failed while retaining the full unsettled allowance", async () => {
  const test = await run(400, "req_synthetic_known_rejection");
  expect(test.result).toBe("failed"); expect(test.creates).toBe(1);
  expect(test.diagnostics).toEqual([{ status: 400, providerCode: "unknown_parameter", parameter: "spend_control" }]);
  expect((await db.query("select state,error_code from public.jobs where id=$1", [test.admitted.run.jobId])).rows).toEqual([{ state: "failed", error_code: "naming_incomplete" }]);
  expect((await db.query("select state,output->>'errorCode' error from public.job_steps where job_id=$1", [test.admitted.run.jobId])).rows).toEqual([{ state: "failed", error: "provider_request_rejected" }]);
  expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal,fluid_private.naming_brain_rejected_receipt(c) rejected from fluid_private.naming_brain_calls c where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ terminal: true, rejected: true }]);
  expect(await brainRpc(db, "get_naming_brain_job_accounting", [test.admitted.run.jobId])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
  expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_receipts where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ count: 2 }]);
  expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_provider_records where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ count: 0 }]);
  expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_feed_entries where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ count: 0 }]);
 });

 it.each([[400, null], [500, "req_synthetic_uncertain"]] as const)("keeps status %s without qualifying rejection evidence quarantined", async (status, requestId) => {
  const test = await run(status, requestId);
  expect(test.result).toBe("needs_reconciliation"); expect(test.creates).toBe(1);
  expect((await db.query("select state from public.jobs where id=$1", [test.admitted.run.jobId])).rows).toEqual([{ state: "needs_reconciliation" }]);
  expect((await db.query("select fluid_private.naming_brain_rejected_receipt(c) rejected from fluid_private.naming_brain_calls c where run_id=$1", [test.admitted.run.runId])).rows).toEqual([{ rejected: false }]);
  expect(await brainRpc(db, "get_naming_brain_job_accounting", [test.admitted.run.jobId])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
 });
});
