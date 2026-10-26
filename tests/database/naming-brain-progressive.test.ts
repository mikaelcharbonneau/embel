import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// This suite exercises the synthetic execution contract, not real provider readiness.
import { namingBrainRunSchema, namingFeedEnsureResultSchema, namingFeedSchema, namingProgressiveCompletionSchema, namingStageKeySchema, namingProgressiveAssignmentSchema, namingProviderReceiptSchema, namingCreatorSetSchema, namingCurationSchema, namingVerificationSchema, namingResearchPackSchema, createNamingReviewProjection, createNamingCurationProjection, validateNamingCreatorSet } from "../../src/domain/naming-brain";
import { createNamingMicrobatch } from "../../src/domain/naming-brain-progressive";
import { namingAnyBatchDetailResponseSchema } from "../../src/domain/naming-jobs";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { getNamingFeed, getNamingBrainRun } from "../../src/server/data/naming-brain";
import { createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainAction, brainManifest, brainRpc, brainWorker, brainPreferences, installBrainFixture, seedBrainFixture, startBrainFixture, saveBrainArtifact } from "./naming-brain-fixture";
import { progressiveRequest, recordProgressiveOutput, saveProgressiveOutput, saveProgressivePart, saveProgressiveResearch, seedProgressiveFixture, type ProgressiveFixture } from "./naming-brain-progressive-fixture";

const migration = "20261017170000_local_progressive_naming.sql";
const parse = <T>(schema: { parse(input: unknown): T }, value: unknown) => schema.parse(normalizeNamingStoredJson(value));
describe("future-only progressive Naming publication over restricted SQL (synthetic)", () => {
 let db: TestDatabase, fixture: ProgressiveFixture;
 beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
 beforeEach(async () => { fixture = await seedProgressiveFixture(db); });
 afterEach(() => vi.unstubAllEnvs());
 afterAll(async () => { await db?.close(); });
 const publish = (part: Awaited<ReturnType<typeof saveProgressivePart>>) => {
  if (!part.publication) throw Error("synthetic_publication_missing");
  return brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
 };
 const feed = async () => parse(namingFeedSchema, await brainRpc(db, "get_naming_feed", [fixture.project]));
 const run = async () => parse(namingBrainRunSchema, await brainRpc(db, "get_naming_brain_run", [fixture.project, fixture.input.runId]));
 async function fill() {
  const ids: string[] = [];
  for (let index = 0; index < 17; index++) ids.push(...(await publish(await saveProgressivePart(fixture, index, index === 16 ? 4 : 6, fixture.input.snapshot.preferences.approaches[index % fixture.input.snapshot.preferences.approaches.length]!))).entryIds);
  return ids;
 }
 function localReader() {
  for (const key of Object.keys(process.env)) if (key === "VERCEL" || key.startsWith("VERCEL_")) vi.stubEnv(key, undefined);
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("FLUID_LOCAL_PROTOTYPE", "true"); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3106");
  const keys: Record<string, string[]> = { get_naming_feed: ["p_project_id", "p_query"], get_naming_brain_run: ["p_project_id", "p_run_id"], get_naming_brain_candidate_sources: ["p_project_id", "p_candidate_ids"] };
  return { userId: OWNER_A, client: createClient("https://synthetic-reader.invalid", "synthetic-anon-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (incoming, init) => {
   const request = new Request(incoming, init), name = new URL(request.url).pathname.split("/").at(-1)!;
   if (!keys[name]) throw Error("unexpected_synthetic_reader_rpc"); const args = await request.json();
   return Response.json(await brainRpc(db, name, keys[name]!.map(key => args[key])));
  } } }) };
 }

 it("saves the actual two-stage profile and publishes an independently reviewed group while other work remains active", async () => {
  expect(fixture.input).toMatchObject({ localPipelineVersion: 2, localTimingVersion: 2 });
  const research = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [research]));
  await brainWorker(db, () => fixture.store.authorizeDispatch(fixture.job, research));
  const part = await saveProgressivePart(fixture, 0, 4), result = await publish(part);
  expect(result).toMatchObject({ publishedCount: 4, complete: false }); expect(result.entryIds).toHaveLength(4);
  const active = await feed(); expect(active).toMatchObject({ progressive: { version: 1, targetCount: 100, publishedCount: 4 }, activeRun: { state: "running", localPipelineVersion: 2, fulfillment: { status: "partial", acceptedCount: 4 } } });
  expect(active.entries.map(row => row.entry.candidate.id)).toEqual(result.candidateIds);
  expect((await run()).stages.map(stage => [stage.stageKey, stage.state])).toEqual([["creation", "running"], ["prepare", "pending"]]);
  const repeated = parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, fixture.intent]));
  expect(repeated).toMatchObject({ status: "pending", reused: true });
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_runs")).rows).toEqual([{ count: 1 }]);
  for (const candidateId of result.candidateIds) expect(await brainRpc(db, "get_naming_brain_candidate_source", [fixture.project, candidateId])).toMatchObject({ preparedSetId: null, microbatchId: result.publicationId, verificationMode: "not_required", verificationArtifactId: null });
  const detail = parse(namingAnyBatchDetailResponseSchema, await brainRpc(db, "get_naming_batch", [fixture.project, fixture.input.batchId]));
  expect(detail.job.results).toEqual([]); expect(detail.result).toBeNull();
  await expect(brainRpc(db, "get_naming_feed", [fixture.project], OWNER_B)).rejects.toThrow("not_found");
 });

 it("replays immutable membership after Stop and reload, refuses changed references, and never removes the saved group", async () => {
  const part = await saveProgressivePart(fixture, 0, 4), first = await publish(part);
  const original = (await db.query("select to_jsonb(f) row from fluid_private.naming_brain_feed_entries f where run_id=$1 order by position", [fixture.input.runId])).rows;
  await brainRpc(db, "stop_naming_feed", [fixture.project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "synthetic-progressive-stop" }]);
  expect(await publish(part)).toEqual(first);
  const changed = { ...part.publication!, candidates: part.publication!.candidates.slice(1) };
  await expect(brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, changed, new AbortController().signal))).rejects.toThrow("immutable_microbatch");
  const stopped = await feed(); expect(stopped.paused).toBe(true); expect(stopped.entries).toHaveLength(4);
  expect((await db.query("select to_jsonb(f) row from fluid_private.naming_brain_feed_entries f where run_id=$1 order by position", [fixture.input.runId])).rows).toEqual(original);
  const next = { ...part.publication!, key: "part002" };
  await expect(brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, next, new AbortController().signal))).rejects.toThrow("microbatch_stopped");
 });

 it("persists exact full requests before authorization and replays them after restart without reconstructing a changed plan", async () => {
  const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request]));
  const restarted = new NamingBrainJobStore(db, "fixture-deployment");
  const state = await brainWorker(db, () => restarted.loadProgressiveState(fixture.job, "context.research"));
  expect(state.plannedRequests).toEqual([request]); expect(state.stage.requests).toEqual([]);
  await expect(brainWorker(db, () => restarted.saveProgressiveCallPlan(fixture.job, "context.research", [{ ...request, requestHash: "f".repeat(64) }]))).rejects.toThrow("immutable_call_plan");
  await brainWorker(db, () => restarted.authorizeDispatch(fixture.job, state.plannedRequests[0]!));
  expect((await brainWorker(db, () => restarted.runtimePersistence(fixture.job).load(request))).authorizedAt).toEqual(expect.any(String));
  await expect(brainWorker(db, () => restarted.runtimePersistence(fixture.job).load({ ...request, providerCallKey: "foreign-unplanned-call" }))).rejects.toThrow("unknown_progressive_call");
 });

 it("requires independent curation and factual verification and atomically excludes existing identities", async () => {
  const first = await saveProgressivePart(fixture, 0, 4), published = await publish(first);
  const second = await saveProgressivePart(fixture, 1, 4, "compounds", { values: first.candidates.map(candidate => candidate.value) });
  const duplicate = await publish(second); expect(duplicate.entryIds).toEqual([]); expect(duplicate.publishedCount).toBe(4);
  await expect(brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, { ...first.publication!, key: "part003" }, new AbortController().signal))).rejects.toThrow("completed_microbatch_review_required");
  const claimed = await saveProgressivePart(fixture, 3, 4, "invented", { claim: true });
  const bypass = { version: 1 as const, key: claimed.key, curationArtifactId: claimed.curation.artifactId, candidates: claimed.candidates.map(({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey }) => ({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey })), verification: { kind: "not_required" as const, reason: "no_factual_claims" as const } };
  await expect(brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, bypass, new AbortController().signal))).rejects.toThrow("microbatch_factual_verification_required");
  expect((await feed()).entries.map(row => row.entry.candidate.id)).toEqual(published.candidateIds);
 });

 it("finishes only after100 stable reviewed names, route floors and the genuine external Research attempt, then replays an empty ACK", async () => {
  const firstIds = await fill();
  expect(firstIds).toHaveLength(100);
  await expect(brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }))).rejects.toThrow("external_research_attempt_required");
  await saveProgressiveResearch(fixture);
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
  await brainWorker(db, () => fixture.store.beginStep(fixture.job, "prepare", 0));
  const completion = await brainWorker(db, () => fixture.store.finalizeProgressive(fixture.job));
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "prepare", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
  await brainWorker(db, () => fixture.store.finish(fixture.job, "succeeded"));
  const final = await feed(); expect(final.entries.map(row => row.entryId)).toEqual(firstIds); expect(final.activeRun).toMatchObject({ state: "succeeded", preparedSetId: null, progressiveCompletionId: completion.completionId, fulfillment: { status: "complete" } });
  const proof = (await db.query<{ result: unknown }>("select result from fluid_private.naming_brain_progressive_results where run_id=$1", [fixture.input.runId])).rows[0]!.result;
  expect(namingProgressiveCompletionSchema.parse(proof).entryIds).toEqual(firstIds);
  const detail = parse(namingAnyBatchDetailResponseSchema, await brainRpc(db, "get_naming_batch", [fixture.project, fixture.input.batchId]));
  expect(detail.job.results[0]!.output).toMatchObject({ localPipelineVersion: 2, completionId: completion.completionId });
  expect(detail.job.results[0]!.output).not.toHaveProperty("preparedSet");
  const replay = parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, fixture.intent]));
  expect(replay).toMatchObject({ status: "appended", appendedEntryIds: [] });
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_runs")).rows).toEqual([{ count: 1 }]);
  await brainRpc(db, "stop_naming_feed", [fixture.project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "synthetic-pause-completed100" }]);
  const paused = await feed(); expect(paused).toMatchObject({ paused: true, activeRun: { canResume: true, canResumeSaved: true, preparedSetId: null, progressiveCompletionId: completion.completionId } });
  const savedIntent = { ...fixture.intent, reason: "resume", expectedDemandSequence: paused.demandSequence, resumeOfRunId: fixture.input.runId, expectedRunRevision: paused.activeRun!.revision, idempotencyKey: "synthetic-continue-saved100" };
  const continued = parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, savedIntent]));
  expect(continued).toMatchObject({ status: "appended", appendedEntryIds: [], feed: { paused: false } });
  expect(continued.feed.entries.map(row => row.entryId)).toEqual(firstIds);
  expect(continued.feed.activeRun!.demandSequence).toBe(0); expect(continued.feed.demandSequence).toBe(2);
  expect(parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, savedIntent])).status).toBe("appended");
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_runs")).rows).toEqual([{ count: 1 }]);
  const tail = continued.feed.entries.at(-1)!;
  const next = parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, { ...fixture.intent, reason: "scroll", expectedDemandSequence: continued.feed.demandSequence, consumedThrough: { entryId: tail.entryId, position: tail.position }, idempotencyKey: "synthetic-wheel-after-continue" }]));
  expect(next.status).toBe("pending"); expect(next.feed.entries.map(row => row.entryId)).toEqual(firstIds);
 });

 it.each(["after_creation", "after_finalization"])("reclaims %s without repeating a provider call or replacing published membership", async window => {
  const ids = await fill(); await saveProgressiveResearch(fixture);
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
  if (window === "after_finalization") {
   await brainWorker(db, () => fixture.store.beginStep(fixture.job, "prepare", 0)); await brainWorker(db, () => fixture.store.finalizeProgressive(fixture.job));
  }
  const before = (await db.query("select to_jsonb(c) row from fluid_private.naming_brain_calls c where run_id=$1 order by call_key", [fixture.input.runId])).rows;
  // Only the disposable lease clock advances; ordinary maintenance and claim
  // decide the recovery mode exactly as a real process restart would.
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [fixture.job.id]);
  const restarted = new NamingBrainJobStore(db, "fixture-deployment");
  expect(await brainWorker(db, () => restarted.expireLeases("fixture-worker"))).toBe(1);
  const recovered = await brainWorker(db, () => restarted.claim("fixture-worker", 120)); expect(recovered?.id).toBe(fixture.job.id); if (!recovered) throw Error("synthetic_recovery_missing");
  expect(await brainWorker(db, () => restarted.beginStep(recovered, "creation", 1_500_000))).toBe("already_succeeded");
  await brainWorker(db, () => restarted.beginStep(recovered, "prepare", 0)); await brainWorker(db, () => restarted.finalizeProgressive(recovered));
  await brainWorker(db, () => restarted.completeStep(recovered, "prepare", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
  await brainWorker(db, () => restarted.finish(recovered, "succeeded"));
  expect((await feed()).entries.map(row => row.entryId)).toEqual(ids);
  expect((await db.query("select to_jsonb(c) row from fluid_private.naming_brain_calls c where run_id=$1 order by call_key", [fixture.input.runId])).rows).toEqual(before);
 });

 it.each(["partial", "failed"] as const)("preserves raw %s history after a lost finalization ACK while exposing genuine complete membership and free Continue", async state => {
  const ids = await fill(); await saveProgressiveResearch(fixture);
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
  await brainWorker(db, () => fixture.store.beginStep(fixture.job, "prepare", 0)); const completed = await brainWorker(db, () => fixture.store.finalizeProgressive(fixture.job));
  // The commit succeeded, but the caller lost its ACK and reported the local
  // preparation attempt as failed. Its genuine membership is still authoritative.
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "prepare", { status: "failed", code: "naming_stage_invalid", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }));
  await brainWorker(db, () => fixture.store.finish(fixture.job, state));
  const auth = localReader(), actual = await getNamingBrainRun(auth, fixture.project, fixture.input.runId);
  expect(actual).toMatchObject({ state: "succeeded", progressiveCompletionId: completed.completionId, preparedSetId: null }); expect(actual.stages[1]!.state).toBe("failed");
  expect((await db.query("select state from public.jobs where id=$1", [fixture.job.id])).rows).toEqual([{ state }]);
  await brainRpc(db, "stop_naming_feed", [fixture.project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: `synthetic-pause-${state}-complete` }]);
  const paused = await getNamingFeed(auth, fixture.project); expect(paused.activeRun?.canResumeSaved).toBe(true); expect(paused).not.toHaveProperty("canPrefetchOnScroll");
  await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, { ...fixture.intent, reason: "resume", expectedDemandSequence: paused.demandSequence, resumeOfRunId: fixture.input.runId, expectedRunRevision: paused.activeRun!.revision, idempotencyKey: `synthetic-free-${state}-continue` }]);
  const continued = await getNamingFeed(auth, fixture.project); expect(continued.canPrefetchOnScroll).toBe(true); expect(continued.entries.map(row => row.entryId)).toEqual(ids);
  expect((await db.query("select count(*)::int count from public.jobs where project_id=$1", [fixture.project])).rows).toEqual([{ count: 1 }]);
 });

 it("keeps100 published names readable while an issued Director remains unknown, without Resume or another admission", async () => {
  const ids = await fill(), research = namingResearchPackSchema.parse(await saveProgressiveResearch(fixture));
  const request = progressiveRequest(fixture, "context.direction", { role: "director", snapshot: fixture.input.snapshot, research }, [research.artifactId]);
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.direction", [request])); await brainWorker(db, () => fixture.store.authorizeDispatch(fixture.job, request));
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "needs_reconciliation", costMicrousd: 0, providerRequestId: null, code: "session_identity_unknown", result: { artifactIds: [] } }));
  const unresolved = await feed(); expect(unresolved.entries.map(row => row.entryId)).toEqual(ids); expect(unresolved.activeRun).toMatchObject({ state: "needs_reconciliation", canResume: false, preparedSetId: null, fulfillment: { status: "complete" } });
  const repeated = parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, fixture.intent]));
  expect(repeated).toMatchObject({ status: "blocked", code: "completion_unresolved" });
  expect((await run()).stages[0]!.state).toBe("unresolved"); expect((await db.query("select count(*)::int count from fluid_private.naming_brain_runs")).rows).toEqual([{ count: 1 }]);
 });

 it.each(["steering", "preferences", "context"])("retains published rows but stops future authorization on changed %s", async change => {
  const part = await saveProgressivePart(fixture, 0, 4), original = await publish(part);
  const next = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [next]));
  if (change === "steering") {
   const steered = await brainRpc(db, "steer_naming_feed", [fixture.project, { expectedProjectRevision: 1, expectedPreferencesVersion: 2, expectedSteeringRevision: 0, candidateIds: [original.candidateIds[0]], instruction: "Explore an additional synthetic direction.", idempotencyKey: "synthetic-progressive-steer" }]);
   expect(steered).toMatchObject({ supersededRunIds: [fixture.input.runId], cancellationRequestedRunIds: [fixture.input.runId] });
  } else if (change === "preferences") await brainRpc(db, "save_naming_preferences", [fixture.project, 2, { ...brainPreferences, approaches: fixture.input.snapshot.preferences.approaches, notes: "Changed synthetic preference." }]);
  else {
   const context = (await db.query<{ context: Record<string, unknown> }>("select context from public.project_revisions where project_id=$1 and revision=1", [fixture.project])).rows[0]!.context;
   await brainRpc(db, "append_project_revision", [fixture.project, 1, { ...context, description: "A materially changed synthetic brief." }, "f".repeat(64)]);
  }
  expect((await feed()).entries.map(row => row.entryId)).toEqual(original.entryIds);
  await expect(brainWorker(db, () => fixture.store.authorizeDispatch(fixture.job, next))).rejects.toThrow("naming_dispatch_unavailable");
  expect(await brainWorker(db, () => fixture.store.resumeExecution(fixture.job, "creation"))).toBe(false);
  await brainWorker(db, () => fixture.store.heartbeat(fixture.job, 120));
  expect((await db.query("select state,cancel_requested_at is not null cancelled from public.jobs where id=$1", [fixture.job.id])).rows).toEqual([{ state: "cancel_requested", cancelled: true }]);
 });

 it("keeps a stopped100 group readable and permits only an explicit new linked child after genuine terminal closure", async () => {
  const ids = await fill(); await saveProgressiveResearch(fixture, false);
  await brainRpc(db, "stop_naming_feed", [fixture.project, { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "synthetic-stop-before-final" }]);
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "failed", costMicrousd: 0, providerRequestId: null, code: "observation_cancelled", result: { artifactIds: [] } }));
  await brainWorker(db, () => fixture.store.finish(fixture.job, "cancelled"));
  const stopped = await feed(); expect(stopped.entries.map(row => row.entryId)).toEqual(ids); expect(stopped.activeRun).toMatchObject({ state: "cancelled", canResume: true, preparedSetId: null });
  expect(stopped.activeRun).not.toHaveProperty("progressiveCompletionId");
  const same = parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, fixture.intent])); expect(same).toMatchObject({ status: "incomplete", canResume: true });
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_runs")).rows).toEqual([{ count: 1 }]);
  const explicit = parse(namingFeedEnsureResultSchema, await brainRpc(db, "ensure_local_naming_brain_run", [fixture.project, { ...fixture.intent, expectedDemandSequence: stopped.demandSequence, reason: "resume", resumeOfRunId: fixture.input.runId, expectedRunRevision: stopped.activeRun!.revision, idempotencyKey: "synthetic-explicit-new-child" }]));
  expect(explicit).toMatchObject({ status: "pending", run: { resumedFromRunId: fixture.input.runId, localPipelineVersion: 2 } });
  expect((await feed()).entries.map(row => row.entryId)).toEqual(ids);
 });

 it("retains exact invalid-output Director proof as terminal while finalizing100 genuine reviewed names", async () => {
  await fill(); const research = namingResearchPackSchema.parse(await saveProgressiveResearch(fixture));
  const request = progressiveRequest(fixture, "context.direction", { role: "director", snapshot: fixture.input.snapshot, research }, [research.artifactId]);
  const raw = await recordProgressiveOutput(fixture, "context.direction", request, { role: "director", round: "initial", assignments: [], feedbackHypotheses: [] });
  const output = { artifactIds: [], partialArtifacts: [{ providerCallKey: request.providerCallKey, status: "failed", code: "provider_output_invalid", receipt: raw.providerReceipt }] };
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: output }));
  expect((await db.query("select fluid_private.naming_brain_call_terminal(c) terminal from fluid_private.naming_brain_calls c where run_id=$1 and phase_key='context.direction'", [fixture.input.runId])).rows).toEqual([{ terminal: true }]);
  await brainWorker(db, () => fixture.store.beginStep(fixture.job, "prepare", 0)); expect(await brainWorker(db, () => fixture.store.finalizeProgressive(fixture.job))).toMatchObject({ publishedCount: 100 });
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_artifacts where run_id=$1 and artifact#>>'{output,role}'='director'", [fixture.input.runId])).rows).toEqual([{ count: 0 }]);
 });

 it("reserves the five remaining factual-route credits instead of filling100 entirely with faster creative names", async () => {
  fixture = await seedProgressiveFixture(db, ["real_words", "people_places"]);
  for (let index = 0; index < 17; index++) await publish(await saveProgressivePart(fixture, index));
  const held = await feed(); expect(held.entries).toHaveLength(95); expect(held.progressive?.publishedCount).toBe(95); expect(held.activeRun?.fulfillment).toMatchObject({ status: "partial", acceptedCount: 95, coverageSatisfied: false });
  await expect(brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { artifactIds: [] } }))).rejects.toThrow("progressive_creation_incomplete");
 });

 it("allows bounded v2 evidence beyond the old500-record limit while preserving that exact legacy bound", async () => {
  const research = await saveProgressiveResearch(fixture), receipt = research.providerReceipt;
  await db.query("insert into fluid_private.naming_brain_provider_records(run_id,owner_id,project_id,stage_key,call_key,kind,record_key,payload) select $1,$2,$3,'creation',$4,'provider_item','synthetic-capacity-'||n,jsonb_build_object('providerCallKey',$4::text,'sessionId',$5::text,'turnId',$6::text,'itemId','synthetic-capacity-'||n,'item',jsonb_build_object('id','synthetic-capacity-'||n,'type','reasoning','content',jsonb_build_array())) from generate_series(1,500) n", [fixture.input.runId, OWNER_A, fixture.project, receipt.providerCallKey, receipt.sessionId, receipt.turnId]);
  await brainWorker(db, () => fixture.store.saveProviderItem(fixture.job, { providerCallKey: receipt.providerCallKey, sessionId: receipt.sessionId!, turnId: receipt.turnId!, itemId: "synthetic-capacity-after500", item: { id: "synthetic-capacity-after500", type: "reasoning" } }));
  expect((await brainWorker(db, () => fixture.store.loadProgressiveState(fixture.job))).stage.providerItems.length).toBeGreaterThan(500);
  const oldDb = await createTestDatabase();
  try {
   await installBrainFixture(oldDb); const project = await seedBrainFixture(oldDb), job = await startBrainFixture(oldDb, project);
   const artifact = await saveBrainArtifact(oldDb, job, "research", { role: "researcher", facts: [], interpretations: [], uncertainties: [] }, { readiness: "partial", sources: [] });
   const r = artifact.providerReceipt;
   await oldDb.query("insert into fluid_private.naming_brain_provider_records(run_id,owner_id,project_id,stage_key,call_key,kind,record_key,payload) select $1,$2,$3,'research',$4,'provider_item','synthetic-native-capacity-'||n,jsonb_build_object('providerCallKey',$4::text,'sessionId',$5::text,'turnId',$6::text,'itemId','synthetic-native-capacity-'||n,'item',jsonb_build_object('id','synthetic-native-capacity-'||n,'type','reasoning')) from generate_series(1,500) n", [job.input.runId, OWNER_A, project, r.providerCallKey, r.sessionId, r.turnId]);
   await expect(brainAction(oldDb, job, "provider_item", { providerCallKey: r.providerCallKey, sessionId: r.sessionId, turnId: r.turnId, itemId: "synthetic-native-after500", item: { id: "synthetic-native-after500", type: "reasoning" } })).rejects.toThrow("provider_record_capacity");
  } finally { await oldDb.close(); }
 });

 it("closes a definite provider HTTP rejection as failed on its first observation without settling the hold or inventing a Session", async () => {
  const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
  await brainWorker(db, () => fixture.store.saveProgressiveCallPlan(fixture.job, "context.research", [request])); await brainWorker(db, () => fixture.store.authorizeDispatch(fixture.job, request));
  const receipt = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
   runId: fixture.input.runId, stageKey: "creation", role: "researcher", snapshotHash: fixture.input.snapshot.snapshotHash, providerCallKey: request.providerCallKey, assignmentKey: null, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents,
   dispatchState: "not_dispatched", requestId: "req_synthetic_http400", sessionId: null, turnId: null, agentId: null, responseId: null, callIds: [], observedModel: null, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null, providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-18T10:00:00Z" });
  await brainWorker(db, () => fixture.store.recordReceipt(fixture.job, receipt));
  const held = (await db.query("select to_jsonb(r) reservation from public.usage_reservations r where job_id=$1", [fixture.job.id])).rows;
  await brainWorker(db, () => fixture.store.completeStep(fixture.job, "creation", { status: "failed", costMicrousd: 0, providerRequestId: null, code: "provider_request_rejected", result: { artifactIds: [], errorCode: "provider_request_rejected" } }));
  await brainWorker(db, () => fixture.store.finish(fixture.job, "failed"));
  expect((await run()).state).toBe("failed"); expect((await run()).canResume).toBe(true);
  expect((await db.query("select to_jsonb(r) reservation from public.usage_reservations r where job_id=$1", [fixture.job.id])).rows).toEqual(held);
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_provider_records where run_id=$1", [fixture.input.runId])).rows).toEqual([{ count: 0 }]);
 });

 it("publishes factual primary credit only from a real quoted Verifier result and rejects a forged quote", async () => {
  fixture = await seedProgressiveFixture(db, ["people_places"]);
  for (const [index, forged] of [[0, false], [1, true]] as const) {
   const key = `part00${index + 1}`;
   const assignment = namingProgressiveAssignmentSchema.parse({ assignmentKey: `${key}-place`, primaryApproach: "people_places", additionalApproaches: [], territoryId: "synthetic-place", constructionKey: "proper-name", direction: "A synthetic factual route requiring verification.", targetCount: 1, sourceKeys: [], avoidPatterns: [], freshTerritory: true,
    runId: fixture.input.runId, snapshotHash: fixture.input.snapshot.snapshotHash, assignmentOrder: index, round: "initial", sources: [], assignmentBasis: { kind: "brief_seed", snapshotHash: fixture.input.snapshot.snapshotHash } });
   const creatorRequest = progressiveRequest(fixture, `${key}.creation`, { role: "creator", snapshot: fixture.input.snapshot, assignment });
   const proposal = { candidateKey: "place", value: `SyntheticPlace${index}`, primaryApproach: "people_places", additionalApproaches: [], territoryId: assignment.territoryId, constructionKey: assignment.constructionKey, rationale: "Synthetic place association.", caution: null,
    claims: [{ claimKey: "place-claim", requirement: "primary_approach", statement: "The synthetic fixture identifies this place.", sourceKeys: [], status: "unverified" }] };
   const creator = namingCreatorSetSchema.parse(await saveProgressiveOutput(fixture, `${key}.creation`, creatorRequest, { role: "creator", assignmentKey: assignment.assignmentKey, candidates: [proposal] }, { candidateIds: [{ candidateKey: "place", candidateId: crypto.randomUUID() }] }));
   const candidates = validateNamingCreatorSet(fixture.input.snapshot, assignment, creator).accepted;
   const review = createNamingReviewProjection({ runId: fixture.input.runId, snapshotHash: fixture.input.snapshot.snapshotHash, candidates });
   const curatorRequest = progressiveRequest(fixture, `${key}.curation`, { role: "curator", snapshot: fixture.input.snapshot, review, validationRejections: [] }, [creator.artifactId]);
   const curation = namingCurationSchema.parse(await saveProgressiveOutput(fixture, `${key}.curation`, curatorRequest, { role: "curator", annotations: [], gaps: [] }));
   const verifierRequest = progressiveRequest(fixture, `${key}.verification`, { role: "verifier", snapshot: fixture.input.snapshot, review, curation: createNamingCurationProjection(curation) }, [creator.artifactId, curation.artifactId]);
   const suffix = verifierRequest.providerCallKey.replaceAll(".", "_"), excerpt = "The synthetic fixture identifies this place.";
   const hash = (await import("node:crypto")).createHash("sha256").update(excerpt).digest("hex"), at = "2026-10-18T10:00:00Z", url = "https://www.merriam-webster.com/dictionary/synthetic";
   const source = { sourceKey: `source-${index}`, url, title: "Synthetic reference", retrievedAt: at, providerItemId: `web_${suffix}`, evidenceStatus: "retrieved", excerpt, contentHash: hash,
    provenance: { protocol: "openai_agents", sessionId: `sess_${suffix}`, turnId: `turn_${suffix}`, responseId: null, itemId: `web_${suffix}`, observedUrl: url }, retrieval: { retrievedAt: at, responseHash: hash, extractorVersion: "synthetic-v1", truncated: false } };
   const output = { role: "verifier", findings: [{ assignmentKey: assignment.assignmentKey, candidateKey: "place", claimKey: "place-claim", status: "supported", supportedWording: excerpt, sourceKeys: [source.sourceKey], evidence: [{ sourceKey: source.sourceKey, start: 0, end: forged ? 12 : excerpt.length, quote: forged ? "Forged quote" : excerpt }], supportsPrimaryApproach: true, explanation: "The exact retained fixture passage supports this synthetic claim." }] };
   if (forged) {
    const raw = await recordProgressiveOutput(fixture, `${key}.verification`, verifierRequest, output, { sources: [source], sourceDependencies: [] }, true);
    expect(namingVerificationSchema.safeParse(raw).success).toBe(false);
    // Deliberately bypass only the TypeScript decoder to test the restricted SQL
    // publication boundary against a bad genuine model response.
    await brainAction(db, { id: fixture.job.id, lease_token: fixture.job.leaseToken }, "artifact", { artifact: raw });
    const proof = { version: 1, key, candidates: candidates.map(({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey }) => ({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey })), curationArtifactId: curation.artifactId, verification: { kind: "verified", artifactId: raw.artifactId } };
    await expect(brainWorker(db, () => fixture.store.action(fixture.job, "publish_microbatch", proof))).rejects.toThrow("microbatch_verification_evidence_mismatch");
   } else {
    const verification = namingVerificationSchema.parse(await saveProgressiveOutput(fixture, `${key}.verification`, verifierRequest, output, { sources: [source], sourceDependencies: [] }, true));
    const proof = createNamingMicrobatch({ key, snapshot: fixture.input.snapshot, candidates, curation, verification, sourceContext: { dependencyArtifactIds: verifierRequest.dependencyArtifactIds, artifacts: [] } });
    const published = await brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, proof, new AbortController().signal)); expect(published.entryIds).toHaveLength(1);
    const loaded = await feed(); expect(loaded.entries[0]!.publishedClaims[0]!.evidence[0]!.quote).toBe(excerpt);
   }
  }
 });

 it("keeps old admitted inputs, exact seven-stage plans and historical rows unchanged across the additive migration", async () => {
  const oldDb = await createTestDatabase({ before: migration });
  try {
   await installBrainFixture(oldDb); const project = await seedBrainFixture(oldDb), old = await startBrainFixture(oldDb, project);
   const before = (await oldDb.query("select to_jsonb(j) job,(select jsonb_agg(to_jsonb(r)) from fluid_private.naming_brain_runs r where r.job_id=j.id) runs from public.jobs j where id=$1", [old.id])).rows;
   await oldDb.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
   expect((await oldDb.query("select to_jsonb(j) job,(select jsonb_agg(to_jsonb(r)) from fluid_private.naming_brain_runs r where r.job_id=j.id) runs from public.jobs j where id=$1", [old.id])).rows).toEqual(before);
   const oldRun = parse(namingBrainRunSchema, await brainRpc(oldDb, "get_naming_brain_run", [project, old.input.runId]));
   expect(oldRun).not.toHaveProperty("localPipelineVersion"); expect(oldRun.stages.map(stage => stage.stageKey)).toEqual(namingStageKeySchema.options);
   expect(await brainAction(oldDb, old, "plan", { manifest: brainManifest, gapEnvelope: (await import("./naming-brain-fixture")).brainGapEnvelope })).toMatchObject({ plan_manifest: brainManifest });
  } finally { await oldDb.close(); }
 });
});
