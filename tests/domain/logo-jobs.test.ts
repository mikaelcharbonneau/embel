import { describe, expect, it } from "vitest";
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1),
  projectId = id(2),
  at = "2026-10-06T12:00:00Z",
  hash = "a".repeat(64);
const heads = {
  projectRevision: 1,
  referenceRevision: 0,
  preferencesRevision: 0,
  workspaceRevision: 0,
  stageRevisions: { brief_references: 0, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
};
const asset = (n = 10) => ({ ownerId, projectId, assetId: id(n), versionId: id(n + 1), contentHash: hash });
const receipt = (n = 20) => ({
  id: id(n),
  reference: asset(n + 1),
  verification: { status: "verified", checkedAt: at, contentHash: hash, mimeType: "image/png", byteLength: 100 },
  purpose: "brand_asset",
  sourceReceiptId: id(n + 3),
  rightsEvidenceId: null,
  publicationState: "committed",
});
import {
  logoConceptPlanSchema,
  logoConceptBatchSchema,
  logoQuoteRequestSchema,
  logoGenerationIntentSchema,
  logoConceptAttemptSchema,
  logoRasterRefinementSchema,
  logoCostQuoteSchema,
  LOGO_CONCEPT_OPERATION,
} from "../../src/domain/logo-jobs";
const plan = () => ({
  version: 1,
  targetCount: 6,
  requestedTypes: ["wordmark"],
  slots: Array.from({ length: 6 }, (_, ordinal) => ({
    ordinal,
    type: "wordmark",
    directionId: `direction-${ordinal}`,
  })),
  coveredTypes: ["wordmark"],
  uncoveredTypes: [],
});
describe("V2 job boundaries", () => {
  it("freezes six distinct slots and honest selected-type coverage", () => {
    const p = plan();
    expect(logoConceptPlanSchema.safeParse(p).success).toBe(true);
    expect(logoConceptPlanSchema.safeParse({ ...p, slots: p.slots.slice(1) }).success).toBe(false);
    expect(logoConceptPlanSchema.safeParse({ ...p, slots: p.slots.map((s) => ({ ...s, ordinal: 0 })) }).success).toBe(
      false,
    );
    expect(logoConceptPlanSchema.safeParse({ ...p, coveredTypes: ["mascot"] }).success).toBe(false);
    expect(LOGO_CONCEPT_OPERATION).toBe("identity.logo_concept");
  });
  it("binds batch slots to the frozen plan", () => {
    const p = plan();
    const b = {
      version: 2,
      id: id(3),
      ownerId,
      projectId,
      requestKey: id(4),
      briefRevisionId: id(5),
      referenceSnapshotId: id(6),
      targetCount: 6,
      plan: p,
      slots: p.slots.map((s, i) => ({ ...s, id: id(30 + i), attempts: [], acceptedPreview: null })),
      createdAt: at,
    };
    expect(logoConceptBatchSchema.safeParse(b).success).toBe(true);
    expect(
      logoConceptBatchSchema.safeParse({ ...b, slots: b.slots.map((s, i) => (i ? s : { ...s, type: "mascot" })) })
        .success,
    ).toBe(false);
  });
  it("discriminates priced operations and rejects browser execution evidence", () => {
    const q = {
      operation: "refine_preview",
      expected: heads,
      source: { kind: "refinement", rasterRevisionId: id(4) },
      instruction: "Simplify",
    };
    expect(logoQuoteRequestSchema.safeParse(q).success).toBe(true);
    for (const bad of [
      { ...q, operation: "retry_failed" },
      { ...q, ownerId },
      { ...q, provider: "invented" },
      { ...q, source: { kind: "refinement", rasterRevisionId: id(4), jobId: id(5) } },
    ])
      expect(logoQuoteRequestSchema.safeParse(bad).success).toBe(false);
    expect(
      logoGenerationIntentSchema.safeParse({
        requestKey: id(3),
        quoteId: id(4),
        expected: heads,
        acceptedMaxCostMicrousd: 0,
        rightsEvidenceId: id(6),
      }).success,
    ).toBe(false);
  });
  it("keeps verified partial output visible while billing remains uncertain", () => {
    const a = {
      id: id(3),
      jobId: id(4),
      slotId: id(5),
      requestKey: id(6),
      previousAttemptId: null,
      attemptNumber: 1,
      inputHash: hash,
      state: "needs_reconciliation",
      preview: receipt(),
      providerResponseReceiptId: id(7),
      reservedCostMicrousd: 100,
      billing: { status: "unknown", confirmedMicrousd: null },
      reason: "billing_unknown",
    };
    expect(logoConceptAttemptSchema.safeParse(a).success).toBe(true);
    expect(logoConceptAttemptSchema.safeParse({ ...a, state: "succeeded" }).success).toBe(false);
    expect(
      logoConceptAttemptSchema.safeParse({ ...a, preview: { ...receipt(), publicationState: "staged" } }).success,
    ).toBe(false);
  });
  it("retains exact raster refinement provenance independently of conversion", () => {
    const r = {
      version: 2,
      id: id(3),
      ownerId,
      projectId,
      requestKey: id(4),
      jobId: id(5),
      source: { kind: "vector", vectorRevisionId: id(6) },
      logoType: "mascot",
      preview: receipt(),
      providerResponseReceiptId: id(7),
      state: "needs_reconciliation",
      billing: { status: "unknown", confirmedMicrousd: null },
      reason: "billing_unknown",
      inputRevisions: [],
      createdAt: at,
    };
    expect(logoRasterRefinementSchema.safeParse(r).success).toBe(true);
    expect(
      logoRasterRefinementSchema.safeParse({
        ...r,
        preview: { ...receipt(), reference: { ...asset(), ownerId: id(99) } },
      }).success,
    ).toBe(false);
  });
  it("does not make a local vector quote a paid provider quote", () => {
    const q = {
      id: id(3),
      ownerId,
      projectId,
      request: {
        operation: "vectorize",
        expected: heads,
        source: { kind: "refinement", rasterRevisionId: id(4) },
        settings: { preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 2 },
      },
      inputHash: hash,
      expected: heads,
      policyIdentity: hash,
      handlerVersion: "1",
      provider: null,
      model: null,
      engine: { id: "trace", version: "1", artifactHash: hash, settingsHash: hash },
      estimatedCostMicrousd: 0,
      maxCostMicrousd: 0,
      externalProviderCostMicrousd: 0,
      expiresAt: at,
      conceptPlan: null,
      targetSlotIds: [],
    };
    expect(logoCostQuoteSchema.safeParse(q).success).toBe(true);
    expect(logoCostQuoteSchema.safeParse({ ...q, externalProviderCostMicrousd: 1 }).success).toBe(false);
  });
});

import {
  logoResolvedConceptInputSchema,
  logoConceptJobInputSchema,
  logoConceptSlotSchema,
  logoRequestStateSchema,
  logoDirectionPublicationReceiptSchema,
  logoExportJobInputSchema,
  logoProviderResponseReceiptSchema,
} from "../../src/domain/logo-jobs";
describe("job source and recovery fences", () => {
  it("does not release uncertain expense as a confirmed free success", () => {
    const state = {
      status: "needs_reconciliation",
      requestKey: id(3),
      receipt: null,
      outputs: [receipt()],
      billing: { status: "unknown", confirmedMicrousd: null },
      reason: "billing_unknown",
    };
    expect(logoRequestStateSchema.safeParse(state).success).toBe(true);
    expect(logoRequestStateSchema.safeParse({ ...state, status: "succeeded" }).success).toBe(false);
    expect(
      logoRequestStateSchema.safeParse({ ...state, billing: { status: "unknown", confirmedMicrousd: 0 } }).success,
    ).toBe(false);
  });
  it("rejects success state without a durable receipt", () => {
    expect(
      logoRequestStateSchema.safeParse({
        status: "succeeded",
        requestKey: id(3),
        receipt: null,
        outputs: [],
        billing: { status: "recorded", confirmedMicrousd: 0 },
        reason: null,
      }).success,
    ).toBe(false);
  });
  it("rejects skipped attempts and invented accepted previews", () => {
    const slot = {
      id: id(3),
      ordinal: 0,
      type: "wordmark",
      directionId: "direction-0",
      attempts: [],
      acceptedPreview: receipt(),
    };
    expect(logoConceptSlotSchema.safeParse(slot).success).toBe(false);
  });
  it("keeps exactly three distinct staged direction IDs", () => {
    const r = {
      id: id(3),
      ownerId,
      projectId,
      jobId: id(4),
      inputHash: hash,
      directionIds: [id(5), id(6), id(7)],
      publicationState: "staged",
    };
    expect(logoDirectionPublicationReceiptSchema.safeParse(r).success).toBe(true);
    expect(logoDirectionPublicationReceiptSchema.safeParse({ ...r, directionIds: [id(5), id(5), id(7)] }).success).toBe(
      false,
    );
    expect(logoDirectionPublicationReceiptSchema.safeParse({ ...r, publicationState: "committed" }).success).toBe(
      false,
    );
  });
  it("binds resolved concept reference membership, not just snapshot ID", () => {
    const input = {
      version: 2,
      ownerId,
      projectId,
      requestKey: id(3),
      quoteId: id(4),
      policyIdentity: hash,
      handlerVersion: "1",
      inputHash: hash,
      operation: "identity.logo_concept",
      batchId: id(5),
      slotId: id(6),
      attemptId: id(7),
      attemptNumber: 1,
      previousAttemptId: null,
      directionId: "direction-0",
      plan: plan(),
      ordinal: 0,
      briefRevisionId: id(8),
      referenceSnapshotId: id(9),
      references: [asset()],
    };
    const brief = {
      version: 2,
      id: id(8),
      ownerId,
      projectId,
      stage: "brief_references",
      revision: 1,
      parentRevisionId: null,
      inputRevisions: [],
      inputHash: hash,
      payload: {
        name: "Café",
        activity: "Design",
        audience: "Founders",
        personality: "Warm",
        logoTypes: ["wordmark"],
        referenceSnapshotId: id(9),
        sourceProjectRevision: 1,
      },
      createdAt: at,
    };
    const referenceSnapshot = { version: 2, id: id(9), ownerId, projectId, revision: 1, references: [] };
    expect(logoConceptJobInputSchema.safeParse(input).success).toBe(true);
    expect(
      logoResolvedConceptInputSchema.safeParse({
        input,
        brief,
        referenceSnapshot,
        inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
      }).success,
    ).toBe(false);
    expect(
      logoResolvedConceptInputSchema.safeParse({
        input: { ...input, references: [] },
        brief,
        referenceSnapshot,
        inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
      }).success,
    ).toBe(true);
  });
  it("keeps export jobs distinct from priced generation admissions", () => {
    const j = {
      version: 2,
      ownerId,
      projectId,
      requestKey: id(3),
      policyIdentity: hash,
      handlerVersion: "1",
      inputHash: hash,
      operation: "identity.logo_export",
      approvedLogoId: id(4),
      directionApprovalId: id(5),
      variantSetId: id(6),
      variantReviewId: id(7),
      sourceSnapshotHash: hash,
    };
    expect(logoExportJobInputSchema.safeParse(j).success).toBe(true);
    expect(logoExportJobInputSchema.safeParse({ ...j, quoteId: id(8) }).success).toBe(false);
  });
  it("keeps provider observation bound to a lease and exact hashes", () => {
    const observation = {
      provider: "provider",
      model: "model",
      providerRequestId: null,
      responseHash: hash,
      observedAt: at,
      billing: { status: "unknown", confirmedMicrousd: null },
      artifactHash: hash,
      id: id(3),
      ownerId,
      projectId,
      jobId: id(4),
      leaseToken: id(5),
    };
    expect(logoProviderResponseReceiptSchema.safeParse(observation).success).toBe(true);
    expect(logoProviderResponseReceiptSchema.safeParse({ ...observation, leaseToken: "invented" }).success).toBe(false);
  });
});

it("retains exact reference order from the frozen concept snapshot", () => {
  const input = {
    version: 2,
    ownerId,
    projectId,
    requestKey: id(3),
    quoteId: id(4),
    policyIdentity: hash,
    handlerVersion: "1",
    inputHash: hash,
    operation: "identity.logo_concept",
    batchId: id(5),
    slotId: id(6),
    attemptId: id(7),
    attemptNumber: 1,
    previousAttemptId: null,
    directionId: "direction-0",
    plan: plan(),
    ordinal: 0,
    briefRevisionId: id(8),
    referenceSnapshotId: id(9),
    references: [asset(10), asset(30)],
  };
  const brief = {
    version: 2,
    id: id(8),
    ownerId,
    projectId,
    stage: "brief_references",
    revision: 1,
    parentRevisionId: null,
    inputRevisions: [],
    inputHash: hash,
    payload: {
      name: "Café",
      activity: "Design",
      audience: "Founders",
      personality: "Warm",
      logoTypes: ["wordmark"],
      referenceSnapshotId: id(9),
      sourceProjectRevision: 1,
    },
    createdAt: at,
  };
  const referenceSnapshot = {
    version: 2,
    id: id(9),
    ownerId,
    projectId,
    revision: 1,
    references: [10, 30].map((n) => ({
      referenceId: id(n + 2),
      asset: asset(n),
      sourceKind: "upload",
      aspects: ["shape"],
      rightsEvidenceId: id(n + 3),
    })),
  };
  expect(
    logoResolvedConceptInputSchema.safeParse({
      input,
      brief,
      referenceSnapshot,
      inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
    }).success,
  ).toBe(true);
  expect(
    logoResolvedConceptInputSchema.safeParse({
      input: { ...input, references: [asset(30), asset(10)] },
      brief,
      referenceSnapshot,
      inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
    }).success,
  ).toBe(false);
  expect(
    logoResolvedConceptInputSchema.safeParse({
      input: { ...input, references: [asset(10), asset(10)] },
      brief,
      referenceSnapshot,
      inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
    }).success,
  ).toBe(false);
});

import { logoResolvedRefinementInputSchema, logoResolvedDirectionInputSchema } from "../../src/domain/logo-jobs";
describe("F2: complete maximum reference loader projections", () => {
  it("retains the entire resolved snapshot through concept, refinement and direction inputs", () => {
    const referenceSnapshot = {
      version: 2,
      id: id(9),
      ownerId,
      projectId,
      revision: Number.MAX_SAFE_INTEGER,
      references: Array.from({ length: 100 }, (_, i) => ({
        referenceId: id(1000 + i),
        asset: asset(2000 + i * 2),
        sourceKind: "curated",
        aspects: ["lettering", "shape", "composition", "overall_feel"],
        rightsEvidenceId: id(3000 + i),
      })),
    };
    const brief = {
      version: 2,
      id: id(8),
      ownerId,
      projectId,
      stage: "brief_references",
      revision: 1,
      parentRevisionId: null,
      inputRevisions: [],
      inputHash: hash,
      payload: {
        name: "Café",
        activity: "Design",
        audience: "Founders",
        personality: "Warm",
        logoTypes: ["wordmark"],
        referenceSnapshotId: id(9),
        sourceProjectRevision: 1,
      },
      createdAt: at,
    };
    const basis = {
      version: 2,
      ownerId,
      projectId,
      requestKey: id(3),
      quoteId: id(4),
      policyIdentity: hash,
      handlerVersion: "1",
      inputHash: hash,
    };
    const input = {
      ...basis,
      operation: "identity.logo_concept",
      batchId: id(5),
      slotId: id(6),
      attemptId: id(7),
      attemptNumber: 1,
      previousAttemptId: null,
      directionId: "direction-0",
      plan: plan(),
      ordinal: 0,
      briefRevisionId: id(8),
      referenceSnapshotId: id(9),
      references: referenceSnapshot.references.map((r) => r.asset),
    };
    expect(
      logoResolvedConceptInputSchema.safeParse({
        input,
        brief,
        referenceSnapshot,
        inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
      }).success,
    ).toBe(true);
    expect(
      logoResolvedConceptInputSchema.safeParse({
        input: { ...input, references: [...input.references].reverse() },
        brief,
        referenceSnapshot,
        inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
      }).success,
    ).toBe(false);
    expect(
      logoResolvedConceptInputSchema.safeParse({
        input: { ...input, references: input.references.map((r, i) => (i ? r : input.references[1]!)) },
        brief,
        referenceSnapshot,
        inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
      }).success,
    ).toBe(false);
    expect(
      logoResolvedRefinementInputSchema.safeParse({
        inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
        input: {
          ...basis,
          operation: "identity.logo_refine",
          rasterRevisionId: id(10),
          instruction: "Simplify",
          briefRevisionId: id(8),
          referenceSnapshotId: id(9),
          source: { kind: "preview", raster: { kind: "refinement", rasterRevisionId: id(11) } },
        },
        brief,
        referenceSnapshot,
        basePreview: asset(),
      }).success,
    ).toBe(true);
    const logo = {
      version: 1,
      viewBox: [0, 0, 100, 100],
      components: [
        {
          id: "symbol",
          role: "symbol",
          editingKind: "geometry",
          paths: [
            {
              id: "p1",
              d: "M 0 0 L 10 0 L 10 10 Z",
              fill: { color: "#000000", opacity: 1 },
              stroke: null,
              fillRule: "nonzero",
            },
          ],
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        },
      ],
    };
    const approvedLogo = {
      id: id(12),
      ownerId,
      projectId,
      vectorRevisionId: id(13),
      stageRevisionId: id(14),
      approvedAt: at,
    };
    expect(
      logoResolvedDirectionInputSchema.safeParse({
        inputRevisions: [
          { stage: "brief_references", id: brief.id, revision: brief.revision },
          { stage: "vector", id: approvedLogo.stageRevisionId, revision: 1 },
        ],
        approvedLogo,
        logo,
        brief,
        references: referenceSnapshot,
        permittedFonts: [],
        targetCount: 3,
      }).success,
    ).toBe(true);
  });
});

describe("authoritative resolved publication lineage", () => {
  it("concept and refinement inputs require exact consumed brief lineage, never omitted or substituted provenance", () => {
    const references = { version: 2, id: id(9), ownerId, projectId, revision: 1, references: [] };
    const brief = {
      version: 2,
      id: id(8),
      ownerId,
      projectId,
      stage: "brief_references",
      revision: 1,
      parentRevisionId: null,
      inputRevisions: [],
      inputHash: hash,
      payload: {
        name: "Brand",
        activity: "Studio",
        audience: "Founders",
        personality: "Calm",
        logoTypes: ["wordmark"],
        referenceSnapshotId: id(9),
        sourceProjectRevision: 1,
      },
      createdAt: at,
    };
    const input = {
      version: 2,
      ownerId,
      projectId,
      requestKey: id(3),
      quoteId: id(4),
      policyIdentity: hash,
      handlerVersion: "1",
      inputHash: hash,
      operation: "identity.logo_concept",
      batchId: id(5),
      slotId: id(6),
      attemptId: id(7),
      attemptNumber: 1,
      previousAttemptId: null,
      directionId: "direction-0",
      plan: plan(),
      ordinal: 0,
      briefRevisionId: id(8),
      referenceSnapshotId: id(9),
      references: [],
    };
    const resolved = {
      input,
      brief,
      referenceSnapshot: references,
      inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
    };
    expect(logoResolvedConceptInputSchema.safeParse(resolved).success).toBe(true);
    expect(logoResolvedConceptInputSchema.safeParse({ ...resolved, inputRevisions: undefined }).success).toBe(false);
    expect(
      logoResolvedConceptInputSchema.safeParse({
        ...resolved,
        inputRevisions: [{ stage: "brief_references", id: id(999), revision: 1 }],
      }).success,
    ).toBe(false);
    const refined = {
      inputRevisions: resolved.inputRevisions,
      input: {
        version: 2,
        ownerId,
        projectId,
        requestKey: id(3),
        quoteId: id(4),
        policyIdentity: hash,
        handlerVersion: "1",
        inputHash: hash,
        operation: "identity.logo_refine",
        rasterRevisionId: id(12),
        instruction: "Simplify",
        briefRevisionId: brief.id,
        referenceSnapshotId: references.id,
        source: { kind: "preview", raster: { kind: "refinement", rasterRevisionId: id(11) } },
      },
      brief,
      referenceSnapshot: references,
      basePreview: asset(),
    };
    expect(logoResolvedRefinementInputSchema.safeParse(refined).success).toBe(true);
    expect(logoResolvedRefinementInputSchema.safeParse({ ...refined, inputRevisions: undefined }).success).toBe(false);
    expect(
      logoResolvedRefinementInputSchema.safeParse({
        ...refined,
        inputRevisions: [{ stage: "brief_references", id: brief.id, revision: 2 }],
      }).success,
    ).toBe(false);
  });
});

import { logoConceptBatchPageSchema } from "../../src/domain/logo-jobs";
describe("bounded concept batch discovery", () => {
  it("admits only lightweight unique owned batch summaries", () => {
    const summary = { id: id(10), requestKey: id(11), createdAt: at },
      page = { ownerId, projectId, items: [summary], nextCursor: null };
    expect(logoConceptBatchPageSchema.safeParse(page).success).toBe(true);
    expect(logoConceptBatchPageSchema.safeParse({ ...page, items: [{ ...summary, slots: [] }] }).success).toBe(false);
    expect(logoConceptBatchPageSchema.safeParse({ ...page, items: [summary, summary] }).success).toBe(false);
    expect(
      logoConceptBatchPageSchema.safeParse({
        ...page,
        items: Array.from({ length: 51 }, (_, i) => ({ ...summary, id: id(100 + i), requestKey: id(200 + i) })),
      }).success,
    ).toBe(false);
  });
});

import { logoExportPartialStepOutputSchema } from "../../src/domain/logo-jobs";
import { stepOutcomeSchema } from "../../src/domain/jobs";
describe("partial export is a known failed result, not a completed pack", () => {
  it("retains a strict partial publication pointer in failed step evidence", () => {
    const result = { version: 2, kind: "logo_export_partial", publicationId: id(99) };
    expect(logoExportPartialStepOutputSchema.parse(result)).toEqual(result);
    expect(
      stepOutcomeSchema.parse({
        status: "failed",
        code: "export_file_failed",
        result,
        costMicrousd: 0,
        providerRequestId: null,
      }),
    ).toMatchObject({ status: "failed", result });
    expect(logoExportPartialStepOutputSchema.safeParse({ ...result, kind: "logo_export" }).success).toBe(false);
  });
});
