import { describe, expect, it } from "vitest";
import * as naming from "../../src/domain/project-naming";
import * as jobs from "../../src/domain/naming-jobs";
import { at, context, id, preferences, snapshot } from "./naming-brain-fixtures";

function batch() {
  return { version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(3), id: id(5), ownerId: id(1), projectId: id(2), contextRevision: 1, strategyBasis: naming.namingStrategyBasis(context), strategyKey: naming.namingStrategyKey(context), preferencesVersion: 1, preferences: preferences(), favoritesSnapshot: [], acceptedPolicyIdentity: "a".repeat(64), targetCount: 100, sequence: 2, jobId: id(4), createdAt: at };
}
function candidate() {
  return { id: id(6), ownerId: id(1), projectId: id(2), value: "Cedar", identityKey: "cedar", rationale: "Explicit local fixture.", contextRevision: 1, strategyBasis: naming.namingStrategyBasis(context), strategyKey: naming.namingStrategyKey(context), createdAt: at,
    origin: { kind: "generated", version: 2, handlerVersion: "naming-brain-v1", ownerId: id(1), projectId: id(2), candidateId: id(6), contextRevision: 1, value: "Cedar", batchId: id(5), jobId: id(4), stepKey: "prepare", runId: id(3), sourceArtifactId: id(7), sourceStageKey: "creation", provider: "openai", billingMode: "openai_api", protocol: "openai_agents", model: "fixture-model", responseId: null, requestId: null, sessionId: "fixture-session", turnId: "fixture-turn", agentId: "fixture-agent", providerItemId: "fixture-final-item", generatedAt: at } };
}
function prepared() {
  return { version: 1, runId: id(3), stageKey: "prepare", snapshotHash: snapshot().snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1", targetCount: 100, minimumPerApproach: 5, candidateIds: [], primaryCounts: [{ approach: "invented", count: 0 }], retainedUnusedIds: [], fulfillment: { status: "none", targetCount: 100, acceptedCount: 0, missingCount: 100, coverageSatisfied: false, message: "0 of 100 names are ready." }, deficits: [{ approach: "invented", required: 5, actual: 0, missing: 5 }], rejected: [], annotations: [], curationArtifactId: id(9), verificationArtifactId: id(10), sourceArtifactIds: [] };
}

describe("versioned Naming read compatibility", () => {
  it("reads new 100-name continuation batches with an explicit engine discriminator", () => {
    expect(naming.namingBatchSchema.safeParse(batch()).success).toBe(true);
    expect(naming.namingBatchSchema.safeParse({ ...batch(), targetCount: 250 }).success).toBe(false);
    const withoutEngine: Record<string, unknown> = { ...batch() };
    delete withoutEngine.version; delete withoutEngine.handlerVersion; delete withoutEngine.billingMode; delete withoutEngine.runId;
    expect(naming.namingBatchSchema.safeParse(withoutEngine).success).toBe(false);
  });
  it("reads V2 generated provenance without treating the managed session as a Responses ID", () => {
    expect(naming.projectNameCandidateSchema.safeParse(candidate()).success).toBe(true);
    expect(naming.projectNameCandidateSchema.safeParse({ ...candidate(), origin: { ...candidate().origin, responseId: "invented-response" } }).success).toBe(false);
    expect(naming.projectNameCandidateSchema.safeParse({ ...candidate(), origin: { ...candidate().origin, sourceStageKey: "research" } }).success).toBe(false);
    expect(naming.projectNameCandidateSchema.safeParse({ ...candidate(), origin: { ...candidate().origin, candidateId: id(90) } }).success).toBe(false);
  });
  it("replays the pinned workshop semantics from a V2 root and preserves derived authorship", () => {
    const parent = candidate(), root = parent.origin;
    const history = [{ transformId: id(20), projectId: id(2), parentCandidateId: id(6), secondaryCandidateId: null, input: { kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }, output: "CEDAR", createdAt: at }];
    const transformed = { ...parent, id: id(21), value: "CEDAR", rationale: "Applied Unicode uppercase mapping.", origin: { kind: "transform", authorship: "user_supplied", algorithmVersion: 1, transformId: id(20), parentCandidateId: id(6), secondaryCandidateId: null, root, history } };
    expect(naming.projectNameCandidateSchema.safeParse(transformed).success).toBe(true);
    expect(naming.projectNameCandidateSchema.safeParse({ ...transformed, rationale: "Fabricated generated explanation" }).success).toBe(false);
    const copied = { ...parent, id: id(31), projectId: id(32), origin: { kind: "account_copy", authorship: "generated", sourceProjectId: id(2), sourceCandidateId: id(6), sourceContextRevision: 1, root, history: [] } };
    expect(naming.projectNameCandidateSchema.safeParse(copied).success).toBe(true);
  });
  it("projects only final preparation into V2 job results and keeps legacy result readers strict", () => {
    const result = { version: 2, operation: "naming.generate", handlerVersion: "naming-brain-v1", provider: "openai", billingMode: "openai_api", runId: id(3), jobId: id(4), batchId: id(5), preparedSet: prepared(), completedAt: at };
    expect(jobs.namingBrainJobResultSchema?.safeParse(result).success).toBe(true);
    expect(jobs.namingJobResultSchema.safeParse(result).success).toBe(false);
    expect(jobs.namingBrainJobResultSchema?.safeParse({ ...result, runId: id(90) }).success).toBe(false);
    expect(jobs.namingBrainJobResultSchema?.safeParse({ ...result, stageOutputs: [] }).success).toBe(false);
  });
  it("keeps generic job policy_identity null and binds the accepted policy through the managed run projection", () => {
    const summary = { version: 2, handlerVersion: "naming-brain-v1", id: id(4), owner_id: id(1), project_id: id(2), operation: "naming.generate", input_revision: 1, state: "queued", progress: 0, error_code: null, cancel_requested_at: null, created_at: at, finished_at: null, billingMode: "openai_api", policyIdentity: null, acceptedPolicyIdentity: "a".repeat(64), batchId: id(5), runId: id(3), sequence: 2, targetCount: 100 };
    expect(jobs.namingBrainJobSummarySchema?.safeParse(summary).success).toBe(true);
    expect(jobs.namingBrainJobSummarySchema?.safeParse({ ...summary, policyIdentity: "a".repeat(64) }).success).toBe(false);
    expect(jobs.namingAnyJobSummarySchema?.safeParse(summary).success).toBe(true);
    expect(jobs.namingJobSummarySchema.safeParse(summary).success).toBe(false);
  });
});

it("binds mixed-version batch history to the matching result version and run", () => {
  const result = { version: 2, ownerId: id(1), projectId: id(2), batchId: id(5), jobId: id(4), runId: id(3), preparedSetId: id(50), stepKey: "prepare", candidateIds: [], fulfillment: prepared().fulfillment, completedAt: at };
  expect(jobs.namingBatchEntrySchema.safeParse({ batch: batch(), result }).success).toBe(true);
  expect(jobs.namingBatchEntrySchema.safeParse({ batch: batch(), result: { ...result, runId: id(90) } }).success).toBe(false);
});

import { namingFeedEntrySchema } from "../../src/domain/naming-brain";
it("cannot erase or replace a managed candidate's feed run attribution", () => {
  const entry = { entryId: id(60), position: 1, runId: id(3), steeringRevision: 0, entry: { candidate: candidate(), retention: { ownerId: id(1), projectId: id(2), candidateId: id(6), revision: 0, favorite: false, saved: false, updatedAt: null } }, primaryApproach: "invented", additionalApproaches: [], publishedClaims: [] };
  expect(namingFeedEntrySchema.safeParse(entry).success).toBe(true);
  expect(namingFeedEntrySchema.safeParse({ ...entry, runId: id(90) }).success).toBe(false);
  expect(namingFeedEntrySchema.safeParse({ ...entry, runId: null, primaryApproach: null }).success).toBe(false);
});
