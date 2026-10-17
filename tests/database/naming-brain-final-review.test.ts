import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { beginBrainStage, brainAction, brainGapEnvelope, brainManifest, brainRpc, brainWorker, claimBrain, initialIntent, installBrainFixture, prepareBrainFixture, saveBrainArtifact, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";
import { namingBrainJobInputSchema, namingFeedSchema } from "../../src/domain/naming-brain";
import { normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { createNamingRoleRequest, buildNamingManagedRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingBrainMemory } from "../../src/components/naming/naming-brain-memory";
import { createNamingFeedController } from "../../src/components/naming/naming-feed-controller";
import { projectNameCandidateSchema } from "../../src/domain/project-naming";
import { verifyManagedNamingSource } from "../../src/server/data/naming-brain-provenance";
import type { AuthenticatedContext } from "../../src/server/auth/context";

describe("Naming whole-branch boundary regressions", () => {
  let db: TestDatabase, project: string;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { project = await seedBrainFixture(db); });
  async function finish(job: Awaited<ReturnType<typeof startBrainFixture>>) {
    await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')", [job.id, job.lease_token]));
    await brainAction(db, job, "finish", { state: "succeeded", errorCode: null });
  }
  it("freezes five older owned strong seeds independently of recent50/liked30 bounds and in the selected order", async () => {
    const { job, preparedSetId } = await prepareBrainFixture(db, project, 100); await finish(job);
    await brainRpc(db, "append_prepared_naming_set", [project, preparedSetId]);
    const rows = (await db.query<{ id: string; value: string; rationale: string; origin: unknown }>("select id,value,rationale,origin from public.name_candidates where project_id=$1 order by created_at,id", [project])).rows, seeds = rows.slice(0, 5).reverse(), seed = seeds[0]!;
    for (const row of [seed, ...rows.slice(-35)]) await brainRpc(db, "set_name_retention", [project, row.id, 0, true, false]);
    const steering = await brainRpc<{ feed: { steeringRevision: number; demandSequence: number } }>(db, "steer_naming_feed", [project, { expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, candidateIds: seeds.map(row => row.id), instruction: null, idempotencyKey: "final-review-strong-seed" }]);
    const next = await brainRpc<{ run: { jobId: string } }>(db, "ensure_naming_brain_run", [project, { ...initialIntent("final-review-steered-run"), expectedSteeringRevision: steering.feed.steeringRevision, expectedDemandSequence: steering.feed.demandSequence }]);
    const raw = (await db.query<{ input: unknown }>("select input from public.jobs where id=$1", [next.run.jobId])).rows[0]!.input;
    const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(raw));
    expect(input.snapshot.recentExamples).toHaveLength(50); expect(input.snapshot.likedExamples).toHaveLength(30);
    expect([...input.snapshot.recentExamples, ...input.snapshot.likedExamples].some(row => seeds.some(seed => seed.id === row.candidateId))).toBe(false);
    expect(input.snapshot).toMatchObject({ strongSeedIds: seeds.map(row => row.id), strongSeeds: seeds.map(row => ({ candidateId: row.id, value: row.value, rationale: row.rationale, origin: row.origin, primaryApproach: "real_words" })) });
    const request = createNamingRoleRequest({ runId: input.runId, stageKey: "research", providerCallKey: "research-researcher", input: { role: "researcher", snapshot: input.snapshot }, dependencyArtifactIds: [], policy: createNamingRolePolicy(input.policy, "research", "researcher") });
    const wire = buildNamingManagedRequest(request); if (typeof wire.input !== "string") throw new Error("Expected the actual serialized Naming role input");
    expect(JSON.parse(wire.input).snapshot.strongSeeds[0]).toMatchObject({ candidateId: seed.id, value: seed.value });
    expect((await db.query<{ hash: string }>("select snapshot_hash hash from fluid_private.naming_brain_runs where job_id=$1", [next.run.jobId])).rows[0]!.hash).toBe(input.snapshot.snapshotHash);
  });

  it("preserves imported seed provenance byte-for-byte through parsing and authorizes its exact frozen wire request", async () => {
    const imported = await brainRpc<{ entry: { candidate: { id: string } } }>(db, "import_local_name", [project, 1, { id: crypto.randomUUID(), value: "Juniper", createdAt: "2026-10-16T12:00:00Z", origin: "manual", history: [] }, { description: "A synthetic recovered context" }, "juniper", "final-review-imported-seed"]);
    const steering = await brainRpc<{ feed: { steeringRevision: number; demandSequence: number } }>(db, "steer_naming_feed", [project, { expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, candidateIds: [imported.entry.candidate.id], instruction: null, idempotencyKey: "final-review-imported-steer" }]);
    const next = await brainRpc<{ run: { jobId: string } }>(db, "ensure_naming_brain_run", [project, { ...initialIntent("final-review-imported-run"), expectedSteeringRevision: steering.feed.steeringRevision, expectedDemandSequence: steering.feed.demandSequence }]);
    const raw = (await db.query<{ input: { snapshot: { strongSeeds: { origin: unknown }[] } } }>("select input from public.jobs where id=$1", [next.run.jobId])).rows[0]!.input;
    const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(raw));
    expect(input.snapshot.strongSeeds[0]!.origin).toEqual(raw.snapshot.strongSeeds[0]!.origin);
    const { job } = await claimBrain(db); await brainAction(db, job, "plan", { manifest: brainManifest, gapEnvelope: brainGapEnvelope }); await beginBrainStage(db, job, "research");
    const request = createNamingRoleRequest({ runId: input.runId, stageKey: "research", providerCallKey: "research-researcher", input: { role: "researcher", snapshot: input.snapshot }, dependencyArtifactIds: [], policy: createNamingRolePolicy(input.policy, "research", "researcher") });
    await brainAction(db, job, "call_plan", { stageKey: "research", calls: [{ providerCallKey: request.providerCallKey, assignmentKey: null, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents, maxWebSearchCalls: request.policy.maxWebSearchCalls, role: "researcher" }] });
    expect((await brainWorker(db, () => db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb) allowed", [job.id, job.lease_token, JSON.stringify(request)]))).rows[0]).toEqual({ allowed: true });
  });

  it.each(["supported", "corrected", "contradicted", "unresolved"])("projects %s optional factual rationale in every persisted candidate reader while retaining its Creator evidence", async status => {
    const job = await startBrainFixture(db, project), candidateId = crypto.randomUUID(), statement = "Cedar is the Latin word for moon.";
    const proposal = { candidateKey: "cedar", value: "Cedar", primaryApproach: "real_words", additionalApproaches: [], territoryId: "nature", constructionKey: "whole_word", rationale: statement, caution: null, claims: [{ claimKey: "meaning", statement, requirement: "optional", sourceKeys: [], status: "unverified" }] };
    const research = await saveBrainArtifact(db, job, "research", { role: "researcher", territories: [], facts: [], interpretations: [], uncertainties: [] }, { readiness: "sourced", sources: [] });
    await saveBrainArtifact(db, job, "direction", { role: "director", round: "initial", assignments: [], feedbackHypotheses: [] });
    const creator = await saveBrainArtifact(db, job, "creation", { role: "creator", assignmentKey: "real", candidates: [proposal] }, { candidateIds: [{ candidateKey: "cedar", candidateId }] });
    const curator = await saveBrainArtifact(db, job, "curation", { role: "curator", annotations: [], gaps: [] });
    const supported = status === "supported" || status === "corrected", sources = (research as unknown as { sources: { sourceKey: string; excerpt: string; providerItemId: string; contentHash: string }[] }).sources, source = sources[0]!;
    const verifier = await saveBrainArtifact(db, job, "verification", { role: "verifier", findings: [{ assignmentKey: "real", candidateKey: "cedar", claimKey: "meaning", status, supportedWording: supported ? source.excerpt : null, sourceKeys: supported ? [source.sourceKey] : [], evidence: supported ? [{ sourceKey: source.sourceKey, start: 0, end: source.excerpt.length, quote: source.excerpt }] : [], supportsPrimaryApproach: false, explanation: "A synthetic bounded verification finding." }] }, supported ? { sources, sourceDependencies: [{ artifactId: research.artifactId, runId: research.runId, snapshotHash: research.snapshotHash, providerReceipt: research.providerReceipt, sources: sources.map(row => ({ sourceKey: row.sourceKey, providerItemId: row.providerItemId, contentHash: row.contentHash })) }] } : { sources: [] });
    await beginBrainStage(db, job, "gap"); await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'gap','succeeded','{\"artifactIds\":[]}')", [job.id, job.lease_token]));
    await beginBrainStage(db, job, "prepare"); const index = await brainAction(db, job, "index_page", {}) as { epoch: number }; await brainAction(db, job, "index_finalize", { epoch: index.epoch });
    const preparedSet = { version: 1, runId: job.input.runId, stageKey: "prepare", snapshotHash: creator.snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1", targetCount: 100, minimumPerApproach: 5, candidateIds: [candidateId], primaryCounts: [{ approach: "real_words", count: 1 }], retainedUnusedIds: [], fulfillment: { status: "partial", targetCount: 100, acceptedCount: 1, missingCount: 99, coverageSatisfied: false, message: "Synthetic partial." }, deficits: [{ approach: "real_words", required: 5, actual: 1, missing: 4 }], rejected: [], annotations: [], curationArtifactId: curator.artifactId, verificationArtifactId: verifier.artifactId, sourceArtifactIds: [creator.artifactId] };
    const prepared = await brainAction(db, job, "prepare", { preparedSet, candidates: [{ candidateId, sourceArtifactId: creator.artifactId, candidateKey: "cedar", assignmentKey: "real", identityKey: "cedar", runId: job.input.runId, snapshotHash: creator.snapshotHash }], verification: { artifact: verifier } }) as { preparedSetId: string };
    await finish(job);
    const feed = await brainRpc<{ feed: { entries: { entry: { candidate: { rationale: string } }; publishedClaims: unknown[] }[] } }>(db, "append_prepared_naming_set", [project, prepared.preparedSetId]);
    const displayRationale = status === "supported" ? statement : "Optional factual explanation withheld after verification.";
    expect(feed.feed.entries[0]!.entry.candidate.rationale).toBe(displayRationale);
    expect(feed.feed.entries[0]!.publishedClaims).toHaveLength(supported ? 1 : 0);
    const retained = await brainRpc<{ entry: { candidate: { rationale: string } } }>(db, "get_project_name", [project, candidateId]);
    expect(retained.entry.candidate.rationale).toBe(feed.feed.entries[0]!.entry.candidate.rationale);
    const candidate = projectNameCandidateSchema.parse(normalizeNamingStoredJson(retained.entry.candidate));
    expect(candidate.verificationNotes).toEqual([{ claimKey: "meaning", originalStatement: statement, status, explanation: "A synthetic bounded verification finding." }]);
    const proof = await brainRpc(db, "get_naming_brain_candidate_source", [project, candidateId]), auth = { userId: OWNER_A } as AuthenticatedContext;
    expect((await verifyManagedNamingSource(auth, candidate, proof)).sourceCandidate.rationale).toBe(statement);
    await expect(verifyManagedNamingSource(auth, { ...candidate, rationale: status === "supported" ? "Optional factual explanation withheld after verification." : statement }, proof)).rejects.toThrow();
    await expect(verifyManagedNamingSource(auth, { ...candidate, verificationNotes: [] }, proof)).rejects.toThrow();
    await brainRpc(db, "set_name_retention", [project, candidateId, 0, false, true]);
    const library = await brainRpc<{ items: { candidate: typeof candidate }[] }>(db, "get_account_names", [{ filter: "saved" }]);
    expect(library.items[0]!.candidate).toMatchObject({ id: candidateId, rationale: displayRationale, verificationNotes: candidate.verificationNotes });
    await brainRpc(db, "select_project_name", [project, candidateId, 1, false]);
    const overview = await brainRpc<{ currentSelection: { candidate: typeof candidate }; candidates: { items: { candidate: typeof candidate }[] } }>(db, "get_project_naming", [project, {}]);
    expect(overview.currentSelection.candidate.rationale).toBe(displayRationale);
    expect(overview.candidates.items[0]!.candidate).toMatchObject({ rationale: displayRationale, verificationNotes: candidate.verificationNotes });
    const original = (await db.query<{ artifact: typeof creator }>("select artifact from fluid_private.naming_brain_artifacts where id=$1", [creator.artifactId])).rows[0]!.artifact;
    expect(original.output.candidates).toEqual([proposal]);
    expect((await db.query<{ artifact: typeof verifier }>("select artifact from fluid_private.naming_brain_artifacts where id=$1", [verifier.artifactId])).rows[0]!.artifact).toEqual(verifier);
  });

  it("denies all nine reviewed authenticated Naming signatures to a foreign or missing identity", async () => {
    const { job, preparedSetId, preparedSet } = await prepareBrainFixture(db, project, 1); await finish(job);
    const candidateId = preparedSet.candidateIds[0]!, run = await brainRpc<{ revision: number }>(db, "get_naming_brain_run", [project, job.input.runId]);
    const calls: [string, unknown[]][] = [
      ["append_prepared_naming_set", [project, preparedSetId]], ["ensure_naming_brain_run", [project, initialIntent("final-review-foreign-ensure")]],
      ["get_naming_brain_candidate_source", [project, candidateId]], ["get_naming_brain_candidate_sources", [project, [candidateId]]],
      ["get_naming_brain_job_accounting", [job.id]], ["get_naming_brain_run", [project, job.input.runId]], ["get_naming_feed", [project, {}]],
      ["steer_naming_feed", [project, { expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, candidateIds: [candidateId], instruction: null, idempotencyKey: "final-review-foreign-steer" }]],
      ["stop_naming_feed", [project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "final-review-foreign-stop" }]],
    ];
    for (const owner of [OWNER_B, null]) await asRole(db, "authenticated", owner, async () => {
      for (const [name, args] of calls) await expect(db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`, args.map(value => value && typeof value === "object" ? JSON.stringify(value) : value)), name).rejects.toMatchObject({ code: owner === null && ["append_prepared_naming_set", "ensure_naming_brain_run", "steer_naming_feed", "stop_naming_feed"].includes(name) ? "42501" : "P0002" });
    });
    expect((await brainRpc<{ revision: number }>(db, "get_naming_brain_run", [project, job.input.runId])).revision).toBe(run.revision);
    expect((await brainRpc<{ entries: unknown[] }>(db, "get_naming_feed", [project])).entries).toEqual([]);
  });

  it("consumes saved partial membership through the real client controller while paid runtime is unavailable", async () => {
    const { job } = await prepareBrainFixture(db, project, 1); await finish(job);
    await brainRpc(db, "stop_naming_feed", [project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "final-review-partial-stop" }]);
    await db.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1", [OWNER_A]);
    const feed = namingFeedSchema.parse(normalizeNamingStoredJson(await brainRpc(db, "get_naming_feed", [project])));
    expect(feed).toMatchObject({ entries: [], availability: { status: "unavailable" }, activeRun: { canResume: true, canResumeSaved: true, fulfillment: { status: "partial" } } });
    const overview = await brainRpc<{ preferences: Parameters<ReturnType<typeof createNamingBrainMemory>["connectPreferences"]>[2]; project: { context: Parameters<ReturnType<typeof createNamingBrainMemory>["connectPreferences"]>[3] } }>(db, "get_project_naming", [project, {}]);
    const account = { userId: OWNER_A, generation: 1 }, memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account); memory.connectPreferences(account, project, overview.preferences, overview.project.context);
    let posts = 0;
    const controller = createNamingFeedController({ account, projectId: project, memory, eligible: () => true, visible: () => true, request: async (_path, schema, options) => {
      if (options?.method === "POST") { posts++; return schema.parse(normalizeNamingStoredJson(await brainRpc(db, "ensure_naming_brain_run", [project, options.body]))); }
      return schema.parse({ feed });
    } });
    try {
      expect(await controller.load()).toBe(true); expect(await controller.resume()).toBe(true); expect(posts).toBe(1);
      expect(memory.get(account, project)!.feed.entries).toHaveLength(1);
      expect((await db.query<{ runs: number; held: number; calls: number }>("select (select count(*) from fluid_private.naming_brain_runs)::integer runs,(select sum(reserved_microusd) from public.usage_accounts)::integer held,(select count(*) from fluid_private.naming_brain_calls)::integer calls")).rows[0]).toEqual({ runs: 1, held: 5_000_000, calls: 5 });
      expect(memory.get(account, project)!.feed.feed!.activeRun).toMatchObject({ runId: feed.activeRun!.runId, canResumeSaved: false, canResume: false });
    } finally { controller.dispose(); memory.clear(); }
  });
});
