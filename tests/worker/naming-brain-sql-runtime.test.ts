import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainRunSchema, namingPreparedSetSchema, namingRoleOutputSchema, namingVerificationSchema } from "../../src/domain/naming-brain";
import { nameIdentityKey } from "../../src/domain/project-naming";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { namingRequestHash } from "../../src/server/ai/naming-brain/prompts";
import { normalizeNamingBrain } from "../../src/server/data/naming-brain-provenance";
import { runOneJob } from "../../worker/runner";
import { parseClaimedJob } from "../../worker/postgres-store";
import { createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "../database/local-supabase";
import { brainPolicy, brainPreferences, brainRpc, brainWorker, initialIntent, installBrainFixture, seedBrainFixture } from "../database/naming-brain-fixture";
import { createSqlNamingHarness, fixtureWorkerId, syntheticReferenceText } from "./naming-brain-sql-runtime-fixture";

describe("Naming actual SDK/store/SQL boundary (inert transports, local migrated PGlite)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 30_000);
  afterAll(async () => { await db?.close(); });

  async function admit(options: Parameters<typeof createSqlNamingHarness>[1]) {
    const project = await seedBrainFixture(db);
    await brainRpc(db, "save_naming_preferences", [project, 1, { ...brainPreferences, approaches: ["real_words", "invented"] }]);
    const test = createSqlNamingHarness(db, options);
    await brainWorker(db, () => test.store.attestPendingPreferences());
    await brainRpc(db, "ensure_naming_brain_run", [project, { ...initialIntent(), expectedPreferencesVersion: 2 }]);
    return { project, test };
  }

  async function readPrepared(project: string) {
    const saved = (await db.query<{ prepared: unknown }>("select prepared from fluid_private.naming_brain_prepared_sets where project_id=$1", [project])).rows;
    expect(saved).toHaveLength(1);
    const prepared = namingPreparedSetSchema.parse(saved[0]!.prepared);
    const candidates = (await db.query<{ id: string }>("select id from public.name_candidates where project_id=$1", [project])).rows.map(row => row.id);
    expect(candidates.sort()).toEqual([...prepared.candidateIds].sort());
    return prepared;
  }

  async function assertHeldLiability(project: string) {
    const runs = (await db.query<{ job_id: string; actual_cost_microusd: number | null }>("select job_id,actual_cost_microusd from fluid_private.naming_brain_runs where project_id=$1", [project])).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.actual_cost_microusd).toBeNull();
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [runs[0]!.job_id])).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
    const held = (await db.query<{ reserved: number; state: string }>("select account.reserved_microusd::integer reserved,reservation.state from public.usage_accounts account join public.usage_reservations reservation on reservation.owner_id=account.owner_id where reservation.job_id=$1", [runs[0]!.job_id])).rows;
    expect(held).toEqual([{ reserved: 5_000_000, state: "active" }]);
    const receipts = (await db.query<{ confirmed: unknown; status: string }>("select receipt->'confirmedActualCostMicrousd' confirmed,receipt->>'accountingStatus' status from fluid_private.naming_brain_receipts where project_id=$1", [project])).rows;
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every(row => row.confirmed === null && row.status === "provisional")).toBe(true);
  }

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

  it("recovers committed prepare with a lost acknowledgement before reassembly against its own complete identity history", async () => {
    const { project, test } = await admit({ losePrepareAcknowledgement: true });
    expect(await brainWorker(db, () => runOneJob({ store: test.store, handlers: test.handlers, workerId: fixtureWorkerId }))).toBe("lease_lost");
    expect(test.sqlErrors).toContainEqual({ name: "naming_brain_worker_action", action: "prepare", message: "synthetic_prepare_ack_lost" });
    const original = parseClaimedJob(test.claims[0]!.job);
    const prepared = await readPrepared(project);
    const acknowledgement = test.discardedAcknowledgement();
    expect(acknowledgement).toEqual({ preparedSetId: expect.any(String), preparedSet: prepared });
    expect(prepared.candidateIds).toHaveLength(100);
    const historyQuery = "select candidate_id,value,identity_key from fluid_private.naming_brain_identity_index where project_id=$1 order by candidate_id";
    const history = (await db.query<{ candidate_id: string; value: string; identity_key: string }>(historyQuery, [project])).rows;
    expect(history).toHaveLength(100);
    expect(history.map(row => row.candidate_id)).toEqual([...prepared.candidateIds].sort());
    expect(history.every(row => row.identity_key === nameIdentityKey(row.value))).toBe(true);
    const restarted = test.restart();
    expect(await brainWorker(db, () => restarted.store.action(original, "identities", { keys: history.map(row => row.identity_key) }))).toEqual(expect.arrayContaining(history.map(row => row.identity_key)));
    const stagesQuery = "select step_key,request_key,created_at from public.job_steps where job_id=$1 order by step_key";
    const originalStages = (await db.query(stagesQuery, [original.id])).rows;
    expect(originalStages).toHaveLength(7);
    await db.query("update fluid_private.naming_brain_pilots set enabled=false,ready_until=null where owner_id=$1", [OWNER_A]);
    test.setPaidReady(false);
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [original.id]);
    expect(await brainWorker(db, () => restarted.store.expireLeases(fixtureWorkerId))).toBe(1);
    expect((await db.query<{ mode: string; state: string }>("select r.recovery_mode mode,j.state from fluid_private.naming_brain_runs r join public.jobs j on j.id=r.job_id where r.project_id=$1", [project])).rows).toEqual([{ mode: "observe_only", state: "queued" }]);
    const previousCalls = test.sqlCalls.length, previousNetwork = [...test.networkCalls], previousCounts = test.counts();
    expect(await brainWorker(db, () => runOneJob({ ...restarted, workerId: fixtureWorkerId }))).toBe("succeeded");
    expect(test.claims).toHaveLength(2);
    expect(test.claims[1]!.mode).toBe("observe_only");
    expect(test.claims[1]!.job.id).toBe(original.id);
    expect(test.claims[1]!.job.lease_token).not.toBe(original.leaseToken);
    const recovery = test.sqlCalls.slice(previousCalls);
    expect(recovery.filter(call => ["index_page", "index_record", "index_finalize", "identities", "prepare", "resume_execution"].includes(call.action ?? ""))).toEqual([]);
    expect(recovery.some(call => call.name === "authorize_naming_brain_dispatch")).toBe(false);
    expect(recovery.some(call => call.action === "stage" && call.payload!.stageKey === "prepare")).toBe(true);
    expect(recovery.some(call => call.name === "complete_naming_brain_stage")).toBe(true);
    expect(test.networkCalls).toEqual(previousNetwork);
    expect(test.counts()).toEqual(previousCounts);
    expect(test.sqlCalls.filter(call => call.action === "prepare")).toHaveLength(1);
    const saved = (await db.query<{ id: string; prepared: unknown }>("select id,prepared from fluid_private.naming_brain_prepared_sets where project_id=$1", [project])).rows;
    expect(saved).toEqual([{ id: (acknowledgement as { preparedSetId: string }).preparedSetId, prepared }]);
    expect((await db.query(historyQuery, [project])).rows).toEqual(history);
    expect((await db.query(stagesQuery, [original.id])).rows).toEqual(originalStages);
    expect((await db.query<{ n: number }>("select count(*)::integer n from public.job_steps where job_id=$1 and state='succeeded'", [original.id])).rows).toEqual([{ n: 7 }]);
    const publicRun = namingBrainRunSchema.parse(normalizeNamingBrain(await brainRpc(db, "get_naming_brain_run", [project, prepared.runId]), OWNER_A));
    expect(publicRun).toMatchObject({ runId: prepared.runId, jobId: original.id, state: "succeeded", accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null } });
    await assertHeldLiability(project);
  }, 30_000);

  it("rejects foreign workers and forged source or Creator proof through SQL while retaining the genuine artifacts", async () => {
    const rejected: string[] = [];
    let creatorChecked = false;
    const { project, test } = await admit({ beforeArtifact: async (args, artifact) => {
      const sql = "select public.naming_brain_worker_action($1,$2,$3,$4::jsonb) result";
      async function reject(label: string, forged: unknown, message: string) {
        await expect(db.query(sql, [args[0], args[1], "artifact", JSON.stringify({ artifact: forged })])).rejects.toMatchObject({ code: "22023", message });
        rejected.push(label);
      }
      if (artifact.output.role === "researcher" && "sources" in artifact) {
        // This is an independently admitted restricted principal for owner B;
        // only the valid A job/lease/artifact are reused for the attack.
        await db.exec("set session authorization fixture_naming_brain_b");
        try { await expect(db.query(sql, args)).rejects.toMatchObject({ code: "42501", message: "worker_owner_mismatch" }); }
        finally { await db.exec("set session authorization fixture_naming_brain_a"); }
        rejected.push("foreign_worker");
        const excerpt = `${syntheticReferenceText} Forged text.`;
        await reject("retained_text", { ...artifact, sources: artifact.sources.map(source => ({ ...source, excerpt, contentHash: namingTextHash(excerpt) })) }, "retained_source_evidence_required");
      }
      if ("creatorAttribution" in artifact && artifact.output.role === "creator" && !creatorChecked) {
        creatorChecked = true;
        await reject("assignment_hash", { ...artifact, creatorAttribution: { ...artifact.creatorAttribution, assignmentInputHash: "f".repeat(64) } }, "creator_item_proof_required");
        const stage = (await db.query<{ result: { artifacts: unknown[] } }>(sql, [args[0], args[1], "stage", JSON.stringify({ stageKey: "research" })])).rows[0]!.result;
        const research = namingRoleOutputSchema.parse(stage.artifacts[0]);
        await reject("foreign_creator_session", { ...artifact, creatorAttribution: { ...artifact.creatorAttribution, sessionId: research.providerReceipt.sessionId, turnId: research.providerReceipt.turnId } }, "creator_item_proof_required");
        await reject("creator_content_hash", { ...artifact, creatorAttribution: { ...artifact.creatorAttribution, itemContentHash: "f".repeat(64) } }, "creator_item_proof_required");
        await reject("creator_output", { ...artifact, output: { ...artifact.output, candidates: artifact.output.candidates.map((candidate, index) => index ? candidate : { ...candidate, value: "ForgedName" }) } }, "creator_item_proof_required");
      }
      if (artifact.output.role === "verifier" && "sourceDependencies" in artifact && "sources" in artifact) {
        expect(artifact.sourceDependencies).toHaveLength(1);
        await reject("foreign_source_dependency", { ...artifact, sourceDependencies: artifact.sourceDependencies.map(dependency => ({ ...dependency, artifactId: crypto.randomUUID() })) }, "inherited_source_binding_mismatch");
        const excerpt = `${syntheticReferenceText} Forged inherited text.`;
        await reject("inherited_source_text", { ...artifact, sources: artifact.sources.map(source => ({ ...source, excerpt, contentHash: namingTextHash(excerpt) })) }, "inherited_source_binding_mismatch");
      }
    } });
    await db.query("insert into fluid_private.naming_brain_pilots(owner_id,role_name,role_oid,deployment_id,policy,enabled,readiness_fingerprint) select $2,role.rolname,role.oid,pilot.deployment_id,pilot.policy,true,pilot.readiness_fingerprint from fluid_private.naming_brain_pilots pilot cross join pg_roles role where pilot.owner_id=$1 and role.rolname='fixture_naming_brain_b'", [OWNER_A, OWNER_B]);
    expect(await brainWorker(db, () => test.store.reportReady(brainPolicy, fixtureWorkerId), OWNER_B)).toBe(true);
    expect(await brainWorker(db, () => test.store.claim(fixtureWorkerId, 120), OWNER_B)).toBeNull();
    const result = await brainWorker(db, () => runOneJob({ store: test.store, handlers: test.handlers, workerId: fixtureWorkerId }));
    expect({ result, sqlErrors: test.sqlErrors }).toEqual({ result: "succeeded", sqlErrors: [] });
    expect(rejected).toEqual(["foreign_worker", "retained_text", "assignment_hash", "foreign_creator_session", "creator_content_hash", "creator_output", "foreign_source_dependency", "inherited_source_text"]);
    expect(test.counts()).toMatchObject({ creates: 6, toolReplies: 1, cancellations: 0 });
    const prepared = await readPrepared(project);
    expect(prepared.fulfillment).toMatchObject({ status: "complete", acceptedCount: 100, missingCount: 0 });
    const artifacts = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where project_id=$1", [project])).rows.map(row => namingRoleOutputSchema.parse(row.artifact));
    expect(artifacts).toHaveLength(6);
    const source = await brainRpc(db, "get_naming_brain_candidate_source", [project, prepared.candidateIds[0]!]);
    expect(source).toMatchObject({ ownerId: OWNER_A, projectId: project, candidateId: prepared.candidateIds[0], runId: prepared.runId, providerReceipt: { confirmedActualCostMicrousd: null } });
    await expect(brainRpc(db, "get_naming_brain_candidate_source", [project, prepared.candidateIds[0]!], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(brainRpc(db, "get_naming_brain_run", [project, prepared.runId], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(brainRpc(db, "get_naming_brain_job_accounting", [test.claims[0]!.job.id], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    expect((await db.query<{ n: number }>("select count(*)::integer n from fluid_private.naming_brain_artifacts where project_id=$1", [project])).rows).toEqual([{ n: 6 }]);
    await assertHeldLiability(project);
  }, 30_000);

  it("runs one ordered SQL gap through 10/40/5/20-cent phases to prepare 100 reviewed names", async () => {
    const { project, test } = await admit({ initialCount: 60 });
    const result = await brainWorker(db, () => runOneJob({ store: test.store, handlers: test.handlers, workerId: fixtureWorkerId }));
    expect({ result, sqlErrors: test.sqlErrors }).toEqual({ result: "succeeded", sqlErrors: [] });
    expect(test.counts()).toMatchObject({ creates: 10, toolReplies: 1, cancellations: 0 });
    const gap = [...test.requests.values()].filter(request => request.stageKey === "gap");
    expect(gap.map(request => request.role)).toEqual(["director", "creator", "curator", "verifier"]);
    expect(gap.map(request => request.policy.sessionLimitCents)).toEqual([10, 40, 5, 20]);
    expect(gap.map(request => request.policy.maxWebSearchCalls)).toEqual([0, 0, 0, 8]);
    expect(gap[0]!.input).toMatchObject({ role: "director", gapContext: { missingCount: 40, currentPool: expect.any(Array) } });
    if (gap[0]!.input.role !== "director") throw new Error("Missing gap Director request");
    expect(gap[0]!.input.gapContext!.currentPool).toHaveLength(60);
    const plans = (await db.query<{ phase_key: string; calls: unknown[] }>("select phase_key,calls from fluid_private.naming_brain_call_plans where project_id=$1 and stage_key='gap'", [project])).rows;
    expect(plans).toHaveLength(4);
    expect(test.sqlCalls.filter(call => call.action === "call_plan" && call.payload!.stageKey === "gap").map(call => call.payload!.phase)).toEqual(["direction", "creation", "curation", "verification"]);
    for (const request of test.requests.values()) {
      expect(request.requestHash).toBe(namingRequestHash(request));
      const saved = (await db.query<{ request: unknown }>("select request from fluid_private.naming_brain_calls where project_id=$1 and call_key=$2", [project, request.providerCallKey])).rows;
      expect(saved).toEqual([{ request }]);
    }
    const artifacts = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where project_id=$1", [project])).rows.map(row => namingRoleOutputSchema.parse(row.artifact));
    expect(artifacts).toHaveLength(10);
    const creator = artifacts.find(artifact => artifact.stageKey === "gap" && "creatorAttribution" in artifact);
    if (!creator || !("creatorAttribution" in creator) || creator.output.role !== "creator") throw new Error("Missing retained gap Creator proof");
    expect(creator.output.candidates).toHaveLength(50);
    expect(creator.creatorAttribution.assignmentInputHash).toBe(creator.providerReceipt.requestHash);
    const final = test.sessions.get(creator.creatorAttribution.sessionId!)!.items.find(item => item.id === creator.creatorAttribution.itemId)!;
    const text = (final.content as { text: string }[])[0]!.text;
    expect(creator.creatorAttribution.itemContentHash).toBe(namingTextHash(text));
    expect(JSON.parse(text)).toEqual(creator.output);
    const verification = namingVerificationSchema.parse(artifacts.find(artifact => artifact.stageKey === "gap" && artifact.output.role === "verifier"));
    expect(verification.output.findings).toHaveLength(3);
    expect(verification.sources).toHaveLength(1);
    expect(verification.sources[0]!.contentHash).toBe(namingTextHash(syntheticReferenceText));
    expect(verification.sourceDependencies).toHaveLength(1);
    for (const finding of verification.output.findings) {
      expect(finding.evidence).toHaveLength(1);
      const evidence = finding.evidence[0]!;
      expect(verification.sources.find(source => source.sourceKey === evidence.sourceKey)!.excerpt!.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    }
    const prepared = await readPrepared(project);
    expect(prepared.fulfillment).toMatchObject({ status: "complete", acceptedCount: 100, missingCount: 0 });
    expect(prepared.candidateIds).toHaveLength(100);
    expect(prepared.retainedUnusedIds).toHaveLength(10);
    expect(prepared.sourceArtifactIds).toContain(creator.artifactId);
    expect(prepared.verificationArtifactId).toBe(verification.artifactId);
    const publicRun = namingBrainRunSchema.parse(normalizeNamingBrain(await brainRpc(db, "get_naming_brain_run", [project, prepared.runId]), OWNER_A));
    expect(publicRun.state).toBe("succeeded");
    expect(publicRun.fulfillment).toEqual(prepared.fulfillment);
    expect([...test.sessions.values()].every(session => session.finalSessionReads > 0)).toBe(true);
    await assertHeldLiability(project);
  }, 30_000);

  it.each([
    ["failed", "director", 7],
    ["invalid_json", "director", 7],
    ["invalid_json", "verifier", 10],
  ] as const)("prepares the prior reviewed 60-name pool after a genuine %s gap %s", async (gapTerminal, gapTerminalRole, expectedCreates) => {
    const { project, test } = await admit({ initialCount: 60, gapTerminal, gapTerminalRole });
    const result = await brainWorker(db, () => runOneJob({ store: test.store, handlers: test.handlers, workerId: fixtureWorkerId }));
    expect({ result, sqlErrors: test.sqlErrors }).toEqual({ result: "succeeded", sqlErrors: [] });
    expect(test.counts()).toMatchObject({ creates: expectedCreates, toolReplies: 1, cancellations: 0 });
    const failed = [...test.requests.values()].find(request => request.stageKey === "gap" && request.role === gapTerminalRole)!;
    expect(failed.requestHash).toBe(namingRequestHash(failed));
    const session = [...test.sessions.values()].find(row => row.request.providerCallKey === failed.providerCallKey)!;
    expect(session.terminal).toBe(true);
    expect(session.failed).toBe(gapTerminal === "failed");
    expect(session.finalSessionReads).toBeGreaterThan(0);
    const turns = (await db.query<{ payload: { providerCallKey: string; turn: { status: string } } }>("select payload from fluid_private.naming_brain_provider_records where project_id=$1 and stage_key='gap' and call_key=$2 and kind='provider_turn'", [project, failed.providerCallKey])).rows;
    expect(turns.some(row => row.payload.providerCallKey === failed.providerCallKey && row.payload.turn.status === (gapTerminal === "failed" ? "failed" : "completed"))).toBe(true);
    const stageResults = (await db.query<{ output: { errorCode: string; partialArtifacts?: { code: string; receipt: { providerCallKey: string; confirmedActualCostMicrousd: null } }[] } }>("select output from fluid_private.naming_brain_stage_results where project_id=$1 and stage_key='gap'", [project])).rows;
    expect(stageResults).toHaveLength(1);
    expect(stageResults[0]!.output.errorCode).toBe("gap_incomplete");
    if (gapTerminal === "invalid_json") expect(stageResults[0]!.output.partialArtifacts).toContainEqual(expect.objectContaining({ code: "provider_output_invalid", receipt: expect.objectContaining({ providerCallKey: failed.providerCallKey, confirmedActualCostMicrousd: null }) }));
    const artifacts = (await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where project_id=$1", [project])).rows.map(row => namingRoleOutputSchema.parse(row.artifact));
    expect(artifacts.some(artifact => artifact.providerReceipt.providerCallKey === failed.providerCallKey)).toBe(false);
    expect(artifacts.filter(artifact => artifact.stageKey === "gap")).toHaveLength(gapTerminalRole === "verifier" ? 3 : 0);
    const initialCreators = artifacts.filter(artifact => artifact.stageKey === "creation");
    const initialVerification = artifacts.find(artifact => artifact.stageKey === "verification")!;
    const prepared = await readPrepared(project);
    expect(prepared.fulfillment).toMatchObject({ status: "partial", acceptedCount: 60, missingCount: 40 });
    expect(prepared.candidateIds).toHaveLength(60);
    expect(prepared.retainedUnusedIds).toHaveLength(0);
    expect([...prepared.sourceArtifactIds].sort()).toEqual(initialCreators.map(artifact => artifact.artifactId).sort());
    expect(prepared.verificationArtifactId).toBe(initialVerification.artifactId);
    const publicRun = namingBrainRunSchema.parse(normalizeNamingBrain(await brainRpc(db, "get_naming_brain_run", [project, prepared.runId]), OWNER_A));
    expect(publicRun.state).toBe("partial");
    expect(publicRun.fulfillment).toEqual(prepared.fulfillment);
    expect(publicRun.stages.find(stage => stage.stageKey === "gap")).toMatchObject({ state: "succeeded", errorCode: "gap_incomplete" });
    const prepare = (await db.query<{ state: string }>("select state from public.job_steps where project_id=$1 and step_key='prepare'", [project])).rows;
    expect(prepare).toEqual([{ state: "succeeded" }]);
    expect(test.sqlCalls.filter(call => call.action === "prepare")).toHaveLength(1);
    await assertHeldLiability(project);
  }, 30_000);
});
