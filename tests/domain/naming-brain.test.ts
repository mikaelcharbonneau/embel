import { describe, expect, it } from "vitest";
import { namingPreferencesSchema, updateNamingPreferencesSchema } from "../../src/domain/project-naming";

const draft = () => ({
  version: 2 as const, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null,
  approaches: [], directness: null, sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [],
});

describe("versioned Naming preferences", () => {
  it("preserves a deliberately unanswered V2 draft through the existing save boundary", () => {
    const result = updateNamingPreferencesSchema.safeParse({ expectedPreferencesVersion: 0, preferences: draft() });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.preferences).toEqual(draft());
  });
  it("accepts all eleven explicit approach choices without inferring any from legacy notes", () => {
    const approaches = ["real_words", "compounds", "blends", "invented", "modified", "phrases", "initials", "other_languages", "classical_roots", "people_places", "stories_culture"];
    expect(namingPreferencesSchema.safeParse({ ...draft(), approaches, directness: "all" }).success).toBe(true);
    const legacy = { version: 1, creativeLocale: "fr", notes: "Invented words", minimumGraphemes: null, maximumGraphemes: null };
    expect(namingPreferencesSchema.parse(legacy)).toEqual(legacy);
  });
});

import * as brain from "../../src/domain/naming-brain";
import { NAMING_APPROACHES, getNamingPreferencesReadiness, initialNamingPreferencesV2, matchesNamingTextFragment, namingPreferencesV2Schema } from "../../src/domain/naming-brain-preferences";
import { context, creatorSet, id, plan, preferences, proposal, receipt, research, snapshot, sourceContext, verification } from "./naming-brain-fixtures";

describe("explicit choices and text fragment semantics", () => {
  it("leaves drafts unanswered and blocks generation until explicit choices are saved without inventing optional source preferences", () => {
    const empty = initialNamingPreferencesV2(context);
    expect(getNamingPreferencesReadiness(empty)).toEqual({ ready: false, missing: ["approaches", "directness"] });
    expect(getNamingPreferencesReadiness(preferences())).toEqual({ ready: true, missing: [] });
    expect(getNamingPreferencesReadiness({ ...preferences(), sourceLanguages: [] })).toEqual({ ready: true, missing: [] });
    expect(NAMING_APPROACHES.find(card => card.id === "real_words")).toMatchObject({ label: "Real words", examples: ["Apple", "BlackBerry", "Jaguar"] });
  });
  it("matches exact NFC case-insensitive fragments without stripping punctuation, accents or stemming", () => {
    expect(matchesNamingTextFragment("Cafe\u0301 Noir", "CAFÉ")).toBe(true);
    expect(matchesNamingTextFragment("Café Noir", "Cafe")).toBe(false);
    expect(matchesNamingTextFragment("Moon-Light", "moonlight")).toBe(false);
    expect(matchesNamingTextFragment("Growing", "grown")).toBe(false);
    expect(getNamingPreferencesReadiness({ ...preferences(), requiredText: ["Café"], excludedText: ["fé"] }).missing).toEqual(["conflicting_text"]);
    expect(namingPreferencesV2Schema.safeParse({ ...preferences(), approaches: ["invented", "invented"] }).success).toBe(false);
  });
});

describe("model payload and saved provider evidence boundaries", () => {
  it("accepts a local research payload but rejects invented ownership and provider authority", () => {
    expect(brain.namingResearchOutputSchema?.safeParse(research().output).success).toBe(true);
    for (const patch of [{ ownerId: id(1) }, { artifactId: id(6) }, { providerReceipt: receipt() }, { sources: research().sources }]) {
      expect(brain.namingResearchOutputSchema?.safeParse({ ...research().output, ...patch }).success).toBe(false);
    }
    expect(brain.namingCreatorOutputSchema?.safeParse({ ...creatorSet().output, candidates: [{ ...proposal(), candidateId: id(9) }] }).success).toBe(false);
  });
  it("requires referenced sources, retained retrieved text, and matching provider artifact bindings", () => {
    expect(brain.namingResearchPackSchema?.safeParse(research()).success).toBe(true);
    expect(brain.namingResearchPackSchema?.safeParse({ ...research(), sources: [] }).success).toBe(false);
    expect(brain.namingResearchPackSchema?.safeParse({ ...research(), sources: [{ ...research().sources[0], sourceKey: "wrong" }] }).success).toBe(false);
    expect(brain.namingResearchPackSchema?.safeParse({ ...research(), providerReceipt: { ...receipt(), runId: id(90) } }).success).toBe(false);
    expect(brain.namingResearchPackSchema?.safeParse({ ...research(), sources: [{ ...research().sources[0], providerItemId: "invented-item" }] }).success).toBe(false);
    expect(brain.namingEvidenceSourceSchema?.safeParse({ ...research().sources[0], evidenceStatus: "retrieved", excerpt: null, contentHash: null }).success).toBe(false);
    expect(brain.namingEvidenceSourceSchema?.safeParse({ ...research().sources[0], evidenceStatus: "unretrieved", excerpt: null, contentHash: null, retrieval: null }).success).toBe(true);
  });
  it("retains ambiguous provider creation with no invented IDs or inferred zero expense", () => {
    const unknown = { ...receipt(), dispatchState: "unknown", sessionId: null, turnId: null, agentId: null, callIds: [], artifactItemIds: [], observedModel: null };
    expect(brain.namingProviderReceiptSchema?.safeParse(unknown).success).toBe(true);
    expect(brain.namingStageOutcomeSchema?.safeParse({ status: "unresolved", code: "creation_acknowledgement_lost", receipt: unknown, partialArtifacts: [] }).success).toBe(true);
    expect(brain.namingStageOutcomeSchema?.safeParse({ status: "rejected_before_dispatch", code: "no_budget", receipt: unknown }).success).toBe(false);
  });
});

describe("validated Director and Creator assignments", () => {
  it("binds selected approaches and keeps a flexible 150-candidate allocation", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    expect(assignments?.map(row => [row.primaryApproach, row.targetCount])).toEqual([["real_words", 90], ["invented", 40], ["other_languages", 20]]);
    expect(() => brain.validateNamingAssignmentPlan(snapshot(), research(), { ...plan(), output: { ...plan().output, assignments: plan().output.assignments.slice(0, 2) } })).toThrow();
    expect(() => brain.validateNamingAssignmentPlan(snapshot(), research(), { ...plan(), output: { ...plan().output, assignments: [{ ...plan().output.assignments[0], primaryApproach: "compounds" }, ...plan().output.assignments.slice(1)] } })).toThrow();
  });
  it("rejects missing territories, duplicate local keys, unsupported references and oversized totals", () => {
    for (const patch of [{ territoryId: "not-researched" }, { sourceKeys: ["not-retrieved"] }, { targetCount: 91 }, { assignmentKey: "invented" }]) {
      expect(() => brain.validateNamingAssignmentPlan(snapshot(), research(), { ...plan(), output: { ...plan().output, assignments: [{ ...plan().output.assignments[0], ...patch }, ...plan().output.assignments.slice(1)] } })).toThrow();
    }
  });
  it("preserves unusual invention and category-unrelated words while rejecting fabricated credits", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    const first = brain.validateNamingCreatorSet?.(snapshot(), assignments?.[0], creatorSet([proposal("Persimmon")]));
    expect(first?.accepted.map(row => row.value)).toEqual(["Persimmon"]);
    const unusual = brain.validateNamingCreatorSet?.(snapshot(), assignments?.[1], creatorSet([proposal("Qvorr", "odd", "invented", "rhythm")], "invented"));
    expect(unusual?.accepted.map(row => row.value)).toEqual(["Qvorr"]);
    expect(() => brain.validateNamingCreatorSet(snapshot(), assignments![0]!, creatorSet([proposal("Qvorr", "one", "invented")]))).toThrow();
  });
  it("checks exact source claims and application-resolved candidate IDs rather than trusting model metadata", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    const unknownClaim = { ...proposal(), claims: [{ claimKey: "origin", statement: "A purported origin", sourceKeys: ["wrong"], requirement: "optional", status: "unverified" }] };
    expect(() => brain.validateNamingCreatorSet(snapshot(), assignments![0]!, creatorSet([unknownClaim]))).toThrow();
    expect(() => brain.validateNamingCreatorSet(snapshot(), assignments![0]!, { ...creatorSet(), candidateIds: [] })).toThrow();
    expect(() => brain.validateNamingCreatorSet(snapshot(), assignments![0]!, { ...creatorSet(), candidateIds: [{ candidateKey: "wrong", candidateId: id(99) }] })).toThrow();
  });
  it("preserves accent identity and grapheme semantics, applies hard text constraints, and retains source values", () => {
    const current = { ...snapshot(), preferences: { ...preferences(), minimumGraphemes: 4, maximumGraphemes: 5, requiredText: ["ca"], excludedText: ["cart"] } };
    const assignments = brain.validateNamingAssignmentPlan?.(current, research(), plan());
    const result = brain.validateNamingCreatorSet?.(current, assignments?.[0], creatorSet([proposal("Café", "accent"), proposal("Cafe", "plain"), proposal("ca", "short"), proposal("Cart", "excluded"), proposal("Stone", "missing")]));
    expect(result?.accepted.map(row => [row.value, row.identityKey])).toEqual([["Café", "café"], ["Cafe", "cafe"]]);
    expect(result?.rejected.map(row => row.reason)).toEqual(["below_minimum", "excluded_text", "required_text"]);
  });
});

describe("claim-level verification", () => {
  it("removes unsupported optional wording without rejecting or silently rewriting an unusual name", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    const original = { ...proposal("Qvorr", "odd", "invented", "rhythm"), claims: [{ claimKey: "origin", statement: "An invented false Latin origin", sourceKeys: ["source-one"], requirement: "optional", status: "unverified" }] };
    const candidates = brain.validateNamingCreatorSet?.(snapshot(), assignments?.[1], creatorSet([original], "invented")).accepted;
    const result = brain.applyNamingVerification?.(candidates!, verification([{ assignmentKey: "invented", candidateKey: "odd", claimKey: "origin", status: "contradicted", supportedWording: null, sourceKeys: ["source-one"], supportsPrimaryApproach: false, explanation: "The source does not support this optional origin." }]), sourceContext());
    expect(result?.candidates[0]).toMatchObject({ candidateId: id(1100), value: "Qvorr", eligible: true, primaryCredit: "invented", publishedClaims: [] });
    expect(candidates?.[0]?.claims[0]?.statement).toBe("An invented false Latin origin");
  });
  it("invalidates unsupported required language credit and prevents correction from manufacturing evidence", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    const original = { ...proposal("Brume", "word", "other_languages"), claims: [{ claimKey: "meaning", statement: "Purported French meaning", sourceKeys: ["source-one"], requirement: "primary_approach", status: "unverified" }] };
    const candidates = brain.validateNamingCreatorSet?.(snapshot(), assignments?.[2], creatorSet([original], "language")).accepted;
    const finding = { assignmentKey: "language", candidateKey: "word", claimKey: "meaning", status: "unresolved", supportedWording: null, sourceKeys: [], supportsPrimaryApproach: false, explanation: "No retrieved text supports the claim." };
    const applied = brain.applyNamingVerification?.(candidates!, verification([finding]), sourceContext());
    expect(applied?.candidates[0]).toMatchObject({ eligible: false, primaryCredit: null, publishedClaims: [] });
    expect(() => brain.applyNamingVerification(candidates!, verification([{ ...finding, status: "supported", supportedWording: "Asserted meaning", sourceKeys: ["missing"], supportsPrimaryApproach: true }]), sourceContext())).toThrow();
    const noText = { ...verification([{ ...finding, status: "supported", supportedWording: "Asserted meaning", sourceKeys: ["source-one"], supportsPrimaryApproach: true }]), sources: [{ ...research().sources[0], evidenceStatus: "unretrieved", excerpt: null, contentHash: null, retrieval: null }] };
    expect(() => brain.applyNamingVerification(candidates!, noText, sourceContext())).toThrow();
  });
  it("rejects findings for unknown candidate/claim references and mismatched snapshots", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    const candidates = brain.validateNamingCreatorSet?.(snapshot(), assignments?.[0], creatorSet()).accepted;
    expect(() => brain.applyNamingVerification(candidates!, verification([{ assignmentKey: "real", candidateKey: "one", claimKey: "missing", status: "unresolved", supportedWording: null, sourceKeys: [], supportsPrimaryApproach: false, explanation: "Unknown claim" }]), sourceContext())).toThrow();
    expect(() => brain.applyNamingVerification(candidates!, { ...verification(), snapshotHash: "c".repeat(64) }, sourceContext())).toThrow();
  });
});


describe("retrieved quote support", () => {
  it("requires exact nonempty quote spans for supported or corrected findings", () => {
    const finding = { assignmentKey: "language", candidateKey: "word", claimKey: "meaning", status: "corrected", supportedWording: "A bounded corrected claim", sourceKeys: ["source-one"], supportsPrimaryApproach: true, explanation: "The exact source passage supports the correction.", evidence: [{ sourceKey: "source-one", start: 0, end: 24, quote: "Synthetic reference text" }] };
    expect(brain.namingVerificationSchema.safeParse(verification([finding])).success).toBe(true);
    for (const evidence of [[], [{ ...finding.evidence[0], start: 1 }], [{ ...finding.evidence[0], quote: "A fabricated quote" }], [{ ...finding.evidence[0], sourceKey: "unknown" }]]) {
      expect(brain.namingVerificationSchema.safeParse(verification([{ ...finding, evidence }])).success).toBe(false);
    }
  });
});


describe("protocol and accounting receipts", () => {
  it("retains output success while usage and confirmed expense remain independent", () => {
    const pack = research();
    expect(brain.namingStageOutcomeSchema.safeParse({ status: "completed", receipt: pack.providerReceipt, output: pack }).success).toBe(true);
    expect(brain.namingProviderReceiptSchema.safeParse({ ...receipt(), estimatedCostMicrousd: 12345, providerCostCounters: [{ scope: "session", scopeId: "fixture-session", kind: "consumed_usd_cents", value: 0, observedAt: "2026-10-16T12:00:00Z" }] }).success).toBe(true);
    expect(brain.namingProviderReceiptSchema.safeParse({ ...receipt(), accountingStatus: "confirmed", confirmedActualCostMicrousd: null }).success).toBe(false);
    expect(brain.namingProviderReceiptSchema.safeParse({ ...receipt(), accountingStatus: "provisional", confirmedActualCostMicrousd: 12345 }).success).toBe(false);
  });
  it("does not allow one protocol's identifiers to stand in for the other's", () => {
    const response = { ...receipt(), protocol: "openai_responses", sessionId: null, turnId: null, agentId: null, responseId: "fixture-response" };
    expect(brain.namingProviderReceiptSchema.safeParse(response).success).toBe(true);
    expect(brain.namingProviderReceiptSchema.safeParse({ ...response, sessionId: "fixture-session" }).success).toBe(false);
    expect(brain.namingProviderReceiptSchema.safeParse({ ...receipt(), responseId: "fixture-response" }).success).toBe(false);
  });
  it("binds a Creator set to an observed child final item instead of a coordinator claim", () => {
    expect(brain.namingCreatorSetSchema.safeParse(creatorSet()).success).toBe(true);
    expect(brain.namingCreatorSetSchema.safeParse({ ...creatorSet(), creatorAttribution: { ...creatorSet().creatorAttribution, itemId: "invented-item" } }).success).toBe(false);
    expect(brain.namingCreatorSetSchema.safeParse({ ...creatorSet(), creatorAttribution: { ...creatorSet().creatorAttribution, subagentId: null } }).success).toBe(false);
    expect(brain.namingCreatorSetSchema.safeParse({ ...creatorSet(), creatorAttribution: { ...creatorSet().creatorAttribution, assignmentKey: "different" } }).success).toBe(false);
  });
});

import { chatGPTNamingJobInputSchema } from "../../src/domain/naming-jobs";
import { namingStrategyBasis, namingStrategyKey, validateGeneratedNames } from "../../src/domain/project-naming";

describe("reviewed legacy and research admission boundaries", () => {
  it("does not let V2 hard constraints enter a legacy generator that does not enforce them", () => {
    const input = { version: 1, billingMode: "chatgpt_subscription", context,
      policy: { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId: "fixture", model: "fixture", limits: { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 0, maxRequestsPerHour: 20, maxQueuedJobs: 3 } },
      batch: { id: id(30), ownerId: id(1), projectId: id(2), contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), preferencesVersion: 1, preferences: preferences(), favoritesSnapshot: [], acceptedPolicyIdentity: "a".repeat(64), targetCount: 250, sequence: 1, jobId: id(31), createdAt: "2026-10-16T12:00:00Z" }, exclusionSnapshot: [], exclusionKeys: [] };
    expect(chatGPTNamingJobInputSchema.safeParse(input).success).toBe(false);
    expect(() => validateGeneratedNames([{ value: "Cedar", rationale: "Fixture" }], { ...preferences(), requiredText: ["Moon"] }, [])).toThrow();
  });
  it("preserves exact retained text rather than trimming away part of its hash and quote basis", () => {
    const source = { ...research().sources[0], excerpt: "  Source text with leading and trailing space.\n" };
    expect(brain.namingEvidenceSourceSchema.parse(source).excerpt).toBe(source.excerpt);
  });
  it("retains partial research but requires a genuinely sourced pack before Director admission", () => {
    const partial = { ...research(), readiness: "partial", sources: [], output: { ...research().output, facts: [], territories: research().output.territories.map(row => ({ ...row, sourceKeys: [] })) } };
    expect(brain.namingResearchPackSchema.safeParse(partial).success).toBe(true);
    expect(brain.namingResearchPackSchema.safeParse({ ...partial, readiness: "sourced" }).success).toBe(false);
    expect(() => brain.validateNamingAssignmentPlan(snapshot(), partial, plan())).toThrow();
  });
  it("blocks provably impossible required ASCII fragments before dispatch", () => {
    expect(getNamingPreferencesReadiness({ ...preferences(), maximumGraphemes: 3, requiredText: ["Cedar"] })).toEqual({ ready: false, missing: ["impossible_length"] });
    expect(getNamingPreferencesReadiness({ ...preferences(), maximumGraphemes: 5, requiredText: ["Cedar"] }).ready).toBe(true);
  });
});


it("records independent Creator sessions without inventing native child identifiers", () => {
  const value = creatorSet();
  const independent = { ...value, creatorAttribution: { ...value.creatorAttribution, executionKind: "independent_session", subagentId: null } };
  expect(brain.namingCreatorSetSchema.safeParse(independent).success).toBe(true);
});

it("rejects Creator evidence claiming a session allowance beyond its validated assignment", () => {
  const assignment = brain.validateNamingAssignmentPlan(snapshot(), research(), plan())[0]!;
  const value = creatorSet();
  expect(() => brain.validateNamingCreatorSet(snapshot(), assignment, { ...value, providerReceipt: { ...value.providerReceipt, sessionLimitCents: 91 } })).toThrow();
});
it("does not label cancellation terminal when the applicable execution identifiers are unknown", () => {
  const unknown = { ...receipt(), sessionId: null, turnId: null, agentId: null };
  expect(brain.namingStageOutcomeSchema.safeParse({ status: "cancelled", code: "provider_cancelled", receipt: unknown, partialArtifacts: [] }).success).toBe(false);
});
