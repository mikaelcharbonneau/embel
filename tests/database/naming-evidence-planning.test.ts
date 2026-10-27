import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingProviderReceiptSchema, type NamingEvidenceSource, type NamingModelOutput, type NamingRoleOutput, type NamingStageRequest } from "../../src/domain/naming-brain";
import type { NamingApproach } from "../../src/domain/naming-brain-preferences";
import { NAMING_PROGRESSIVE_FACTUAL_APPROACHES } from "../../src/domain/naming-brain-progressive";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { executeProgressiveNaming } from "../../worker/handlers/naming-progressive";
import { createTestDatabase, type TestDatabase } from "./local-supabase";
import { brainRpc, brainWorker, installBrainFixture } from "./naming-brain-fixture";
import { seedProgressiveFixture } from "./naming-brain-progressive-fixture";
import { evidenceDirectorOutput } from "../fixtures/naming-evidence-plan";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** No HTTP or provider transport: synthetic model observations, real restricted
 * SQL, immutable originals, validators, scheduler, recovery and completion. */
async function scenario(db: TestDatabase, approaches: NamingApproach[], sourced: boolean) {
  const f = await seedProgressiveFixture(db, approaches);
  const calls: NamingStageRequest[] = [], artifacts = new Map<string, NamingRoleOutput>();
  let source: NamingEvidenceSource | undefined;
  const call = async (request: NamingStageRequest) => {
    calls.push(request);
    const suffix = request.providerCallKey.replaceAll(".", "_"), sessionId = `sess_${suffix}`, turnId = `turn_${suffix}`, agentId = `agent_${suffix}`, itemId = `item_${suffix}`;
    const observed = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
      runId: f.input.runId, stageKey: "creation", role: request.role, snapshotHash: request.snapshotHash, providerCallKey: request.providerCallKey,
      assignmentKey: request.assignmentKey, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents,
      dispatchState: "dispatched", requestId: `req_${suffix}`, sessionId, turnId, agentId, responseId: null, callIds: [], observedModel: request.policy.model,
      toolCalls: request.role === "researcher" ? [{ callId: `search_${suffix}`, providerItemId: `web_${suffix}`, type: "web_search", status: "completed" }] : [],
      artifactItemIds: [itemId], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-27T03:00:00Z" });
    let output: NamingModelOutput;
    if (request.input.role === "researcher") {
      if (sourced) {
        const excerpt = "This explicitly synthetic passage supports the fixture's imaginary attribution.", url = "https://www.merriam-webster.com/dictionary/synthetic";
        source = { sourceKey: "synthetic-retained-reference", url, title: "Synthetic reference for offline testing", retrievedAt: observed.recordedAt, providerItemId: `web_${suffix}`,
          provenance: { protocol: "openai_agents", sessionId, turnId, responseId: null, itemId: `web_${suffix}`, observedUrl: url },
          retrieval: { retrievedAt: observed.recordedAt, responseHash: hash(excerpt), extractorVersion: "synthetic-offline-v1", truncated: false },
          evidenceStatus: "retrieved", excerpt, contentHash: hash(excerpt) };
      }
      output = { role: "researcher", territories: [
        { territoryId: "synthetic-reference", title: "Synthetic reference", direction: "Explore the explicit fixture passage.", sourceKeys: source ? [source.sourceKey] : [] },
        { territoryId: "synthetic-sounds", title: "Synthetic sounds", direction: "Explore varied constructions.", sourceKeys: [] },
      ], facts: source ? [{ claimKey: "synthetic-fact", statement: source.excerpt!, sourceKeys: [source.sourceKey], status: "unverified" }] : [], interpretations: [],
        uncertainties: source ? [] : ["The offline research fixture retained no passage; factual routes cannot establish an attribution."] };
    } else if (request.input.role === "director") {
      const unavailable = request.input.snapshot.preferences.approaches.filter((approach): approach is "classical_roots" | "other_languages" | "people_places" | "stories_culture" => !sourced && NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(approach));
      output = evidenceDirectorOutput(request, unavailable);
    } else if (request.input.role === "creator") {
      const assignment = request.input.assignment;
      output = { role: "creator", assignmentKey: assignment.assignmentKey, candidates: Array.from({ length: assignment.targetCount }, (_, index) => ({
        candidateKey: `candidate-${index}`, value: `Synthetic${request.providerCallKey.slice(4, 7)}Name${index}`, primaryApproach: assignment.primaryApproach,
        additionalApproaches: [], territoryId: assignment.territoryId, constructionKey: assignment.constructionKey, rationale: "An explicitly synthetic offline candidate.", caution: null,
        claims: NAMING_PROGRESSIVE_FACTUAL_APPROACHES.has(assignment.primaryApproach) ? [{ claimKey: "synthetic-attribution", requirement: "primary_approach", statement: source!.excerpt!, sourceKeys: [source!.sourceKey], status: "unverified" }] : [],
      })) };
    } else if (request.input.role === "curator") output = { role: "curator", annotations: [], gaps: [] };
    else {
      const input = request.input, assignments = new Map(input.review.artifacts.map(row => [row.artifactKey, row.assignmentKey]));
      output = { role: "verifier", findings: input.review.candidates.flatMap(candidate => candidate.claims.map(claim => ({ assignmentKey: assignments.get(candidate.artifactKey)!, candidateKey: candidate.candidateKey,
        claimKey: claim.claimKey, status: "supported", supportedWording: claim.statement, sourceKeys: [source!.sourceKey], evidence: [{ sourceKey: source!.sourceKey, start: 0, end: source!.excerpt!.length, quote: source!.excerpt! }],
        supportsPrimaryApproach: true, explanation: "Independent synthetic Verifier cites the exact retained fixture passage." }))) };
    }
    await f.store.authorizeDispatch(f.job, request);
    const receipt = await f.store.recordReceipt(f.job, observed);
    if (request.role === "researcher") {
      await f.store.saveProviderItem(f.job, { providerCallKey: request.providerCallKey, sessionId, turnId, itemId: `web_${suffix}`, item: { id: `web_${suffix}`, type: "web_search_call", status: "completed", turn_id: turnId, action: { type: "search", query: "explicit offline synthetic fixture" } } });
      if (source) await f.store.runtimePersistence(f.job).saveToolResult({ providerCallKey: request.providerCallKey, sessionId, turnId, callId: "read_synthetic_reference", requestHash: request.requestHash,
        result: { argumentsHash: hash(source.url), reply: { type: "agent.session.input.tool_result", turn_id: turnId, call_id: "read_synthetic_reference", success: true, output: JSON.stringify(source) } }, sourceEvidence: source });
    }
    const text = JSON.stringify(output);
    await f.store.saveProviderItem(f.job, { providerCallKey: request.providerCallKey, sessionId, turnId, itemId, item: { id: itemId, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text }] } });
    await f.store.saveProviderItem(f.job, { kind: "provider_turn", providerCallKey: request.providerCallKey, sessionId, turnId,
      turn: { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: "completed", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } });
    const artifact = validateNamingRoleOutput({ request, receipt, final: { itemId, itemContentHash: hash(text), text, value: output },
      dependencies: [...artifacts.values()].filter(value => request.dependencyArtifactIds.includes(value.artifactId)), sources: request.role === "researcher" && source ? [source] : [] });
    await f.store.saveArtifact(f.job, artifact); artifacts.set(artifact.artifactId, artifact);
    return { status: "completed" as const, receipt, output: artifact };
  };
  const run = () => brainWorker(db, () => executeProgressiveNaming({ ...f, signal: new AbortController().signal, call }));
  return { ...f, calls, artifacts, run };
}

describe("contract5 evidence planning through actual restricted SQL", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
  afterAll(async () => { await db?.close(); });

  it("retains95, explicit factual limitation and exact plans across recovery without dispatching that route", async () => {
    const f = await scenario(db, ["real_words", "classical_roots"], false), result = await f.run();
    expect(result.complete).toBe(false); expect(result.unavailableApproaches).toMatchObject([{ approach: "classical_roots", reason: "no_retrieved_evidence" }]);
    expect(f.calls.some(request => request.input.role === "creator" && request.input.assignment.primaryApproach === "classical_roots")).toBe(false);
    const feed = await brainRpc(db, "get_naming_feed", [f.project]);
    expect(feed).toMatchObject({ progressive: { publishedCount: 95 }, activeRun: { fulfillment: { acceptedCount: 95, coverageSatisfied: false } } });
    const snapshot = async () => (await db.query("select to_jsonb(p) row from fluid_private.naming_brain_progressive_plans p where run_id=$1 order by phase_key", [f.input.runId])).rows;
    const before = await snapshot(), count = f.calls.length;
    expect((await f.run()).complete).toBe(false); expect(f.calls).toHaveLength(count); expect(await snapshot()).toEqual(before);
    const recovered = structuredClone(await brainWorker(db, () => f.store.loadProgressiveState(f.job)));
    const recoveredPlan = recovered.stage.artifacts.find(row => row.output.role === "director");
    if (!recoveredPlan || recoveredPlan.output.role !== "director" || !("planVersion" in recoveredPlan.output)) throw Error("Missing recovered partition");
    recoveredPlan.output.unavailableApproaches = [];
    const load = vi.spyOn(f.store, "loadProgressiveState").mockResolvedValueOnce(recovered);
    try { await expect(f.run()).rejects.toThrow("Evidence plan must partition"); expect(f.calls).toHaveLength(count); }
    finally { load.mockRestore(); }
    await expect(brainWorker(db, () => f.store.completeStep(f.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }))).rejects.toThrow("progressive_creation_incomplete");
    const plan = [...f.artifacts.values()].find(row => row.output.role === "director")!;
    if (plan.output.role !== "director" || !("planVersion" in plan.output)) throw Error("Missing evidence partition");
    expect(plan.output.unavailableApproaches[0]!.explanation).toContain("retained no passages");
    const changed = structuredClone(plan); if (changed.output.role !== "director" || !("planVersion" in changed.output)) throw Error("Missing evidence partition");
    changed.output.unavailableApproaches[0]!.explanation = "A changed immutable limitation.";
    await expect(brainWorker(db, () => f.store.saveArtifact(f.job, changed))).rejects.toThrow();
    await brainWorker(db, () => f.store.completeStep(f.job, "creation", { status: "failed", code: "naming_evidence_unavailable", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [...f.artifacts.keys()], errorCode: "naming_evidence_unavailable" } }));
    await brainWorker(db, () => f.store.finish(f.job, "partial"));
    expect(await brainRpc(db, "get_naming_feed", [f.project])).toMatchObject({ activeRun: { state: "partial", fulfillment: { acceptedCount: 95, coverageSatisfied: false } } });
  }, 60_000);

  it("creates no Creator calls when every selected factual route lacks evidence and retains terminal reasons", async () => {
    const f = await scenario(db, ["classical_roots", "other_languages"], false), result = await f.run();
    expect(result.complete).toBe(false); expect(f.calls.map(request => request.role)).toEqual(["researcher", "director"]);
    expect(result.unavailableApproaches).toHaveLength(2);
    expect((await f.run()).complete).toBe(false); expect(f.calls).toHaveLength(2);
    await brainWorker(db, () => f.store.completeStep(f.job, "creation", { status: "failed", code: "naming_evidence_unavailable", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [...f.artifacts.keys()], errorCode: "naming_evidence_unavailable" } }));
    await brainWorker(db, () => f.store.finish(f.job, "failed"));
    expect(await brainRpc(db, "get_naming_feed", [f.project])).toMatchObject({ entries: [], activeRun: { state: "failed" } });
    expect((await db.query("select output->>'errorCode' code from fluid_private.naming_brain_stage_results where run_id=$1 and stage_key='creation'", [f.input.runId])).rows).toEqual([{ code: "naming_evidence_unavailable" }]);
  }, 60_000);

  it("completes100 across all four factual routes only with independently quoted evidence and original coverage proof", async () => {
    const f = await scenario(db, ["classical_roots", "other_languages", "people_places", "stories_culture"], true);
    expect(await f.run()).toMatchObject({ complete: true, unavailableApproaches: [] });
    await brainWorker(db, async () => {
      await f.store.completeStep(f.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [...f.artifacts.keys()] } });
      await f.store.beginStep(f.job, "prepare", 0);
      const proof = await f.store.finalizeProgressive(f.job); expect(proof.publishedCount).toBe(100);
      expect(await f.store.finalizeProgressive(f.job)).toEqual(proof);
      await f.store.completeStep(f.job, "prepare", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } });
      await f.store.finish(f.job, "succeeded");
    });
    const feed = await brainRpc<{ entries: { primaryApproach: string; publishedClaims: { evidence: { quote: string }[] }[] }[]; activeRun: unknown }>(db, "get_naming_feed", [f.project]);
    expect(feed.entries).toHaveLength(100);
    for (const approach of f.input.snapshot.preferences.approaches) expect(feed.entries.filter(row => row.primaryApproach === approach).length).toBeGreaterThanOrEqual(5);
    expect(feed.entries.every(row => row.publishedClaims.length > 0 && row.publishedClaims.every(claim => claim.evidence[0]!.quote.includes("explicitly synthetic")))).toBe(true);
    expect(feed.activeRun).toMatchObject({ state: "succeeded", fulfillment: { acceptedCount: 100, coverageSatisfied: true, status: "complete" } });
  }, 60_000);
});
