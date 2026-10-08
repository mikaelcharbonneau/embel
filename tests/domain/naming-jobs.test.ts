import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import {
  chatGPTNamingJobInputSchema, chatGPTNamingPolicySchema, enqueueNamingBatchSchema, getNamingFulfillment,
  namingAvailabilitySchema, namingBatchDetailResponseSchema, namingBatchResultSchema, namingFulfillmentSchema, namingJobResultSchema,
  namingJobSchema, namingJobSummarySchema, namingScreeningSchema, projectNamingOverviewSchema,
} from "../../src/domain/naming-jobs";

const id = (n: number) => `20000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const ownerId = id(1), projectId = id(2), batchId = id(3), jobId = id(4), at = "2026-10-04T12:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Local naming contract fixture" });
const limits = { maxInputBytes: 131_072, maxOutputBytes: 262_144, deadlineMs: 240_000, maxObservedWebSearchCalls: 0, maxRequestsPerHour: 20, maxQueuedJobs: 3 };
const policy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId: "fixture-registration", model: "fixture-selected-model", limits };
const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };
const batch = () => ({ id: batchId, ownerId, projectId, contextRevision: 4, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), preferencesVersion: 1, preferences, favoritesSnapshot: [], acceptedPolicyIdentity: "a".repeat(64), targetCount: 100, sequence: 1, jobId, createdAt: at });
const rejections = () => ({ invalid_candidate: 0, empty_identity: 0, below_minimum: 0, above_maximum: 0, duplicate_response: 0, duplicate_history: 0, over_target: 0 });
const result = () => ({
  version: 1, operation: "naming.generate", provider: "openai", billingMode: "chatgpt_subscription", model: "fixture-selected-model",
  responseId: "fixture-response", requestId: null, generatedAt: at, usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
  batchId, sequence: 1, targetCount: 100, accepted: [{ value: "Cedar", identityKey: "cedar", rationale: "Explicit local fixture" }],
  fulfillment: getNamingFulfillment(100, 1, rejections()),
});
const job = () => ({ id: jobId, owner_id: ownerId, project_id: projectId, operation: "naming.generate", input_revision: 4, state: "succeeded", progress: 100, error_code: null, cancel_requested_at: null, created_at: at, finished_at: at, billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), batchId, sequence: 1, targetCount: 100, results: [{ stepKey: "names", output: result() }] });

describe("naming admission and selected subscription policy", () => {
  const request = { expectedProjectRevision: 4, expectedPreferencesVersion: 1, expectedBatchSequence: 0, idempotencyKey: "fixture-batch-intent-0001", billingMode: "chatgpt_subscription", acceptedPolicyIdentity: "a".repeat(64) };
  it("accepts exactly one revision-bound intent with no client target, ownership, model or result", () => {
    expect(enqueueNamingBatchSchema.parse(request)).toEqual(request);
    for (const extra of [{ targetCount: 1000 }, { ownerId }, { projectId }, { context }, { model: "forged" }, { policy }, { output: result() }, { favoritesSnapshot: [] }, { exclusionKeys: [] }, { exclusionSnapshot: [] }]) {
      expect(enqueueNamingBatchSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    for (const change of [{ expectedPreferencesVersion: 0 }, { expectedBatchSequence: -1 }, { billingMode: "openai_api" }, { idempotencyKey: "short" }, { acceptedPolicyIdentity: "forged" }]) {
      expect(enqueueNamingBatchSchema.safeParse({ ...request, ...change }).success).toBe(false);
    }
  });
  it("pins one naming handler and prohibits web tools or invented API budgets", () => {
    expect(chatGPTNamingPolicySchema.safeParse(policy).success).toBe(true);
    expect(chatGPTNamingPolicySchema.safeParse({ ...policy, handlerVersion: "strategy-chatgpt-v1" }).success).toBe(false);
    expect(chatGPTNamingPolicySchema.safeParse({ ...policy, limits: { ...limits, maxObservedWebSearchCalls: 1 } }).success).toBe(false);
    expect(chatGPTNamingPolicySchema.safeParse({ ...policy, maximumCostMicrousd: 0 }).success).toBe(false);
  });
  it("freezes server-derived input and fails on a mismatched context basis or oversized input", () => {
    const input = { version: 1, billingMode: "chatgpt_subscription", context, policy, batch: batch(), exclusionKeys: ["cedar"], exclusionSnapshot: [{ candidateId: id(10), value: "Cedar", identityKey: "cedar" }] };
    const parsed = chatGPTNamingJobInputSchema.parse(input);
    expect(Object.isFrozen(parsed.batch.preferences)).toBe(true);
    expect(Object.isFrozen(parsed.exclusionKeys)).toBe(true);
    expect(Object.isFrozen(parsed.exclusionSnapshot[0])).toBe(true);
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input, context: { ...context, positioning: "Changed context" } }).success).toBe(false);
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input, policy: { ...policy, limits: { ...limits, maxInputBytes: 1024 } } }).success).toBe(false);
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input, exclusionKeys: ["Cedar"] }).success).toBe(false);
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input, exclusionKeys: ["cedar", "cedar"] }).success).toBe(false);
    const databaseBatch: Record<string, unknown> = { ...batch() };
    delete databaseBatch.strategyKey;
    expect(chatGPTNamingJobInputSchema.parse({ ...input, batch: databaseBatch }).batch.strategyKey).toBe(namingStrategyKey(context));
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input, batch: { ...batch(), strategyKey: "naming-strategy-v1:forged" } }).success).toBe(false);
  });
});

describe("frozen exclusion identities verified against actual historical values", () => {
  const cedar = { candidateId: id(10), value: "Cedar", identityKey: "cedar" };
  const elm = { candidateId: id(11), value: "Elm", identityKey: "elm" };
  const input = () => ({ version: 1, billingMode: "chatgpt_subscription", context, policy, batch: batch(), exclusionKeys: ["cedar", "elm"], exclusionSnapshot: [cedar, elm] });
  it("rejects key-only input, including a canonical but unbound wrong historical key", () => {
    const withoutSnapshot: Record<string, unknown> = input();
    delete withoutSnapshot.exclusionSnapshot;
    expect(chatGPTNamingJobInputSchema.safeParse({ ...withoutSnapshot, exclusionKeys: ["elm"] }).success).toBe(false);
    expect(chatGPTNamingJobInputSchema.safeParse({ ...withoutSnapshot, exclusionKeys: [] }).success).toBe(false);
  });
  it("accepts exact value/key pairs independently of database key ordering", () => {
    const parsed = chatGPTNamingJobInputSchema.parse({ ...input(), exclusionKeys: ["elm", "cedar"] });
    expect(parsed.exclusionSnapshot).toEqual([cedar, elm]);
    expect(Object.isFrozen(parsed.exclusionSnapshot)).toBe(true);
    expect(Object.isFrozen(parsed.exclusionSnapshot[0])).toBe(true);
  });
  it("rejects an individually canonical key belonging to a different value", () => {
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input(), exclusionSnapshot: [{ ...cedar, identityKey: "elm" }], exclusionKeys: ["elm"] }).success).toBe(false);
  });
  it("requires exactly the complete nonempty normalized identity set", () => {
    for (const exclusionKeys of [["cedar"], ["cedar", "elm", "oak"], ["cedar", "elm", "elm"], ["Cedar", "elm"], []]) {
      expect(chatGPTNamingJobInputSchema.safeParse({ ...input(), exclusionKeys }).success).toBe(false);
    }
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input(), exclusionSnapshot: [cedar], exclusionKeys: ["elm"] }).success).toBe(false);
  });
  it("retains duplicate values and punctuation-only history without inventing exclusion identities", () => {
    const exclusionSnapshot = [cedar, { candidateId: id(12), value: "CE-DAR", identityKey: "cedar" }, { candidateId: id(13), value: "!!!", identityKey: "" }, { candidateId: id(14), value: "Élan", identityKey: "élan" }];
    const parsed = chatGPTNamingJobInputSchema.parse({ ...input(), exclusionSnapshot, exclusionKeys: ["élan", "cedar"] });
    expect(parsed.exclusionSnapshot).toHaveLength(4);
    expect(parsed.exclusionSnapshot[3]!.value).toBe("Élan");
    expect(chatGPTNamingJobInputSchema.safeParse({ ...input(), exclusionSnapshot, exclusionKeys: ["élan", "cedar", ""] }).success).toBe(false);
  });
  it("rejects duplicate candidate IDs, malformed values and forged snapshot fields", () => {
    for (const exclusionSnapshot of [[cedar, { ...elm, candidateId: cedar.candidateId }], [{ ...cedar, value: "\u202Ehidden" }], [{ ...cedar, ownerId }], [{ ...cedar, candidateId: "not-uuid" }]]) {
      expect(chatGPTNamingJobInputSchema.safeParse({ ...input(), exclusionSnapshot }).success).toBe(false);
    }
  });
});

describe("honest fulfillment distinct from transport job state", () => {
  it("only calls a batch complete at its target and describes a 73/100 result as partial", () => {
    expect(getNamingFulfillment(100, 73, rejections())).toMatchObject({ status: "partial", targetCount: 100, acceptedCount: 73, message: expect.stringMatching(/73.*100/) });
    expect(getNamingFulfillment(100, 100, rejections()).status).toBe("complete");
    expect(getNamingFulfillment(50, 50, rejections()).status).toBe("complete");
    expect(getNamingFulfillment(100, 0, rejections()).status).toBe("none");
    expect(() => getNamingFulfillment(50, 51, rejections())).toThrow();
    expect(namingFulfillmentSchema.safeParse({ ...getNamingFulfillment(100, 73, rejections()), status: "complete" }).success).toBe(false);
    expect(namingFulfillmentSchema.safeParse({ ...getNamingFulfillment(100, 73, rejections()), message: null }).success).toBe(false);
  });
  it("publishes valid short results without converting succeeded transport into ambiguous dispatch", () => {
    expect(namingJobResultSchema.safeParse(result()).success).toBe(true);
    expect(namingJobSchema.safeParse(job()).success).toBe(true);
    expect(namingJobSchema.parse(job()).results[0]!.output.fulfillment.status).toBe("partial");
    const pending = { ...job(), state: "partial", progress: 20, finished_at: null, results: [], partialText: '{"candidates":[{"value":' };
    expect(namingJobSchema.safeParse(pending).success).toBe(true);
    expect(namingJobSchema.safeParse({ ...pending, state: "succeeded" }).success).toBe(false);
  });
  it("rejects forged counts, duplicate identities, wrong batch references and malformed provider usage", () => {
    const raw = result();
    for (const invalid of [
      { ...raw, fulfillment: getNamingFulfillment(100, 2, rejections()) },
      { ...raw, accepted: [...raw.accepted, { ...raw.accepted[0], value: "CE-DAR" }], fulfillment: getNamingFulfillment(100, 2, rejections()) },
      { ...raw, usage: { inputTokens: 100, outputTokens: 200, totalTokens: 200 } },
      { ...raw, provider: "fixture" }, { ...raw, targetCount: 50 },
    ]) expect(namingJobResultSchema.safeParse(invalid).success).toBe(false);
    expect(namingJobSchema.safeParse({ ...job(), batchId: id(90) }).success).toBe(false);
    expect(namingJobSchema.safeParse({ ...job(), results: [...job().results, ...job().results] }).success).toBe(false);
    expect(namingBatchResultSchema.safeParse({ ownerId, projectId, batchId, jobId, stepKey: "names", candidateIds: [id(10)], fulfillment: raw.fulfillment, completedAt: at }).success).toBe(true);
    expect(namingBatchResultSchema.safeParse({ ownerId, projectId, batchId, jobId, stepKey: "names", candidateIds: [], fulfillment: raw.fulfillment, completedAt: at }).success).toBe(false);
  });
  it("binds batch-detail replies to the exact persisted job output and publication", () => {
    const published = { ownerId, projectId, batchId, jobId, stepKey: "names", candidateIds: [id(10)], fulfillment: result().fulfillment, completedAt: at };
    const detail = { batch: batch(), job: job(), result: published };
    expect(namingBatchDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(namingBatchDetailResponseSchema.safeParse({ ...detail, result: { ...published, ownerId: id(90) } }).success).toBe(false);
    expect(namingBatchDetailResponseSchema.safeParse({ ...detail, result: { ...published, stepKey: "other" } }).success).toBe(false);
    expect(namingBatchDetailResponseSchema.safeParse({ ...detail, result: null }).success).toBe(false);
  });
});

describe("naming availability, screening and overview envelopes", () => {
  const screening = { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } };
  it("requires an actual ready policy or an explicit unavailable reason", () => {
    expect(namingAvailabilitySchema.safeParse({ status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" }).success).toBe(true);
    expect(namingAvailabilitySchema.safeParse({ status: "available", operation: "naming.generate", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), limits }).success).toBe(true);
    expect(namingAvailabilitySchema.safeParse({ status: "available", operation: "naming.generate" }).success).toBe(false);
    expect(namingAvailabilitySchema.safeParse({ status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable", model: "fallback" }).success).toBe(false);
  });
  it("has no invented screening evidence, timestamp, price or successful status", () => {
    expect(namingScreeningSchema.safeParse(screening).success).toBe(true);
    for (const extra of [{ checkedAt: at }, { provider: "invented" }, { price: 0 }, { sourceUrl: "https://example.com" }, { status: "available" }]) {
      expect(namingScreeningSchema.safeParse({ ...screening, domains: { ...screening.domains, ...extra } }).success).toBe(false);
    }
  });
  it("supports an unsaved initial session and fences every nested read by project and owner", () => {
    const overview = {
      project: { id: projectId, owner_id: ownerId, title: "Local fixture", scope: "naming_only", current_revision: 4, created_at: at, context },
      readiness: { ready: true, missing: ["reformulation", "competitors", "audience", "personality", "positioning"] },
      session: null, preferences: null, currentSelection: null,
      batches: { ownerId, projectId, items: [], nextCursor: null }, candidates: { ownerId, projectId, items: [], nextCursor: null },
      availability: { status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" }, jobs: [], screening,
    };
    expect(projectNamingOverviewSchema.safeParse(overview).success).toBe(true);
    expect(projectNamingOverviewSchema.safeParse({ ...overview, candidates: { ...overview.candidates, ownerId: id(90) } }).success).toBe(false);
    expect(projectNamingOverviewSchema.safeParse({ ...overview, jobs: [job()] }).success).toBe(false);
    expect(projectNamingOverviewSchema.safeParse({ ...overview, readiness: { ready: true, missing: [] } }).success).toBe(false);
  });
});


describe("250-name results with frozen-target compatibility", () => {
  const accepted = (count: number) => Array.from({ length: count }, (_, n) => ({ value: `Synthetic ${n}`, identityKey: `synthetic${n}`, rationale: `Synthetic explanation ${n}.` }));
  const complete250 = () => ({ ...result(), targetCount: 250, accepted: accepted(250), fulfillment: getNamingFulfillment(250, 250, rejections()) });
  it("counts 250 unique candidates and immutable candidate IDs in a completed first batch", () => {
    const output = complete250();
    const currentJob = { ...job(), targetCount: 250, results: [{ stepKey: "names", output }] };
    const publication = { ownerId, projectId, batchId, jobId, stepKey: "names", candidateIds: Array.from({ length: 250 }, (_, n) => id(n + 100)), fulfillment: output.fulfillment, completedAt: at };
    expect(namingJobResultSchema.parse(output).accepted).toHaveLength(250);
    expect(namingBatchResultSchema.parse(publication).candidateIds).toHaveLength(250);
    expect(namingBatchDetailResponseSchema.safeParse({ batch: { ...batch(), targetCount: 250 }, job: currentJob, result: publication }).success).toBe(true);
    const { results: _results, ...summary } = currentJob; void _results;
    expect(namingJobSummarySchema.safeParse(summary).success).toBe(true);
    expect(getNamingFulfillment(250, 249, rejections())).toMatchObject({ status: "partial", acceptedCount: 249, message: expect.stringContaining("249 of 250") });
  });
  it("keeps legacy first100 and later50 readable without permitting frozen-target substitution", () => {
    expect(namingJobSchema.safeParse(job()).success).toBe(true);
    const later = { ...result(), sequence: 2, targetCount: 50, fulfillment: getNamingFulfillment(50, 1, rejections()) };
    expect(namingJobResultSchema.safeParse(later).success).toBe(true);
    expect(namingJobSchema.safeParse({ ...job(), results: [{ stepKey: "names", output: complete250() }] }).success).toBe(false);
    expect(namingJobResultSchema.safeParse({ ...complete250(), sequence: 2 }).success).toBe(false);
    expect(namingJobResultSchema.safeParse({ ...result(), accepted: [{ ...result().accepted[0], rationale: "\u200D" }] }).success).toBe(true);
  });
  it("rejects overflow and completion shortfalls against the exact frozen target", () => {
    const output = complete250();
    expect(namingJobResultSchema.safeParse({ ...output, accepted: accepted(251) }).success).toBe(false);
    expect(namingJobResultSchema.safeParse({ ...output, accepted: accepted(249) }).success).toBe(false);
    expect(namingFulfillmentSchema.safeParse({ ...output.fulfillment, acceptedCount: 251 }).success).toBe(false);
    expect(() => getNamingFulfillment(100, 101, rejections())).toThrow();
    expect(namingBatchResultSchema.safeParse({ ownerId, projectId, batchId, jobId, stepKey: "names", candidateIds: Array.from({ length: 251 }, (_, n) => id(n + 100)), fulfillment: output.fulfillment, completedAt: at }).success).toBe(false);
  });
});
