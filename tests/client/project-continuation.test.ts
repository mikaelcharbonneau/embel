import { describe, expect, it, vi } from "vitest";
import { createAccountIdentityClient } from "@/components/identity/account-identity-client";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { readProjectContinuation } from "@/components/workspace/project-continuation";
import { identityBatchStateSchema } from "@/domain/identity-jobs";
import { accountProjectSchema } from "@/domain/project-api";
import { getIdentityCurrentBasis, getIdentityFreshness } from "@/domain/project-identity";
import { syntheticLogoWorkspace } from "../fixtures/logo-creation";
import { createVisualJourneyFixture, ownerId, projectId, type VisualJourneyFixture } from "../fixtures/visual-identity-journey";
import { fixtureId } from "./project-identity-fixtures";

const base = `/brands/account/${projectId}`;
const directions = `${base}/logo/directions`;

function setup() {
  const journey = createVisualJourneyFixture();
  const project = accountProjectSchema.parse(journey.project);
  const account = { status: "ready" as const, userId: ownerId, generation: 1 };
  const logo = vi.mockObject(createAccountLogoClient(account, projectId, () => true, vi.fn()));
  const identity = vi.mockObject(createAccountIdentityClient(account, projectId, () => true, vi.fn()));
  logo.getLogoWorkspace.mockResolvedValue(journey.workspace);
  logo.getLogoStageRevision.mockImplementation(async (_stage, id) => journey.stages.get(id) ?? null);
  const { id, requestKey, createdAt } = journey.logoBatch;
  logo.listLogoConceptBatches.mockResolvedValue({ ownerId, projectId, items: [{ id, requestKey, createdAt }], nextCursor: null });
  logo.readLogoConceptBatch.mockResolvedValue(journey.logoBatch);
  identity.overview.mockImplementation(async () => journey.overview());
  identity.generation.mockImplementation(async () => ({ ownerId, projectId, availability: journey.availability(), latest: journey.readBatch() }));
  const read = (saved = project) => readProjectContinuation(saved, { logo, identity }, new AbortController().signal);
  return { journey, project, logo, identity, read };
}

function startBatch(journey: VisualJourneyFixture) {
  const ready = journey.availability();
  journey.batch = identityBatchStateSchema.parse({
    ownerId, projectId, batchId: fixtureId(400), jobId: fixtureId(401), status: "queued", terminal: false,
    input: journey.input, sourceLogo: ready.sourceLogo, sourceLogoCurrent: true,
    intent: { version: 3, spendControl: "uncapped", idempotencyKey: "project-continuation-test",
      acceptedPolicyIdentity: ready.policyIdentity, sourceLogo: ready.sourceLogo.source, expectedLogoRevision: ready.expectedLogoRevision,
      expectedProjectRevision: ready.expectedProjectRevision, expectedReferenceRevision: ready.expectedReferenceRevision,
      expectedPreferencesRevision: ready.expectedPreferencesRevision, expectedIdentityRevision: 0 },
    systems: [], fulfillment: { targetCount: 3, acceptedCount: 0, status: "pending" }, usage: { status: "pending", knownCostMicrousd: 0 },
  });
}

describe("project continuation from saved work", () => {
  it("opens the kit for the chosen direction even when the latest batch has no completed directions", async () => {
    const { journey, identity, read } = setup();
    startBatch(journey);
    journey.complete();
    journey.choose(1);
    startBatch(journey);
    journey.batch = { ...journey.batch!, batchId: fixtureId(410), jobId: fixtureId(411) };
    expect(journey.readBatch()?.systems).toHaveLength(0);
    expect(await read()).toEqual({ label: "View brand kit", href: `${base}/logo/deliverables` });
    expect(identity.generation).not.toHaveBeenCalled();
  });

  it.each(["earlier source", "different logo"] as const)("ignores both selections and batches for the %s", async condition => {
    const { journey, read } = setup();
    startBatch(journey);
    journey.complete();
    journey.choose();
    if (condition === "earlier source") journey.sourceCurrent = false;
    else {
      const stage = journey.stages.get(journey.workspace.stages.concepts!.id)!;
      if (stage.stage !== "concepts") throw Error("Expected concepts fixture");
      const slot = journey.logoBatch.slots[1]!;
      journey.stages.set(stage.id, { ...stage, payload: { ...stage.payload,
        selected: { kind: "concept", batchId: journey.logoBatch.id, slotId: slot.id, attemptId: slot.attempts[0]!.id } } });
    }
    expect(await read()).toEqual({ label: "Explore creative directions", href: directions });
  });

  it("keeps the existing logo but excludes directions made for earlier brand preferences", async () => {
    const { journey, identity, read } = setup();
    startBatch(journey);
    journey.complete();
    journey.choose();
    const before = journey.overview(), selected = before.currentSelection!;
    const preferences = { ...journey.input.preferences, notes: "Use a brighter palette" };
    const currentBasis = getIdentityCurrentBasis({ ownerId, projectId, context: journey.input.context,
      references: journey.input.referenceSnapshot, logoBrief: journey.sourceLogo.brief, preferences });
    identity.overview.mockResolvedValue({ ...before, currentBasis,
      currentSelection: { ...selected, freshness: getIdentityFreshness(selected.system.input.basis, currentBasis) } });
    expect(await read()).toEqual({ label: "Explore creative directions", href: directions });
  });

  it.each([[3, "Compare 3 directions"], [2, "Compare 2 directions"], [1, "Review visual direction"]] as const)(
    "offers the %i directions actually retained", async (count, label) => {
      const { journey, read } = setup();
      startBatch(journey);
      journey.complete(count);
      expect(await read()).toEqual({ label, href: directions });
    });

  it("distinguishes an unresolved request from a project that has never generated directions", async () => {
    const { journey, read } = setup();
    expect(await read()).toEqual({ label: "Explore creative directions", href: directions });
    startBatch(journey);
    expect(await read()).toEqual({ label: "Check direction progress", href: directions });
  });

  it("offers generated logos for selection without reading directions", async () => {
    const { journey, logo, identity, read } = setup();
    const stage = journey.stages.get(journey.workspace.stages.concepts!.id)!;
    if (stage.stage !== "concepts") throw Error("Expected concepts fixture");
    journey.stages.set(stage.id, { ...stage, payload: { ...stage.payload, selected: null } });
    expect(await read()).toEqual({ label: "Choose a logo", href: `${base}/logo` });
    expect(logo.readLogoConceptBatch).toHaveBeenCalledExactlyOnceWith(journey.logoBatch.id, expect.any(AbortSignal));
    expect(identity.overview).not.toHaveBeenCalled();
  });

  it("resumes an early full brand at its first unfinished Strategy decision", async () => {
    const { project, logo, identity, read } = setup();
    const empty = syntheticLogoWorkspace();
    logo.getLogoWorkspace.mockResolvedValue({ ...empty, ownerId, projectId, heads: { ...empty.heads, projectRevision: project.current_revision } });
    const saved = accountProjectSchema.parse({ ...project, scope: "complete_brand", context: {} });
    expect(await read(saved)).toEqual({ label: "Review the saved brief", href: `${base}?view=strategy#strategy-brief` });
    expect(logo.listLogoConceptBatches).not.toHaveBeenCalled();
    expect(identity.overview).not.toHaveBeenCalled();
  });
});
