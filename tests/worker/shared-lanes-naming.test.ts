import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingStrategyBasis } from "../../src/domain/project-naming";
import { namingClaimSchema, namingRunInputSchema, type NamingGenerationPolicy } from "../../src/domain/naming-generation";
import type { NamingGenerationWire } from "../../src/domain/naming-generation-wire";
import { NamingProviderError, type NamingGenerationProvider } from "../../src/server/ai/naming-generation-provider";
import { createSharedNamingLaneEngine } from "../../worker/shared-lanes/naming";
import { sharedSlotLeaseSchema, type SharedExecution, type SharedPendingExecution } from "../../worker/shared-pool/contracts";

/** The real shared gateway over a synthetic SQL double and a fake provider. */
const id = (n: number) => `63000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = "c".repeat(64), model = "gpt-fixture-naming", deploymentId = "dpl_fixture_current";
const policy: NamingGenerationPolicy = { version: 2, operation: "naming.generate", model, reasoningEffort: "low" };
const slot = sharedSlotLeaseSchema.parse({ version: 1, slotId: id(10), instanceId: id(11), lane: "naming", generation: 2, leaseToken: id(12), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), roleName: "embel_shared_naming_fixture", roleOid: 77 });
const execution = (n = 20, overrides: Partial<SharedExecution> = {}): SharedExecution => ({ version: 1, executionId: id(n), executionToken: id(n + 1), slotId: slot.slotId, instanceId: slot.instanceId,
  generation: slot.generation, lane: "naming", ownerId: id(1), projectId: id(2), jobId: id(4), leaseToken: id(6), operation: "naming.generate", policyIdentity: hash, deploymentId, ...overrides });
function claim(policyIdentity = hash) {
  const input = namingRunInputSchema.parse({ version: 3, kind: "initial", runId: id(3), target: 100, policyIdentity, brief: { version: 1, contextRevision: 1, preferencesVersion: 1,
    preferences: { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null, approaches: ["invented"], directness: "all", sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] },
    strategyBasis: namingStrategyBasis(contextSnapshotSchema.parse({ description: "Synthetic fixture: a garden planning service." })), likedExamples: [], strongSeeds: [], recentExamples: [], steeringInstruction: null } });
  return namingClaimSchema.parse({ job: { id: id(4), owner_id: id(1), project_id: id(2), lease_token: id(6), operation: "naming.generate", attempts: 1, max_attempts: 3 },
    run: { runId: input.runId, jobId: id(4), kind: "initial", state: "running", target: 100, savedCount: 0, errorCode: null, usage: null, createdAt: "2026-11-08T12:00:00Z", finishedAt: null },
    input, rounds: [], identities: [] });
}
type Handler = (args: Record<string, unknown>, execution: SharedExecution | null) => unknown;
function database(handlers: Record<string, Handler>) {
  const calls: { action: string; args: Record<string, unknown>; execution: SharedExecution | null; slot: unknown }[] = [];
  const query = vi.fn(async (_sql: string, values: unknown[] = []) => {
    const [slotJson, executionJson, action, argsJson] = values as [string, string | null, string, string];
    const current = executionJson ? JSON.parse(executionJson) as SharedExecution : null, args = JSON.parse(argsJson) as Record<string, unknown>;
    calls.push({ action, args, execution: current, slot: JSON.parse(slotJson) });
    const handler = handlers[action];
    if (!handler) throw Error(`unexpected_${action}`);
    const result = await handler(args, current);
    return { rows: [{ envelope: { execution: action === "claim" ? result === null ? null : execution() : current, result } }] };
  });
  return { database: { query }, calls, actions: () => calls.map(call => call.action) };
}
const names = (count: number) => Array.from({ length: count }, (_, index) => ({ value: `Lanename${index}`, rationale: "Fixture imagery for this synthetic brief.", primaryApproach: "invented", construction: [] }));
function provider(reply: (request: NamingGenerationWire) => Record<string, unknown> | Error | "pending") {
  const created: NamingGenerationWire[] = [], retrieved: string[] = [];
  const replies = new Map<string, Record<string, unknown> | "pending">();
  const fake: NamingGenerationProvider = {
    async create(request) { created.push(request); const value = reply(request); if (value instanceof Error) throw value; const responseId = `resp_lane_${created.length}`; replies.set(responseId, value); return { responseId, requestId: null, status: "queued" }; },
    async retrieve(responseId) { retrieved.push(responseId); const value = replies.get(responseId)!; return { response: value === "pending" ? { id: responseId, status: "in_progress", model } : { ...value, id: responseId }, requestId: null }; },
    async cancel() {},
  };
  return { fake, created, retrieved };
}
const completed = { status: "completed", model, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ candidates: names(120) }) }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } };
const sqlRound: Record<string, Handler> = { qualify: () => true, expire: () => 0, claim: () => claim(), heartbeat: () => ({ cancelRequested: false }), round_begin: args => ({ round: args.round, state: "sending" }),
  round_sent: args => ({ round: args.round, state: "sent" }), round_saved: args => ({ inserted: (args.candidates as unknown[]).length, savedCount: (args.candidates as unknown[]).length }),
  round_failed: args => ({ round: args.round, state: "failed" }), finish: () => ({ state: "succeeded", savedCount: 100 }) };
const timing = { heartbeatMs: 1_000_000, pollMs: 1, roundTimeoutMs: 2_000, deadlineMs: 20_000, requestTimeoutMs: 1_000, cancelTimeoutMs: 100, retryDelaysMs: [0, 0] };
function engine(handlers: Record<string, Handler>, fake: NamingGenerationProvider) {
  const db = database(handlers);
  const lane = createSharedNamingLaneEngine({ database: db.database, slot: () => slot, deploymentId, workerId: "fixture-worker", provider: { apiKey: "synthetic-never-live", model, modelVerificationReceipt: "receipt:fixture" }, policy }, { provider: fake, timing });
  return { lane, ...db };
}
const pending = (value: SharedExecution): SharedPendingExecution => ({ execution: value, job: {}, mode: "observe" });

describe("shared Naming lane engine", () => {
  it("acknowledges an idle turn after qualify, expire and claim with JSON arguments", async () => {
    const p = provider(() => Error("never")), f = engine({ qualify: () => true, expire: () => 2, claim: () => null }, p.fake);
    expect(await f.lane.run()).toEqual({ disposition: "ack", state: "idle" });
    expect(f.actions()).toEqual(["qualify", "expire", "claim"]);
    expect(f.calls.map(call => call.args)).toEqual([{ policy }, {}, { workerId: "fixture-worker", leaseSeconds: 120 }]);
    expect(f.calls.every(call => call.execution === null)).toBe(true); expect(p.created).toHaveLength(0);
    await expect(f.lane.close()).resolves.toBeUndefined();
  });
  it("runs a claimed job to success under the claimed execution", async () => {
    const p = provider(() => completed), f = engine(sqlRound, p.fake);
    expect(await f.lane.run()).toEqual({ disposition: "ack", state: "succeeded" });
    expect(f.actions()).toEqual(["qualify", "expire", "claim", "round_begin", "round_sent", "round_saved", "finish"]);
    expect(f.calls.slice(3).every(call => JSON.stringify(call.execution) === JSON.stringify(execution()))).toBe(true);
    expect(p.created[0]).toMatchObject({ background: true, store: true, stream: false, metadata: { embel_job_id: id(4), embel_run_id: id(3), embel_round: "1" } });
  });
  it("refuses a claim admitted under another policy before any provider work", async () => {
    const p = provider(() => completed), f = engine({ ...sqlRound, claim: () => claim("d".repeat(64)) }, p.fake);
    await expect(f.lane.run()).rejects.toThrow("shared_naming_authority_unavailable"); expect(p.created).toHaveLength(0);
    await expect(f.lane.close()).resolves.toBeUndefined();
  });
  it("refuses a slot policy for another model when it is created", () => {
    const db = database({});
    expect(() => createSharedNamingLaneEngine({ database: db.database, slot: () => slot, deploymentId, workerId: "fixture-worker", provider: { apiKey: "synthetic-never-live", model: "gpt-other", modelVerificationReceipt: "receipt:fixture" }, policy })).toThrow();
  });
  it("returns retry after a failed run and still closes cleanly", async () => {
    const p = provider(() => new NamingProviderError("outcome_unknown")), f = engine({ ...sqlRound, finish: () => { throw Error("synthetic finish failure"); } }, p.fake);
    expect(await f.lane.run()).toEqual({ disposition: "retry", state: "unsettled" });
    await expect(f.lane.close()).resolves.toBeUndefined();
    expect(await f.lane.run()).toEqual({ disposition: "retry", state: "stopping" });
  });
  it("closes during an active run without throwing and leaves the sent round for the next claim", async () => {
    const p = provider(() => "pending"), f = engine(sqlRound, p.fake), running = f.lane.run();
    await vi.waitFor(() => expect(p.retrieved.length).toBeGreaterThan(0));
    await expect(f.lane.close()).resolves.toBeUndefined();
    expect(await running).toEqual({ disposition: "retry", state: "stopped" });
    expect(f.actions()).not.toContain("finish"); expect(f.actions()).not.toContain("round_failed");
  });
  it("recovers pending executions in observation mode and tolerates one failure", async () => {
    const first = execution(30), second = execution(40), foreign = execution(50, { deploymentId: "dpl_fixture_previous" });
    const p = provider(() => Error("never")), f = engine({ recover: (_args, current) => { if (current?.executionId === first.executionId) throw Error("synthetic recover failure"); return { action: "closed" }; } }, p.fake);
    expect(await f.lane.recover!([pending(foreign), pending(first), pending(second)])).toEqual({ disposition: "retry", state: "recover_failed" });
    expect(f.calls.map(call => [call.action, call.args, call.execution?.executionId])).toEqual([["recover", {}, first.executionId], ["recover", {}, second.executionId]]);
    expect(f.calls[0]!.slot).toEqual(slot); expect(p.created).toHaveLength(0);
    await expect(f.lane.close()).resolves.toBeUndefined();
  });
  it("recovers at most three executions per call", async () => {
    const f = engine({ recover: () => ({ action: "closed" }) }, provider(() => Error("never")).fake);
    expect(await f.lane.recover!([30, 40, 50, 60, 70].map(n => pending(execution(n))))).toEqual({ disposition: "ack", state: "recovered" });
    expect(f.actions()).toEqual(["recover", "recover", "recover"]);
  });
});
