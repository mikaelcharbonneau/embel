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
import { context, creatorSet, id, plan, preferences, proposal, receipt, research, snapshot, verification } from "./naming-brain-fixtures";

describe("explicit choices and text fragment semantics", () => {
  it("leaves drafts unanswered and blocks generation until explicit choices and needed sources are saved", () => {
    const empty = initialNamingPreferencesV2(context);
    expect(getNamingPreferencesReadiness(empty)).toEqual({ ready: false, missing: ["approaches", "directness"] });
    expect(getNamingPreferencesReadiness(preferences())).toEqual({ ready: true, missing: [] });
    expect(getNamingPreferencesReadiness({ ...preferences(), sourceLanguages: [] }).missing).toEqual(["sourceLanguages"]);
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
    expect(brain.namingEvidenceSourceSchema?.safeParse({ ...research().sources[0], evidenceStatus: "unretrieved", excerpt: null, contentHash: null }).success).toBe(true);
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
    const result = brain.applyNamingVerification?.(candidates!, verification([{ assignmentKey: "invented", candidateKey: "odd", claimKey: "origin", status: "contradicted", supportedWording: null, sourceKeys: ["source-one"], supportsPrimaryApproach: false, explanation: "The source does not support this optional origin." }]));
    expect(result?.candidates[0]).toMatchObject({ candidateId: id(1100), value: "Qvorr", eligible: true, primaryCredit: "invented", publishedClaims: [] });
    expect(candidates?.[0]?.claims[0]?.statement).toBe("An invented false Latin origin");
  });
  it("invalidates unsupported required language credit and prevents correction from manufacturing evidence", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    const original = { ...proposal("Brume", "word", "other_languages"), claims: [{ claimKey: "meaning", statement: "Purported French meaning", sourceKeys: ["source-one"], requirement: "primary_approach", status: "unverified" }] };
    const candidates = brain.validateNamingCreatorSet?.(snapshot(), assignments?.[2], creatorSet([original], "language")).accepted;
    const finding = { assignmentKey: "language", candidateKey: "word", claimKey: "meaning", status: "unresolved", supportedWording: null, sourceKeys: [], supportsPrimaryApproach: false, explanation: "No retrieved text supports the claim." };
    const applied = brain.applyNamingVerification?.(candidates!, verification([finding]));
    expect(applied?.candidates[0]).toMatchObject({ eligible: false, primaryCredit: null, publishedClaims: [] });
    expect(() => brain.applyNamingVerification(candidates!, verification([{ ...finding, status: "supported", supportedWording: "Asserted meaning", sourceKeys: ["missing"], supportsPrimaryApproach: true }]))).toThrow();
    const noText = { ...verification([{ ...finding, status: "supported", supportedWording: "Asserted meaning", sourceKeys: ["source-one"], supportsPrimaryApproach: true }]), sources: [{ ...research().sources[0], evidenceStatus: "unretrieved", excerpt: null, contentHash: null }] };
    expect(() => brain.applyNamingVerification(candidates!, noText)).toThrow();
  });
  it("rejects findings for unknown candidate/claim references and mismatched snapshots", () => {
    const assignments = brain.validateNamingAssignmentPlan?.(snapshot(), research(), plan());
    const candidates = brain.validateNamingCreatorSet?.(snapshot(), assignments?.[0], creatorSet()).accepted;
    expect(() => brain.applyNamingVerification(candidates!, verification([{ assignmentKey: "real", candidateKey: "one", claimKey: "missing", status: "unresolved", supportedWording: null, sourceKeys: [], supportsPrimaryApproach: false, explanation: "Unknown claim" }]))).toThrow();
    expect(() => brain.applyNamingVerification(candidates!, { ...verification(), snapshotHash: "c".repeat(64) })).toThrow();
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
