import { runApiTextDelivery } from "../../worker/api-text-runtime";
import { jobFixture, transportFixture } from "../server/openai-fixtures";
import { strategyPolicy } from "../../src/server/ai/config";

export const message = { version: 1 as const, jobId: jobFixture().id, policyIdentity: "a".repeat(64), deploymentId: "dpl_synthetic", dispatchIdentity: "b".repeat(64) };
export const configuration = { apiKey: "synthetic-test-credential", policies: new Map([["strategy.reformulate" as const, strategyPolicy("strategy.reformulate")]]) };
/** Adapter fixture only. Actual role, lease and money fences are tested against PGlite separately. */
export function databaseFixture(job = jobFixture()) {
  const state = { status: "queued", busy: false, found: true, enabled: true, authorized: true, expiredInFlight: false,
    step: null as null | { state: string; request_key: string; reserved_cost_microusd: number },
    outcomes: [] as unknown[][], claimCalls: 0, policyChecks: 0, authorizationChecks: 0, rowMode: "openai_api", rowId: job.id };
  const descriptor = () => ({ ...message, operation: job.operation, state: state.status, retryable: state.status === "queued",
    publicationGeneration: 0, publishedMessageId: null, publishedAt: null });
  const row = () => ({ id: state.rowId, owner_id: job.ownerId, project_id: job.projectId, operation: job.operation,
    input: job.input, input_revision: job.inputRevision, lease_token: job.leaseToken, state: state.status,
    billing_mode: state.rowMode, reserved_cost_microusd: job.reservedCostMicrousd, actual_cost_microusd: 0 });
  const queries: string[] = [];
  const database = { async query(sql: string, values: unknown[] = []) {
    queries.push(sql);
    if (sql.includes("get_api_text_dispatch")) return { rows: [{ dispatch: state.found ? descriptor() : null }] };
    if (sql.includes("expire_api_text_job")) {
      if (state.expiredInFlight) { state.status = "needs_reconciliation"; return { rows: [{ result: { disposition: "terminal", state: state.status } }] }; }
      return { rows: [{ result: { disposition: state.busy ? "busy" : state.status === "queued" ? "available" : "terminal", state: state.busy ? "running" : state.status } }] };
    }
    if (sql.includes("check_api_text_runtime")) { state.policyChecks++; return { rows: [{ ready: state.enabled }] }; }
    if (sql.includes("claim_api_text_job")) {
      state.claimCalls++;
      if (state.busy) return { rows: [{ result: { disposition: "busy", state: "running" } }] };
      if (state.status !== "queued") return { rows: [{ result: { disposition: "terminal", state: state.status } }] };
      state.status = "running"; return { rows: [{ result: { disposition: "claimed", state: "running", job: row() } }] };
    }
    if (sql.includes("heartbeat_job")) return { rows: [row()] };
    if (sql.includes("register_job_plan")) return { rows: [] };
    if (sql.includes("select state, request_key")) return { rows: state.step ? [state.step] : [] };
    if (sql.includes("begin_job_step")) { state.step = { state: "running", request_key: values[3] as string, reserved_cost_microusd: values[4] as number }; return { rows: [] }; }
    if (sql.includes("authorize_api_text_dispatch")) { state.authorizationChecks++; return { rows: [{ authorized: state.authorized && state.enabled }] }; }
    if (sql.includes("complete_job_step")) {
      state.outcomes.push(values);
      state.step!.state = values[3] as string;
      if (values[3] === "ambiguous") state.status = "needs_reconciliation";
      return { rows: [] };
    }
    if (sql.includes("finish_job")) { state.status = values[2] as string; return { rows: [] }; }
    throw new Error(`Unexpected test SQL: ${sql}`);
  } };
  return { database, state, queries, descriptor };
}
export function delivery(fixture = databaseFixture(), transport = transportFixture(), extra: Record<string, unknown> = {}) {
  return runApiTextDelivery({ message, database: fixture.database, configuration, deploymentId: message.deploymentId, transport, ...extra });
}
