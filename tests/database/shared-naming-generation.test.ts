import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedWorkerFixture, OWNER_A, OWNER_B } from "./shared-worker-fixture";
import { brainPreferences, brainReadinessFingerprint, brainRpc } from "./naming-brain-fixture";
import { sharedSlotLeaseSchema, type SharedExecution } from "../../worker/shared-pool/contracts";
import { namingClaimSchema, namingGenerationFeedSchema, namingRunSchema } from "../../src/domain/naming-generation";
import { namingStrategyBasisSchema, namingStrategyKeyFromBasis } from "../../src/domain/project-naming";

const read = (name: string) => readFile(new URL(`../../supabase/candidates/${name}`, import.meta.url), "utf8");
const policy = { version: 2, operation: "naming.generate", model: "gpt-6-luna", reasoningEffort: "low" };
const candidate = (value: string, approach = "real_words") => ({ value, rationale: `Why ${value} works.`, primaryApproach: approach, identityKey: value.toLowerCase().replace(/[\p{P}\s]/gu, "") });

/** The real packet in disposable PostgreSQL. No provider is called. */
async function fixture() {
  const f = await createSharedWorkerFixture({ probe: false }), db = f.db;
  await f.seedUser(OWNER_A); await f.seedUser(OWNER_B);
  for (const name of ["shared_worker_naming.sql", "shared_naming_brainstorm.sql", "shared_naming_generation.sql"]) await db.exec(await read(name));
  const policyIdentity = (await db.query<{ h: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h", [JSON.stringify(policy)])).rows[0]!.h;
  const slot = await f.seedSlot({ lane: "naming", policies: [{ operation: "naming.generate", policyIdentity, policy }] });
  await db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await db.query("insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)", [slot.slotId, JSON.stringify(brainReadinessFingerprint)]);
  let lease = sharedSlotLeaseSchema.parse(await f.lease(slot));
  const action = async (name: string, args: unknown, execution: SharedExecution | null = null) => f.asSlot(slot, async () => (await db.query<{ v: { execution: SharedExecution | null; result: unknown } }>(
    "select public.shared_naming_worker_action($1,$2,$3,$4) v", [lease, execution, name, JSON.stringify(args)])).rows[0]!.v);
  await action("qualify", { policy });
  async function project(title = "Naming fixture", owner = OWNER_A) {
    const id = (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", title, { description: "A neighborhood kitchen" }, "a".repeat(64)], owner)).id;
    await brainRpc(db, "save_naming_preferences", [id, 0, brainPreferences], owner);
    return id;
  }
  let keys = 0;
  const start = async (projectId: string, kind = "initial", extra: { seedIds?: string[]; instruction?: string | null; key?: string } = {}, owner = OWNER_A) =>
    brainRpc<{ run: unknown; reused: boolean }>(db, "start_naming_run", [projectId, { version: 2, kind, expectedProjectRevision: 1, expectedPreferencesVersion: 1,
      seedIds: extra.seedIds ?? [], instruction: extra.instruction ?? null, idempotencyKey: extra.key ?? `fixture-key-${String(++keys).padStart(8, "0")}` }], owner);
  // SQL omits strategyKey; the server adds it from the frozen basis, as here.
  const feed = async (projectId: string, owner = OWNER_A) => {
    const raw = await brainRpc<{ entries: { entry: { candidate: Record<string, unknown> } }[] }>(db, "get_naming_generation", [projectId, null, null, 100], owner);
    for (const row of raw.entries) row.entry.candidate.strategyKey = namingStrategyKeyFromBasis(namingStrategyBasisSchema.parse(row.entry.candidate.strategyBasis));
    return namingGenerationFeedSchema.parse(raw);
  };
  const claim = async () => {
    const v = await action("claim", { workerId: "fixture-worker", leaseSeconds: 120 });
    return v.result === null ? null : { execution: v.execution!, claim: namingClaimSchema.parse(v.result) };
  };
  const job = async (jobId: string) => (await db.query<{ state: string; error_code: string | null; attempts: number; lease_token: string | null }>(
    "select state,error_code,attempts,lease_token from public.jobs where id=$1", [jobId])).rows[0]!;
  const executions = async (jobId: string) => (await db.query<{ state: string }>("select state from fluid_private.shared_worker_executions where job_id=$1 order by created_at", [jobId])).rows.map(r => r.state);
  const stopWorker = (jobId: string) => db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [jobId]);
  const takeover = async () => {
    await db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1", [slot.slotId]);
    lease = sharedSlotLeaseSchema.parse(await f.lease(slot));
    await action("qualify", { policy });
  };
  const request = (round: number) => ({ model: "gpt-6-luna", input: `Synthetic round ${round}` });
  return { f, db, slot, action, project, start, feed, claim, job, executions, stopWorker, takeover, request };
}

describe("Naming generation SQL", () => {
  it("starts one run per project, replays the same click, and refuses other owners", async () => {
    const x = await fixture();
    try {
      const p = await x.project();
      const first = await x.start(p, "initial", { key: "fixture-key-replay-01" });
      expect(namingRunSchema.parse(first.run)).toMatchObject({ state: "queued", kind: "initial", savedCount: 0 });
      const again = await x.start(p, "initial", { key: "fixture-key-replay-01" });
      expect(again).toMatchObject({ reused: true, run: { runId: (first.run as { runId: string }).runId } });
      await expect(x.start(p, "more")).rejects.toThrow(/naming_active/u);
      await expect(x.start(p, "more", { instruction: "nope" })).rejects.toThrow(/invalid_naming_request/u);
      await expect(x.feed(p, OWNER_B)).rejects.toThrow(/not_found/u);
      await expect(x.start(p, "initial", {}, OWNER_B)).rejects.toThrow(/not_found/u);
      await expect(brainRpc(x.db, "stop_naming_run", [p], OWNER_B)).rejects.toThrow(/not_found/u);
      expect((await x.feed(p)).availability).toEqual({ status: "available" });
    } finally { await x.f.close(); }
  });

  it("saves cleaned names round by round, skips duplicates and finishes as succeeded", async () => {
    const x = await fixture();
    try {
      const p = await x.project();
      const { run } = await x.start(p);
      const { execution, claim } = (await x.claim())!;
      expect(claim.run.runId).toBe((run as { runId: string }).runId);
      expect(claim.input.brief.strategyBasis.description).toBe("A neighborhood kitchen");
      expect((await x.action("heartbeat", { leaseSeconds: 120 }, execution)).result).toEqual({ cancelRequested: false });
      await x.action("round_begin", { round: 1, request: x.request(1) }, execution);
      // Replaying the same begin is harmless; a different request is a conflict.
      await x.action("round_begin", { round: 1, request: x.request(1) }, execution);
      await expect(x.action("round_begin", { round: 1, request: x.request(9) }, execution)).rejects.toThrow(/naming_round_conflict/u);
      await x.action("round_sent", { round: 1, responseId: "resp_fixture1", requestId: "req_fixture1" }, execution);
      const saved = await x.action("round_saved", { round: 1, responseId: "resp_fixture1", model: "gpt-6-luna",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, candidates: [candidate("Brújula", "other_languages"), candidate("Brújula", "other_languages"), candidate("Lantern Row", "phrases")] }, execution);
      expect(saved.result).toEqual({ inserted: 2, savedCount: 2 });
      expect((await x.action("round_saved", { round: 1, responseId: "resp_fixture1", model: "gpt-6-luna", usage: null, candidates: [] }, execution)).result).toEqual({ inserted: 0, savedCount: 2 });
      await expect(x.action("round_saved", { round: 1, responseId: "resp_fixture1", model: "gpt-6-luna", usage: null,
        candidates: [{ ...candidate("Bad"), primaryApproach: "unknown" }] }, execution)).resolves.toBeTruthy(); // replay of a saved round ignores its body
      await x.action("round_begin", { round: 2, request: x.request(2) }, execution);
      await x.action("round_failed", { round: 2, code: "provider_rejected", responseId: null, usage: null }, execution);
      expect((await x.action("finish", {}, execution)).result).toEqual({ state: "succeeded", savedCount: 2 });
      // A finish whose acknowledgement was lost can be replayed safely.
      expect((await x.action("finish", {}, execution)).result).toEqual({ state: "succeeded", savedCount: 2 });
      const view = await x.feed(p);
      expect(view.run).toMatchObject({ state: "succeeded", savedCount: 2, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
      expect(view.entries.map(e => [e.entry.candidate.value, e.primaryApproach])).toEqual([["Brújula", "other_languages"], ["Lantern Row", "phrases"]]);
      expect(await x.executions(claim.job.id)).toEqual(["closed"]);
      // Runs are not old-format batches: the saved-names overview leaves them out.
      expect((await brainRpc<{ items: unknown[] }>(x.db, "get_naming_batches", [p, { limit: 100 }])).items).toEqual([]);
      expect(await brainRpc(x.db, "get_naming_usage", [`{${claim.job.id}}`])).toEqual([{ jobId: claim.job.id, inputTokens: 10, outputTokens: 20, totalTokens: 30 }]);
    } finally { await x.f.close(); }
  });

  it("rejects malformed names instead of storing them", async () => {
    const x = await fixture();
    try {
      const p = await x.project(); await x.start(p);
      const { execution } = (await x.claim())!;
      await x.action("round_begin", { round: 1, request: x.request(1) }, execution);
      await x.action("round_sent", { round: 1, responseId: "resp_fixture2", requestId: null }, execution);
      for (const bad of [{ ...candidate("Odd"), primaryApproach: "unknown" }, { ...candidate("Odd"), extra: true }, { ...candidate("Odd"), value: " " }])
        await expect(x.action("round_saved", { round: 1, responseId: "resp_fixture2", model: "gpt-6-luna", usage: null, candidates: [bad] }, execution)).rejects.toThrow(/invalid_naming_candidate/u);
      await expect(x.action("round_saved", { round: 1, responseId: "resp_other", model: "gpt-6-luna", usage: null, candidates: [] }, execution)).rejects.toThrow(/naming_round_conflict/u);
    } finally { await x.f.close(); }
  });

  it("ends a run whose send was interrupted and never allows that round again", async () => {
    const x = await fixture();
    try {
      const p = await x.project(); await x.start(p, "steer", { instruction: "Shorter, warmer names" });
      const { execution, claim } = (await x.claim())!;
      expect(claim.input.brief.steeringInstruction).toBe("Shorter, warmer names");
      await x.action("round_begin", { round: 1, request: x.request(1) }, execution);
      await x.stopWorker(claim.job.id);
      expect((await x.action("expire", {})).result).toBe(1);
      expect(await x.job(claim.job.id)).toMatchObject({ state: "failed", error_code: "send_interrupted", lease_token: null });
      expect(await x.executions(claim.job.id)).toEqual(["closed"]);
      expect((await x.feed(p)).run).toMatchObject({ state: "failed", errorCode: "send_interrupted" });
      expect(await x.claim()).toBeNull();
      // Try again is a new run.
      await x.start(p, "initial");
    } finally { await x.f.close(); }
  });

  it("resumes a sent round only by polling after the worker stops, and gives up after its attempts", async () => {
    const x = await fixture();
    try {
      const p = await x.project(); await x.start(p);
      let held = (await x.claim())!;
      await x.action("round_begin", { round: 1, request: x.request(1) }, held.execution);
      await x.action("round_sent", { round: 1, responseId: "resp_fixture3", requestId: null }, held.execution);
      await x.stopWorker(held.claim.job.id);
      expect((await x.action("expire", {})).result).toBe(1);
      expect((await x.job(held.claim.job.id)).state).toBe("queued");
      held = (await x.claim())!;
      expect(held.claim.job.attempts).toBe(2);
      expect(held.claim.rounds).toEqual([expect.objectContaining({ round: 1, state: "sent", responseId: "resp_fixture3" })]);
      await expect(x.action("round_begin", { round: 2, request: x.request(2) }, held.execution)).rejects.toThrow(/naming_round_open/u);
      await x.stopWorker(held.claim.job.id); await x.action("expire", {});
      held = (await x.claim())!;
      expect(held.claim.job.attempts).toBe(3);
      await x.stopWorker(held.claim.job.id); await x.action("expire", {});
      expect(await x.job(held.claim.job.id)).toMatchObject({ state: "failed", error_code: "lease_expired" });
    } finally { await x.f.close(); }
  });

  it("stops a queued run at once and a running run at the worker's next step", async () => {
    const x = await fixture();
    try {
      const p = await x.project();
      await x.start(p);
      expect(((await brainRpc(x.db, "stop_naming_run", [p])) as { run: { state: string } }).run.state).toBe("cancelled");
      await x.start(p, "more");
      const { execution } = (await x.claim())!;
      expect(((await brainRpc(x.db, "stop_naming_run", [p])) as { run: { state: string } }).run.state).toBe("cancel_requested");
      expect((await x.action("heartbeat", { leaseSeconds: 120 }, execution)).result).toEqual({ cancelRequested: true });
      await expect(x.action("round_begin", { round: 1, request: x.request(1) }, execution)).rejects.toThrow(/naming_cancel_requested/u);
      expect((await x.action("finish", {}, execution)).result).toEqual({ state: "cancelled", savedCount: 0 });
    } finally { await x.f.close(); }
  });

  it("recovers a run left behind by a stopped process without touching a newer claim", async () => {
    const x = await fixture();
    try {
      const p = await x.project(); await x.start(p);
      const old = (await x.claim())!;
      await x.action("round_begin", { round: 1, request: x.request(1) }, old.execution);
      await x.takeover();
      expect(await x.executions(old.claim.job.id)).toEqual(["observing"]);
      expect((await x.action("recover", {}, old.execution)).result).toEqual({ action: "closed" });
      expect(await x.job(old.claim.job.id)).toMatchObject({ state: "failed", error_code: "send_interrupted" });
      expect(await x.executions(old.claim.job.id)).toEqual(["closed"]);

      await x.start(p, "more");
      const second = (await x.claim())!;
      await x.takeover();
      await x.stopWorker(second.claim.job.id); await x.action("expire", {});
      const third = (await x.claim())!;
      expect(third.claim.job.id).toBe(second.claim.job.id);
      // The stale execution was closed by expiry; it cannot touch the newer claim.
      await expect(x.action("recover", {}, second.execution)).rejects.toThrow(/shared_execution_denied/u);
      expect((await x.job(third.claim.job.id)).state).toBe("running");
      expect((await x.action("heartbeat", { leaseSeconds: 120 }, third.execution)).result).toEqual({ cancelRequested: false });
    } finally { await x.f.close(); }
  });
});
