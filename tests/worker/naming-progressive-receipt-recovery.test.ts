import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingCurationProjection, createNamingReviewProjection, namingProviderReceiptSchema, namingResearchPackSchema } from "../../src/domain/naming-brain";
import { buildNamingManagedRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { receipt } from "../domain/naming-brain-fixtures";
import { createTestDatabase } from "../database/local-supabase";
import { brainWorker, installBrainFixture } from "../database/naming-brain-fixture";
import { historicalNamingClaimDatabase } from "../database/naming-brain-historical-claim";
import { progressiveRequest, saveProgressiveOutput, saveProgressivePart, saveProgressiveResearch, seedProgressiveFixture } from "../database/naming-brain-progressive-fixture";

const filename = "20261017171000_local_progressive_receipt_capacity.sql";
const migration = await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8");

describe("progressive receipt-capacity recovery through the actual SDK and SQL (synthetic)", () => {
  it.each(["completed", "cancelled"] as const)("GETs the saved Verifier and honestly closes its %s outcome without another create", async terminal => {
    const db = await createTestDatabase({ before: filename });
    try {
      await installBrainFixture(db);
      const f = await seedProgressiveFixture(db), research = namingResearchPackSchema.parse(await saveProgressiveResearch(f));
      const directorRequest = progressiveRequest(f, "context.direction", { role: "director", snapshot: f.input.snapshot, research }, [research.artifactId]);
      await saveProgressiveOutput(f, "context.direction", directorRequest, { role: "director", round: "initial", feedbackHypotheses: [],
        assignments: f.input.snapshot.preferences.approaches.map((approach, index) => ({ assignmentKey: `guide-${index}`, primaryApproach: approach, additionalApproaches: [],
          territoryId: "synthetic-nature", constructionKey: `construction-${index}`, direction: "A synthetic imaginative association.", targetCount: 50, sourceKeys: [], avoidPatterns: [], freshTerritory: true })) });
      for (let index = 0; index < 16; index++) {
        const part = await saveProgressivePart(f, index, index === 15 ? 4 : 6, f.input.snapshot.preferences.approaches[index % 3]!);
        await brainWorker(db, () => f.store.publishMicrobatch(f.job, part.publication!, new AbortController().signal));
      }
      const part = await saveProgressivePart(f, 16, 6, "invented", { claim: true });
      const request = progressiveRequest(f, "part017.verification", { role: "verifier", snapshot: f.input.snapshot,
        review: createNamingReviewProjection({ runId: f.input.runId, snapshotHash: f.input.snapshot.snapshotHash, candidates: part.candidates }),
        curation: createNamingCurationProjection(part.curation) }, [part.creator.artifactId, part.curation.artifactId]);
      await brainWorker(db, () => f.store.saveProgressiveCallPlan(f.job, "part017.verification", [request]));
      await brainWorker(db, () => f.store.authorizeDispatch(f.job, request));
      const sessionId = "sess_synthetic_receipt_recovery", turnId = "turn_synthetic_receipt_recovery", agentId = "agent_synthetic_receipt_recovery";
      const prior = namingProviderReceiptSchema.parse({ ...receipt("creation", "verifier"), budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
        runId: request.runId, snapshotHash: request.snapshotHash, requestKey: request.requestKey, requestHash: request.requestHash,
        providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey, sessionLimitCents: request.policy.sessionLimitCents,
        sessionId, turnId, agentId, requestId: "req_synthetic_receipt_recovery", observedModel: request.policy.model, callIds: [], artifactItemIds: [] });
      await brainWorker(db, () => f.store.recordReceipt(f.job, prior));
      // Test-only append-only bulk history: genuine bound receipt snapshots with
      // distinct timestamps. The failing append and recovery use the real RPC.
      await db.query(`with base as(select * from fluid_private.naming_brain_receipts where run_id=$1 and call_key=$2 order by created_at desc,id desc limit 1),
        numbered as(select base.*,base.receipt||jsonb_build_object('recordedAt',to_char(timestamptz '2026-10-18T12:00:00Z'+n*interval '1 millisecond','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) next_receipt
        from base cross join generate_series((select count(*)::integer+1 from fluid_private.naming_brain_receipts where run_id=$1),500) n)
        insert into fluid_private.naming_brain_receipts(run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash)
        select run_id,owner_id,project_id,stage_key,call_key,next_receipt,encode(sha256(convert_to(next_receipt::text,'UTF8')),'hex') from numbered`, [f.input.runId, request.providerCallKey]);
      await expect(brainWorker(db, () => f.store.recordReceipt(f.job, { ...prior, recordedAt: "2026-10-18T14:00:00Z" }))).rejects.toThrow("receipt_capacity");
      await brainWorker(db, () => f.store.completeStep(f.job, "creation", { status: "needs_reconciliation", code: "receipt_capacity", costMicrousd: 0, providerRequestId: null,
        result: { artifactIds: [], errorCode: "receipt_capacity" } }));
      const before = (await db.query(`select
        (select md5(jsonb_agg(to_jsonb(q) order by q.id)::text) from fluid_private.naming_brain_receipts q where run_id=$1) receipts,
        (select md5(jsonb_agg(to_jsonb(q) order by q.call_key)::text) from fluid_private.naming_brain_calls q where run_id=$1) calls,
        (select md5(jsonb_agg(to_jsonb(q) order by q.phase_key)::text) from fluid_private.naming_brain_progressive_plans q where run_id=$1) plans,
        (select md5(jsonb_agg(to_jsonb(q) order by q.position)::text) from fluid_private.naming_brain_feed_entries q where run_id=$1 and position<=94) feed`, [f.input.runId])).rows[0]!;
      const oldReceiptIds = (await db.query<{ id: string }>("select id from fluid_private.naming_brain_receipts where run_id=$1", [f.input.runId])).rows.map(row => row.id);
      await db.exec(migration);
      // Synthetic clock eligibility only. Production recovery keeps its original
      // observation schedule and claims normally once it is due.
      await db.query("update fluid_private.naming_brain_runs set next_observation_at=clock_timestamp()-interval '1 second' where id=$1", [f.input.runId]);
      const store = new NamingBrainJobStore(await historicalNamingClaimDatabase(db), "fixture-deployment"), recovered = await brainWorker(db, () => store.claim("fixture-worker", 120));
      if (!recovered) throw new Error("synthetic_receipt_recovery_claim_missing");
      expect(recovered.id).toBe(f.job.id);
      const methods: string[] = [], wire = buildNamingManagedRequest(request);
      const turn = { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: terminal,
        created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null };
      const item = { id: "item_synthetic_verified_final", type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId,
        content: [{ type: "output_text", text: JSON.stringify({ role: "verifier", findings: [] }) }] };
      const protocol = createNamingManagedProtocol({ apiKey: "synthetic-receipt-recovery-only", localPrototype: true, fetch: async (incoming, init) => {
        const outgoing = new Request(incoming, init), url = new URL(outgoing.url), base = `/v1/agents/sessions/${sessionId}`;
        methods.push(outgoing.method); expect(outgoing.method).toBe("GET");
        if (url.pathname === `${base}/events`) return new Response("", { headers: { "content-type": "text/event-stream" } });
        const value = url.pathname === base ? { id: sessionId, object: "agent.session", agent: { ...wire.agent, id: agentId }, environment: wire.environment,
          metadata: wire.metadata, status: "idle", required_actions: [], usage: null }
          : url.pathname === `${base}/turns` ? { data: [turn], has_more: false }
            : url.pathname === `${base}/turns/${turnId}` ? turn
              : url.pathname === `${base}/turns/${turnId}/items` ? { data: terminal === "completed" ? [item] : [], has_more: false } : null;
        if (!value) throw new Error("unexpected_synthetic_recovery_route");
        return Response.json(value);
      } });
      const handlers = createNamingBrainHandlers({ store, localPrototype: true, assertReady: async () => {},
        runtime: job => createNamingAgentRuntime({ model: f.input.policy.model, protocol, localPrototype: true, persistence: store.runtimePersistence(job), assertContinuation: () => store.assertContinuation(job) }) });
      const steps = handlers.get("naming.generate")!.steps(recovered);
      await brainWorker(db, async () => {
        await store.beginStep(recovered, "creation", steps[0]!.maximumCostMicrousd);
        const outcome = await steps[0]!.execute({ job: recovered, signal: new AbortController().signal });
        expect(outcome.status).toBe(terminal === "completed" ? "succeeded" : "failed");
        await store.completeStep(recovered, "creation", outcome);
        if (terminal === "completed") {
          await store.beginStep(recovered, "prepare", 0);
          const preparation = await steps[1]!.execute({ job: recovered, signal: new AbortController().signal });
          expect(preparation.status).toBe("succeeded"); await store.completeStep(recovered, "prepare", preparation);
        }
        await store.finish(recovered, terminal === "completed" ? "succeeded" : "partial");
      });
      expect(methods.length).toBeGreaterThan(0); expect(methods.every(method => method === "GET")).toBe(true);
      const after = (await db.query(`select
        (select md5(jsonb_agg(to_jsonb(q) order by q.id)::text) from fluid_private.naming_brain_receipts q where id=any($2::uuid[])) receipts,
        (select md5(jsonb_agg(to_jsonb(q) order by q.call_key)::text) from fluid_private.naming_brain_calls q where run_id=$1) calls,
        (select md5(jsonb_agg(to_jsonb(q) order by q.phase_key)::text) from fluid_private.naming_brain_progressive_plans q where run_id=$1) plans,
        (select md5(jsonb_agg(to_jsonb(q) order by q.position)::text) from fluid_private.naming_brain_feed_entries q where run_id=$1 and position<=94) feed`, [f.input.runId, oldReceiptIds])).rows[0];
      expect(after).toEqual(before);
      expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_feed_entries where run_id=$1", [f.input.runId])).rows).toEqual([{ count: terminal === "completed" ? 100 : 94 }]);
      expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_progressive_results where run_id=$1", [f.input.runId])).rows).toEqual([{ count: terminal === "completed" ? 1 : 0 }]);
      expect((await db.query<{ count: number }>("select count(*)::integer count from fluid_private.naming_brain_receipts where run_id=$1", [f.input.runId])).rows[0]!.count).toBeGreaterThan(500);
      expect((await db.query("select payload#>>'{turn,status}' status from fluid_private.naming_brain_provider_records where run_id=$1 and call_key=$2 and kind='provider_turn'", [f.input.runId, request.providerCallKey])).rows).toEqual([{ status: terminal }]);
      expect((await db.query("select count(*)::integer count from fluid_private.naming_brain_runs where project_id=$1", [f.project])).rows).toEqual([{ count: 1 }]);
    } finally { await db.close(); }
  }, 60_000);
});
