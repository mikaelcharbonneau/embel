import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingPreparedSetSchema, namingRoleOutputSchema, namingVerificationSchema } from "../../src/domain/naming-brain";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { namingRequestHash } from "../../src/server/ai/naming-brain/prompts";
import { runOneJob } from "../../worker/runner";
import { createTestDatabase, type TestDatabase } from "../database/local-supabase";
import { brainPreferences, brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";
import { createSqlNamingHarness, fixtureWorkerId, syntheticReferenceText } from "./naming-brain-sql-runtime-fixture";

describe("Naming actual SDK/store/SQL boundary (inert transports, local migrated PGlite)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("binds 150 raw names, full request hashes, retained sources and Creator item proof to 100 prepared names", async () => {
    const project = await seedBrainFixture(db);
    await brainRpc(db, "save_naming_preferences", [project, 1, { ...brainPreferences, approaches: ["real_words", "invented"] }]);
    const test = createSqlNamingHarness(db);
    await brainWorker(db, () => test.store.attestPendingPreferences());
    await brainRpc(db, "ensure_naming_brain_run", [project, { ...initialIntent(), expectedPreferencesVersion: 2 }]);

    const result = await brainWorker(db, () => runOneJob({ store: test.store, handlers: test.handlers, workerId: fixtureWorkerId }));
    expect({ result, sqlErrors: test.sqlErrors }).toEqual({ result: "succeeded", sqlErrors: [] });
    expect(test.counts()).toMatchObject({ creates: 6, toolReplies: 1, cancellations: 0 });
    expect(test.claims).toHaveLength(1);
    expect(test.claims[0]!.mode).toBe("execute");
    expect(test.dnsReads).toEqual(["www.merriam-webster.com"]);
    expect(test.pageReads).toHaveLength(1);
    expect([...test.sessions.values()].every(session => session.finalSessionReads > 0)).toBe(true);

    const requests = [...test.requests.values()];
    expect(requests.map(request => request.role)).toEqual(["researcher", "director", "creator", "creator", "curator", "verifier"]);
    const savedRequests = (await db.query<{ request: unknown }>("select request from fluid_private.naming_brain_calls where project_id=$1", [project])).rows;
    expect(savedRequests).toHaveLength(6);
    for (const request of requests) {
      expect(request.requestHash).toBe(namingRequestHash(request));
      expect(savedRequests).toContainEqual({ request });
    }

    // Artifacts deliberately have no created_at column; order by their stable ID.
    const artifacts = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where project_id=$1 order by id", [project])).rows.map(row => namingRoleOutputSchema.parse(row.artifact));
    expect(artifacts).toHaveLength(6);
    const creators = artifacts.filter(artifact => artifact.output.role === "creator");
    expect(creators).toHaveLength(2);
    expect(creators.reduce((count, artifact) => count + (artifact.output.role === "creator" ? artifact.output.candidates.length : 0), 0)).toBe(150);
    for (const artifact of creators) {
      if (!("creatorAttribution" in artifact)) throw new Error("Missing actual Creator proof");
      const attribution = artifact.creatorAttribution;
      expect(attribution.assignmentInputHash).toBe(artifact.providerReceipt.requestHash);
      expect(attribution.assignmentKey).toBe(artifact.providerReceipt.assignmentKey);
      const session = test.sessions.get(attribution.sessionId!);
      expect(session?.request.requestHash).toBe(attribution.assignmentInputHash);
      const final = session?.items.find(item => item.id === attribution.itemId);
      expect(final).toMatchObject({ turn_id: attribution.turnId, type: "message", role: "assistant", phase: "final_answer", status: "completed" });
      const content = final!.content as { type: string; text: string }[];
      expect(attribution.itemContentHash).toBe(namingTextHash(content[0]!.text));
      expect(JSON.parse(content[0]!.text)).toEqual(artifact.output);
    }

    const research = artifacts.find(artifact => artifact.output.role === "researcher");
    if (!research || !("sources" in research)) throw new Error("Missing retained research source");
    expect(research.sources).toHaveLength(1);
    expect(research.sources[0]).toMatchObject({ evidenceStatus: "retrieved", excerpt: syntheticReferenceText, contentHash: namingTextHash(syntheticReferenceText), retrieval: { responseHash: namingTextHash(syntheticReferenceText), truncated: false } });
    const verification = namingVerificationSchema.parse(artifacts.find(artifact => artifact.output.role === "verifier"));
    expect(verification.sourceDependencies).toMatchObject([{ artifactId: research.artifactId }]);
    expect(verification.output.findings).toHaveLength(2);
    for (const finding of verification.output.findings) {
      expect(finding.status).toBe("supported");
      expect(finding.evidence).toHaveLength(1);
      for (const evidence of finding.evidence) {
        const source = verification.sources.find(row => row.sourceKey === evidence.sourceKey)!;
        expect(source.excerpt!.slice(evidence.start, evidence.end)).toBe(evidence.quote);
        expect(source.contentHash).toBe(namingTextHash(source.excerpt!));
      }
    }

    const saved = (await db.query<{ prepared: unknown }>("select prepared from fluid_private.naming_brain_prepared_sets where project_id=$1", [project])).rows;
    expect(saved).toHaveLength(1);
    const prepared = namingPreparedSetSchema.parse(saved[0]!.prepared);
    expect(prepared.candidateIds).toHaveLength(100);
    expect(prepared.retainedUnusedIds).toHaveLength(50);
    expect(prepared.fulfillment).toMatchObject({ status: "complete", acceptedCount: 100, missingCount: 0 });
    expect(prepared.primaryCounts.every(row => row.count >= 5)).toBe(true);
    const run = (await db.query<{ actual_cost_microusd: number | null }>("select actual_cost_microusd from fluid_private.naming_brain_runs where project_id=$1", [project])).rows[0]!;
    expect(run.actual_cost_microusd).toBeNull();
    const held = (await db.query<{ id: string; reserved_cost_microusd: number; state: string; policy_identity: string | null }>("select id,reserved_cost_microusd,state,policy_identity from public.jobs where project_id=$1 and operation='naming.generate' and input->>'version'='2'", [project])).rows[0]!;
    expect(Number(held.reserved_cost_microusd)).toBe(5_000_000);
    expect(held).toMatchObject({ state: "succeeded", policy_identity: null });
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [held.id])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
    const liability = (await db.query<{ reserved: number; state: string }>("select account.reserved_microusd::integer reserved,reservation.state from public.usage_accounts account join public.usage_reservations reservation on reservation.owner_id=account.owner_id where reservation.job_id=$1", [held.id])).rows;
    expect(liability).toEqual([{ reserved: 5_000_000, state: "active" }]);
    const stages = (await db.query<{ step_key: string; state: string }>("select step_key,state from public.job_steps where job_id=$1 order by step_key", [held.id])).rows;
    expect(stages).toEqual(["creation", "curation", "direction", "gap", "prepare", "research", "verification"].map(step_key => ({ step_key, state: "succeeded" })));
    expect(artifacts.every(artifact => artifact.providerReceipt.confirmedActualCostMicrousd === null && artifact.providerReceipt.accountingStatus === "provisional")).toBe(true);
    expect(artifacts.every(artifact => artifact.providerReceipt.usageObservations.some(row => row.scope === "session" && row.totalTokens === 18))).toBe(true);
    expect(artifacts.every(artifact => artifact.providerReceipt.providerCostCounters.some(row => row.kind === "consumed_usd_cents" && row.value === 1))).toBe(true);
  }, 30_000);
});
