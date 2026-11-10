import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoVectorMutationProducers } from "../../../src/features/logo-vector/server/mutations";
import {
  canonicalLogoDocumentBytes,
  validateLogoVectorCandidate,
} from "../../../src/features/logo-vector/server/revisions";
import { captureLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import type { LogoVectorDocument, LogoVectorRevision } from "../../../src/domain/logo-vector";
import type { LogoExpectedHeads, LogoStageRevision, LogoWorkspaceV2 } from "../../../src/domain/logo-workspace";
import type { LogoVectorDetail, VerifiedAssetBytes } from "../../../src/domain/logo-deliverables";
import type { IdentityAssetStore } from "../../../src/server/data/identity-asset-store";
import type { AuthenticatedContext } from "../../../src/server/auth/context";
import { separatedLogoDocument } from "./fixtures";
import { syntheticConversionInput, syntheticSource } from "./raster-fixtures";

function fixture(change: (document: LogoVectorDocument) => void = () => {}) {
  const source = syntheticConversionInput("combination").source,
    current = separatedLogoDocument(),
    target = structuredClone(current);
  change(target);
  const files = new Map<string, VerifiedAssetBytes>();
  function record(document: LogoVectorDocument): LogoVectorDetail {
    const proof = validateLogoVectorCandidate({
      base: null,
      candidate: document,
      locks: [],
      expectedSource: source.reference,
      source,
    });
    const doc = syntheticSource(canonicalLogoDocumentBytes(document), "application/json"),
      svg = syntheticSource(proof.svg, "image/svg+xml");
    for (const file of [doc, svg]) {
      file.reference.assetId = randomUUID();
      file.reference.versionId = randomUUID();
      files.set(file.reference.versionId, file);
    }
    const revision: LogoVectorRevision = {
      id: randomUUID(),
      ownerId: source.reference.ownerId,
      projectId: source.reference.projectId!,
      parentRevisionId: null,
      source: { kind: "refinement", rasterRevisionId: randomUUID() },
      sourcePreview: source.reference,
      documentAsset: doc.reference,
      svgAsset: svg.reference,
      documentHash: proof.documentHash,
      proof: proof.proof,
      locks: [...captureLogoComponentLocks(document, ["synthetic-symbol"])],
      inputRevisions: [],
      reviewStatus: "review_required",
      createdAt: "2026-10-07T00:00:00Z",
    };
    return {
      revision,
      document,
      sourcePreview: {
        id: randomUUID(),
        reference: source.reference,
        verification: source.verification,
        purpose: "brand_asset",
        sourceReceiptId: randomUUID(),
        rightsEvidenceId: null,
        publicationState: "committed",
      },
    };
  }
  const a = record(current),
    b = record(target),
    ownerId = a.revision.ownerId,
    projectId = a.revision.projectId;
  const expected: LogoExpectedHeads = {
    projectRevision: 1,
    referenceRevision: 0,
    preferencesRevision: 0,
    workspaceRevision: 2,
    stageRevisions: { brief_references: 0, concepts: 0, vector: 1, refinements: 1, directions: 0, deliverables: 0 },
  };
  const stages: LogoStageRevision[] = [
    {
      version: 2,
      id: randomUUID(),
      ownerId,
      projectId,
      stage: "vector",
      revision: 1,
      parentRevisionId: null,
      inputRevisions: [],
      inputHash: "a".repeat(64),
      payload: { vectorRevisionId: b.revision.id, approvalId: null },
      createdAt: "2026-10-07T00:00:00Z",
    },
    {
      version: 2,
      id: randomUUID(),
      ownerId,
      projectId,
      stage: "refinements",
      revision: 1,
      parentRevisionId: null,
      inputRevisions: [],
      inputHash: "b".repeat(64),
      payload: {
        rasterRevisionIds: [],
        vectorRevisionId: a.revision.id,
        approvalId: null,
        sourceRequestKey: randomUUID(),
      },
      createdAt: "2026-10-07T00:00:00Z",
    },
  ];
  const workspace: LogoWorkspaceV2 = {
    version: 2,
    ownerId,
    projectId,
    heads: expected,
    stages: {
      brief_references: null,
      concepts: null,
      vector: { stage: "vector", id: stages[0]!.id, revision: 1 },
      refinements: { stage: "refinements", id: stages[1]!.id, revision: 1 },
      directions: null,
      deliverables: null,
    },
    approvedLogo: null,
    staleStages: [],
    capabilities: {
      save: { status: "available" },
      upload: { status: "unavailable", reason: "local" },
      generate: { status: "unavailable", reason: "local" },
      convert: { status: "unavailable", reason: "local" },
      export: { status: "unavailable", reason: "local" },
    },
  };
  const producer = createLogoVectorMutationProducers({
    assetStore: {
      async readOwnedAsset(_auth, ref) {
        const file = files.get(ref.versionId);
        if (!file) throw Error("missing");
        return file;
      },
    } as IdentityAssetStore,
    async readVectorDetail(_auth, _project, id) {
      if (id === a.revision.id) return a;
      if (id === b.revision.id) return b;
      throw Error("missing");
    },
    async getWorkspace() {
      return workspace;
    },
    async readCurrentVectorRevisionId() {
      return a.revision.id;
    },
    async readStageRevision(_auth, _project, _stage, id) {
      const stage = stages.find((s) => s.id === id);
      if (!stage) throw Error("missing");
      return stage;
    },
  });
  const auth = { userId: ownerId } as AuthenticatedContext;
  return { producer, auth, projectId, a, b, expected, stages, workspace };
}

describe("actual-byte selection lock validation", () => {
  it("rejects restoration with unchanged lock digests but changed root viewBox", async () => {
    const f = fixture((document) => {
      document.viewBox[2] = 250;
    });
    expect(f.a.revision.locks).toEqual(f.b.revision.locks);
    await expect(
      f.producer.restoreLogoStage!(f.auth, f.projectId, {
        method: "restoreLogoStage",
        body: {
          requestKey: randomUUID(),
          expected: f.expected,
          stage: "vector",
          revisionId: f.stages[0]!.id,
          acceptEarlierBasis: true,
        },
      }),
    ).rejects.toMatchObject({ code: "locked_component_changed" });
  });
  it("rejects acceptance when another component newly occludes a locked one", async () => {
    const f = fixture((document) => {
      document.components[1]!.transform.x = -60;
    });
    expect(f.a.revision.locks).toEqual(f.b.revision.locks);
    await expect(
      f.producer.acceptLogoVector!(f.auth, f.projectId, {
        method: "acceptLogoVector",
        body: {
          requestKey: randomUUID(),
          expected: f.expected,
          vectorRevisionId: f.b.revision.id,
          acceptEarlierBasis: true,
        },
      }),
    ).rejects.toMatchObject({ code: "locked_component_changed" });
  });
  it("returns only exact checked IDs and original heads for an unchanged locked restore", async () => {
    const f = fixture();
    expect(
      await f.producer.restoreLogoStage!(f.auth, f.projectId, {
        method: "restoreLogoStage",
        body: {
          requestKey: randomUUID(),
          expected: f.expected,
          stage: "vector",
          revisionId: f.stages[0]!.id,
          acceptEarlierBasis: false,
        },
      }),
    ).toEqual({
      targetStageRevisionId: f.stages[0]!.id,
      currentVectorRevisionId: f.a.revision.id,
      targetVectorRevisionId: f.b.revision.id,
      expected: f.expected,
    });
  });
  it("does not use an otherwise identical old vector as an implicit unlock", async () => {
    const f = fixture();
    f.b.revision.locks = [];
    await expect(
      f.producer.acceptLogoVector!(f.auth, f.projectId, {
        method: "acceptLogoVector",
        body: {
          requestKey: randomUUID(),
          expected: f.expected,
          vectorRevisionId: f.b.revision.id,
          acceptEarlierBasis: false,
        },
      }),
    ).rejects.toMatchObject({ code: "locked_component_changed" });
  });
});
