import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { transformNames } from "../../src/domain/naming";
import {
  accountNamesPageSchema, createBrandFromProjectNameSchema, getNamingReadiness, importProjectNameSchema, initialNamingPreferences,
  nameIdentityKey, nameSelectionSchema, namingBatchSchema, namingBatchTarget, namingExclusionSnapshotSchema, namingPreferencesSchema,
  nameTransformSchema, namingSessionSchema, namingStrategyBasis, namingStrategyKey, namingViewStateSchema, projectNameCandidateSchema,
  projectNamePageSchema, selectProjectNameSchema, transformProjectNamesSchema, updateNameRetentionSchema,
  selectProjectNameResponseSchema, transformProjectNamesResponseSchema, updateNamingPreferencesResponseSchema,
  updateNamingPreferencesSchema, updateNamingViewStateSchema, validateProjectNameTransformParents,
} from "../../src/domain/project-naming";

const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-10-04T12:00:00Z";
const ownerId = id(1), projectId = id(2), candidateId = id(3), batchId = id(4), jobId = id(5);
const context = () => contextSnapshotSchema.parse({ description: "Local contract fixture: a community garden tool.", creativeLocale: "fr", intake: { namingNotes: "Simple and warm." } });
const preferences = () => ({ version: 1 as const, creativeLocale: "fr", notes: "Simple and warm.", minimumGraphemes: null, maximumGraphemes: null });
const completeContext = () => contextSnapshotSchema.parse({
  ...context(), activity: "Garden planning", offering: "Shared garden tools", reformulationConfirmed: true, competitorReviewComplete: true,
  audienceSegments: [{ id: id(6), label: "Neighbors", needs: ["Simple tools"], reason: "Shared gardens", selected: true, origin: "user", sources: [] }],
  personality: { sincerity: 70, excitement: 50, competence: 70, sophistication: 20, ruggedness: 20 }, positioning: "A garden together.",
  intake: { ...context().intake, audienceReviewedAt: at, personalityReviewedAt: at, positioningReviewedAt: at },
});
const batch = () => ({
  id: batchId, ownerId, projectId, contextRevision: 4, strategyBasis: namingStrategyBasis(context()), strategyKey: namingStrategyKey(context()),
  preferencesVersion: 1, preferences: preferences(), favoritesSnapshot: [{ candidateId: id(9), value: "Cedar" }],
  acceptedPolicyIdentity: "a".repeat(64), targetCount: 100, sequence: 1, jobId, createdAt: at,
});
const candidate = () => ({
  id: candidateId, ownerId, projectId, value: "Cedar", identityKey: "cedar", rationale: "Explicit local naming fixture.", contextRevision: 4,
  strategyBasis: namingStrategyBasis(context()), strategyKey: namingStrategyKey(context()), createdAt: at,
  origin: { kind: "generated", ownerId, projectId, candidateId, contextRevision: 4, value: "Cedar", batchId, jobId, stepKey: "names",
    provider: "openai", billingMode: "chatgpt_subscription", model: "fixture-model", responseId: "fixture-response", requestId: null, generatedAt: at },
});

describe("stored name exclusion snapshots", () => {
  it("bounds and freezes every stored candidate without dropping duplicate identities", () => {
    const rows = Array.from({ length: 10_000 }, (_, n) => ({ candidateId: id(n + 100), value: "Cedar", identityKey: "cedar" }));
    const parsed = namingExclusionSnapshotSchema.parse(rows);
    expect(parsed).toHaveLength(10_000);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(namingExclusionSnapshotSchema.safeParse([...rows, { ...rows[0]!, candidateId: id(20_000) }]).success).toBe(false);
    expect(namingExclusionSnapshotSchema.safeParse([rows[0], rows[0]]).success).toBe(false);
  });
  it("fails canonical wrong value/key pairs and preserves valid empty manual identities", () => {
    expect(namingExclusionSnapshotSchema.safeParse([{ candidateId, value: "Cedar", identityKey: "elm" }]).success).toBe(false);
    expect(namingExclusionSnapshotSchema.parse([{ candidateId, value: "!!!", identityKey: "" }])[0]!.identityKey).toBe("");
    expect(namingExclusionSnapshotSchema.safeParse([{ candidateId, value: "Cedar", identityKey: "" }]).success).toBe(false);
  });
});

describe("project naming preferences and readiness", () => {
  it("seeds only the existing locale and naming notes, leaving length unconstrained", () => {
    expect(initialNamingPreferences(context())).toEqual(preferences());
    expect(namingPreferencesSchema.safeParse({ ...preferences(), minimumGraphemes: 1, maximumGraphemes: 160 }).success).toBe(true);
  });
  it.each([{ minimumGraphemes: 0 }, { maximumGraphemes: 161 }, { minimumGraphemes: 6, maximumGraphemes: 5 }, { minimumGraphemes: 1.5 }, { creativeLocale: "x" }, { notes: "x".repeat(2001) }, { model: "forged" }])("rejects invalid preferences %j", patch => {
    expect(namingPreferencesSchema.safeParse({ ...preferences(), ...patch }).success).toBe(false);
  });
  it("requires current explicit full-brand reviews, including audience review", () => {
    const complete = completeContext();
    expect(getNamingReadiness(complete, "complete_brand")).toEqual({ ready: true, missing: [] });
    expect(getNamingReadiness({ ...complete, intake: { ...complete.intake, audienceReviewedAt: null } }, "complete_brand")).toEqual({ ready: false, missing: ["audience"] });
    expect(getNamingReadiness({ ...complete, intake: { ...complete.intake, personalityReviewedAt: null, positioningReviewedAt: null } }, "complete_brand").missing).toEqual(["personality", "positioning"]);
  });
  it("reports every missing Strategy step, starting with the description", () => {
    expect(getNamingReadiness(context(), "complete_brand")).toEqual({ ready: false, missing: ["reformulation", "competitors", "audience", "personality", "positioning"] });
    expect(getNamingReadiness(contextSnapshotSchema.parse({}), "complete_brand")).toEqual({ ready: false, missing: ["description", "reformulation", "competitors", "audience", "personality", "positioning"] });
  });
});

describe("material naming strategy basis", () => {
  it("changes for strategy content but ignores name selection, edit position and review timestamps", () => {
    const saved = completeContext();
    const key = namingStrategyKey(saved);
    expect(namingStrategyKey({ ...saved, positioning: "Different positioning." })).not.toBe(key);
    expect(namingStrategyKey({ ...saved, selectedName: "Oak", intake: { ...saved.intake, suppliedName: "Oak", step: "audience", audienceReviewedAt: "2026-10-04T13:00:00Z" } })).toBe(key);
    expect(namingStrategyKey({ ...saved, audienceSegments: [...saved.audienceSegments, { ...saved.audienceSegments[0]!, id: id(7), selected: false, reason: "Unselected alternative" }] })).toBe(key);
  });
  it("retains source titles and reasons but excludes retrieval dates and is stable across retained row order", () => {
    const saved = completeContext();
    const source = { url: "https://example.com/local-fixture", title: "Fixture reference", retrievedAt: at };
    saved.competitors = [{ id: id(8), name: "Fixture peer", relevance: "Comparable offering", origin: "research", selected: true, sources: [source] }];
    const key = namingStrategyKey(saved);
    expect(namingStrategyKey({ ...saved, competitors: [{ ...saved.competitors[0]!, sources: [{ ...source, retrievedAt: "2026-10-04T13:00:00Z" }] }] })).toBe(key);
    expect(namingStrategyKey({ ...saved, competitors: [{ ...saved.competitors[0]!, relevance: "Changed relevance" }] })).not.toBe(key);
    expect(namingStrategyKey({ ...saved, competitors: [{ ...saved.competitors[0]!, sources: [{ ...source, title: "Different source title" }] }] })).not.toBe(key);
    saved.audienceSegments.push({ ...saved.audienceSegments[0]!, id: id(9), label: "Another audience" });
    expect(namingStrategyKey({ ...saved, audienceSegments: [...saved.audienceSegments].reverse() })).toBe(namingStrategyKey(saved));
    expect(namingStrategyBasis(saved)).not.toHaveProperty("selectedName");
  });
});

describe("name identity keys", () => {
  it("deduplicates case, spaces and punctuation while preserving accented spellings and V1 workshop variants", () => {
    expect(["Cedar", "CEDAR", "Ce-dar", "Ce dar"].map(nameIdentityKey)).toEqual(["cedar", "cedar", "cedar", "cedar"]);
    expect(nameIdentityKey("Cédar")).not.toBe(nameIdentityKey("Cedar"));
    expect(nameIdentityKey("Cafe\u0301")).toBe(nameIdentityKey("CAFÉ"));
    expect(transformNames({ kind: "tweaks", seed: "Cedar", operations: ["uppercase", "lowercase"] }).candidates.map(item => item.value)).toEqual(["CEDAR", "cedar"]);
  });
});

describe("immutable project naming records", () => {
  it("fixes initial and continuation targets to distinct, positive batch sequences", () => {
    expect(namingBatchTarget(1)).toBe(250);
    expect(namingBatchTarget(2)).toBe(50);
    expect(() => namingBatchTarget(0)).toThrow();
    expect(namingBatchSchema.safeParse(batch()).success).toBe(true);
    expect(namingBatchSchema.safeParse({ ...batch(), targetCount: 250 }).success).toBe(true);
    expect(namingBatchSchema.safeParse({ ...batch(), targetCount: 50 }).success).toBe(false);
    expect(namingBatchSchema.safeParse({ ...batch(), sequence: 2, targetCount: 250 }).success).toBe(false);
    expect(namingBatchSchema.safeParse({ ...batch(), sequence: 2, targetCount: 50, id: id(10), jobId: id(11) }).success).toBe(true);
    expect(namingBatchSchema.safeParse({ ...batch(), sequence: 2 }).success).toBe(false);
    expect(namingBatchSchema.safeParse({ ...batch(), strategyKey: "forged" }).success).toBe(false);
  });
  it("copies and freezes the exact preference and favorite snapshots", () => {
    const raw = batch();
    const parsed = namingBatchSchema.parse(raw);
    raw.preferences.notes = "Later edit";
    raw.favoritesSnapshot[0]!.value = "Later favorite value";
    expect(parsed.preferences.notes).toBe("Simple and warm.");
    expect(parsed.favoritesSnapshot[0]!.value).toBe("Cedar");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.preferences)).toBe(true);
    expect(Object.isFrozen(parsed.favoritesSnapshot)).toBe(true);
    expect(Object.isFrozen(parsed.favoritesSnapshot[0])).toBe(true);
  });
  it("binds generated value, identity and references without treating a favorite as selection", () => {
    expect(projectNameCandidateSchema.safeParse(candidate()).success).toBe(true);
    expect(projectNameCandidateSchema.safeParse({ ...candidate(), identityKey: "elm" }).success).toBe(false);
    expect(projectNameCandidateSchema.safeParse({ ...candidate(), origin: { ...candidate().origin, candidateId: id(99) } }).success).toBe(false);
    const choice = { id: id(12), ownerId, projectId, candidateId, projectRevision: 5, previousSelectionId: null, acceptedEarlierContext: false, createdAt: at };
    expect(nameSelectionSchema.safeParse(choice).success).toBe(true);
    expect(nameSelectionSchema.safeParse({ ...choice, favorite: true }).success).toBe(false);
    expect(nameSelectionSchema.safeParse({ ...choice, previousSelectionId: choice.id }).success).toBe(false);
  });
  it("replays transform lineage but keeps derived authorship user-supplied", () => {
    const root = candidate().origin;
    const history = [{ transformId: id(20), projectId, parentCandidateId: candidateId, secondaryCandidateId: null, input: { kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }, output: "CEDAR", createdAt: at }];
    const transformed = { ...candidate(), id: id(21), value: "CEDAR", rationale: "Applied Unicode uppercase mapping.", origin: { kind: "transform", authorship: "user_supplied", algorithmVersion: 1, transformId: id(20), parentCandidateId: candidateId, secondaryCandidateId: null, root, history } };
    expect(projectNameCandidateSchema.safeParse(transformed).success).toBe(true);
    expect(projectNameCandidateSchema.safeParse({ ...transformed, value: "Elm", identityKey: "elm" }).success).toBe(false);
    expect(projectNameCandidateSchema.safeParse({ ...transformed, origin: { ...transformed.origin, authorship: "generated" } }).success).toBe(false);
    expect(projectNameCandidateSchema.safeParse({ ...transformed, rationale: "Claimed model research." }).success).toBe(false);
    expect(projectNameCandidateSchema.safeParse({ ...transformed, origin: { ...transformed.origin, history: Array(33).fill(history[0]) } }).success).toBe(false);
    const copied = { ...transformed, id: id(31), projectId: id(30), origin: { kind: "account_copy", authorship: "user_supplied", sourceProjectId: projectId, sourceCandidateId: transformed.id, sourceContextRevision: 4, root, history } };
    expect(projectNameCandidateSchema.safeParse(copied).success).toBe(true);
    expect(projectNameCandidateSchema.safeParse({ ...copied, origin: { ...copied.origin, authorship: "generated" } }).success).toBe(false);
    expect(projectNameCandidateSchema.safeParse({ ...copied, id: transformed.id }).success).toBe(false);
  });
  it("requires a self-contained explanation and valid generated ancestry even on copies", () => {
    const withoutExplanation: Record<string, unknown> = { ...candidate() };
    delete withoutExplanation.rationale;
    expect(projectNameCandidateSchema.safeParse(withoutExplanation).success).toBe(false);
    expect(projectNameCandidateSchema.safeParse({ ...candidate(), caution: "x".repeat(2001) }).success).toBe(false);
    const copy = { ...candidate(), id: id(32), projectId: id(33), value: "---", identityKey: "", origin: { kind: "account_copy", authorship: "generated", sourceProjectId: projectId, sourceCandidateId: candidateId, sourceContextRevision: 4, root: { ...candidate().origin, value: "---" }, history: [] } };
    expect(projectNameCandidateSchema.safeParse(copy).success).toBe(false);
  });
});

describe("strict public naming mutations and reads", () => {
  const view = { pane: "results", conversationOpen: false, filter: "all", query: "", visibleBatchId: null, scrollCandidateId: null, workshopCandidateId: null };
  const source = { id: id(50), value: "User name", createdAt: at, origin: "manual", history: [] };
  const requests = () => [
    [updateNamingPreferencesSchema, { expectedPreferencesVersion: 0, preferences: preferences() }],
    [updateNameRetentionSchema, { candidateId, expectedRevision: 0, favorite: true, saved: false }],
    [selectProjectNameSchema, { candidateId, expectedRevision: 4, acceptEarlierContext: false }],
    [updateNamingViewStateSchema, { expectedViewRevision: 1, viewState: view }],
    [transformProjectNamesSchema, { parentCandidateId: candidateId, input: { kind: "tweaks", seed: "Cedar", operations: ["uppercase"] }, idempotencyKey: "fixture-transform-0001" }],
    [importProjectNameSchema, { expectedProjectRevision: 4, source, capturedContext: context(), idempotencyKey: "fixture-import-000001" }],
    [createBrandFromProjectNameSchema, { sourceProjectId: projectId, sourceCandidateId: candidateId, expectedSourceProjectRevision: 4, title: "Local fixture brand", idempotencyKey: "fixture-promotion-0001" }],
  ] as const;
  it("rejects owner, model, generated provenance and output injection at every mutation boundary", () => {
    for (const [schema, request] of requests()) {
      expect(schema.safeParse(request).success).toBe(true);
      for (const extra of [{ ownerId }, { model: "forged" }, { origin: candidate().origin }, { output: candidate() }, { strategyBasis: namingStrategyBasis(context()) }]) {
        expect(schema.safeParse({ ...request, ...extra }).success).toBe(false);
      }
    }
    expect(importProjectNameSchema.safeParse({ ...requests()[5][1], source: { ...source, origin: "generated" } }).success).toBe(false);
  });
  it("defaults promotion to no earlier-context acknowledgement and accepts only an explicit boolean", () => {
    const request = requests()[6][1];
    expect(createBrandFromProjectNameSchema.parse(request).acceptEarlierContext).toBe(false);
    expect(createBrandFromProjectNameSchema.parse({ ...request, acceptEarlierContext: true }).acceptEarlierContext).toBe(true);
    for (const acceptEarlierContext of ["true", 1, null]) {
      expect(createBrandFromProjectNameSchema.safeParse({ ...request, acceptEarlierContext }).success).toBe(false);
    }
  });
  it("preserves the results navigation state and rejects unbounded or unknown view fields", () => {
    expect(namingViewStateSchema.safeParse({ ...view, pane: "screening", filter: "favorite", visibleBatchId: batchId, scrollCandidateId: candidateId }).success).toBe(true);
    expect(namingViewStateSchema.safeParse({ ...view, query: "x".repeat(201) }).success).toBe(false);
    expect(namingViewStateSchema.safeParse({ ...view, scrollY: 400 }).success).toBe(false);
  });
  it("requires owned matching parent values and a second parent only for Blend", () => {
    const primary = projectNameCandidateSchema.parse(candidate());
    const request = transformProjectNamesSchema.parse(requests()[4][1]);
    expect(() => validateProjectNameTransformParents(request, primary)).not.toThrow();
    expect(() => validateProjectNameTransformParents({ ...request, input: { kind: "tweaks", seed: "Elm", operations: ["uppercase"] } }, primary)).toThrow();
    expect(transformProjectNamesSchema.safeParse({ ...request, secondaryCandidateId: id(99) }).success).toBe(false);
    expect(transformProjectNamesSchema.safeParse({ ...request, input: { kind: "blend", left: "Cedar", right: "Elm", leftTake: 2, rightDrop: 0 } }).success).toBe(false);
  });
  it("caps stable candidate pages and rejects cross-owner or mismatched retention data", () => {
    const retention = { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null };
    const page = { ownerId, projectId, items: [{ candidate: candidate(), retention }], nextCursor: null };
    expect(projectNamePageSchema.safeParse(page).success).toBe(true);
    expect(projectNamePageSchema.safeParse({ ...page, ownerId: id(90) }).success).toBe(false);
    expect(projectNamePageSchema.safeParse({ ...page, items: [{ candidate: candidate(), retention: { ...retention, candidateId: id(91) } }] }).success).toBe(false);
    expect(projectNamePageSchema.safeParse({ ...page, items: Array(101).fill(page.items[0]) }).success).toBe(false);
  });
  it("allows an imported-name session before answers are explicitly saved", () => {
    const session = { ownerId, projectId, revision: 1, currentPreferencesVersion: 0, latestBatchSequence: 0, currentSelectionId: null, viewRevision: 1, viewState: view, createdAt: at, updatedAt: at };
    expect(namingSessionSchema.safeParse(session).success).toBe(true);
    const response = { session: { ...session, currentPreferencesVersion: 1 }, preferences: { ownerId, projectId, version: 1, preferences: preferences(), createdAt: at } };
    expect(updateNamingPreferencesResponseSchema.safeParse(response).success).toBe(true);
    expect(updateNamingPreferencesResponseSchema.safeParse({ ...response, session }).success).toBe(false);
  });
  it("binds selection replies to both project fields and the exact new revision", () => {
    const selection = { id: id(60), ownerId, projectId, candidateId, projectRevision: 5, previousSelectionId: null, acceptedEarlierContext: false, createdAt: at };
    const session = { ownerId, projectId, revision: 1, currentPreferencesVersion: 0, latestBatchSequence: 0, currentSelectionId: selection.id, viewRevision: 1, viewState: view, createdAt: at, updatedAt: at };
    const selectedContext = { ...context(), selectedName: "Cedar", intake: { ...context().intake, suppliedName: "Cedar" } };
    const project = { id: projectId, owner_id: ownerId, title: "Local fixture", scope: "complete_brand", current_revision: 5, created_at: at, context: selectedContext };
    const response = { project, session, currentSelection: { selection, candidate: candidate() } };
    expect(selectProjectNameResponseSchema.safeParse(response).success).toBe(true);
    expect(selectProjectNameResponseSchema.safeParse({ ...response, project: { ...project, current_revision: 6 } }).success).toBe(false);
    expect(selectProjectNameResponseSchema.safeParse({ ...response, project: { ...project, context: { ...selectedContext, intake: { ...selectedContext.intake, suppliedName: "Other" } } } }).success).toBe(false);
  });
  it("replays immutable transform records and rejects unrelated response entries", () => {
    const input = { kind: "tweaks" as const, seed: "Cedar", operations: ["uppercase" as const] };
    const transform = { id: id(70), ownerId, projectId, parentCandidateId: candidateId, secondaryCandidateId: null, algorithmVersion: 1, input, outputs: [{ candidateId: id(71), value: "CEDAR", explanation: "Applied Unicode uppercase mapping." }], notes: [], truncated: false, createdAt: at };
    expect(nameTransformSchema.safeParse(transform).success).toBe(true);
    expect(nameTransformSchema.safeParse({ ...transform, outputs: [{ ...transform.outputs[0], value: "ELM" }] }).success).toBe(false);
    expect(transformProjectNamesResponseSchema.safeParse({ transform, entries: [] }).success).toBe(false);
  });
  it("bounds the account library and binds every candidate to its owned project summary", () => {
    const retention = { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null };
    const project = { id: projectId, owner_id: ownerId, title: "Local fixture", scope: "complete_brand", current_revision: 4, created_at: at };
    const item = { candidate: candidate(), retention, project, currentSelection: false, earlierContext: true };
    const page = { ownerId, items: [item], nextCursor: null };
    expect(accountNamesPageSchema.safeParse(page).success).toBe(true);
    expect(accountNamesPageSchema.safeParse({ ...page, items: [{ ...item, project: { ...project, id: id(99) } }] }).success).toBe(false);
    expect(accountNamesPageSchema.safeParse({ ...page, ownerId: id(90) }).success).toBe(false);
    const missing: Record<string, unknown> = { ...item };
    delete missing.earlierContext;
    expect(accountNamesPageSchema.safeParse({ ...page, items: [missing] }).success).toBe(false);
    expect(accountNamesPageSchema.safeParse({ ...page, items: [{ ...item, earlierContext: "false" }] }).success).toBe(false);
  });
});


describe("stored explanation compatibility", () => {
  it("reads previously stored rationales without applying the new-generation gate", () => {
    expect(projectNameCandidateSchema.parse({ ...candidate(), rationale: "\u200D" }).rationale).toBe("\u200D");
    expect(projectNameCandidateSchema.parse({ ...candidate(), rationale: "Legacy\u202Etext" }).rationale).toBe("Legacy\u202Etext");
  });
});
