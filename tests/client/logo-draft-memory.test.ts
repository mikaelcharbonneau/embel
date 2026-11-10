/** Synthetic records only: no database, provider, file or license evidence. */
import { describe, expect, it } from "vitest";
import { createLogoDraftMemory, type LogoDraftRecord } from "../../src/components/identity/logo-draft-memory";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";

const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1),
  projectId = id(2),
  requestKey = id(3);
const brief = {
  name: "Cedar",
  activity: "Studio",
  audience: "Founders",
  personality: "Calm",
  logoTypes: ["wordmark" as const],
};
const heads = {
  projectRevision: 1,
  referenceRevision: 0,
  preferencesRevision: 0,
  workspaceRevision: 0,
  stageRevisions: { brief_references: 0, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
};
const workspace = () =>
  logoWorkspaceV2Schema.parse({
    version: 2,
    ownerId,
    projectId,
    heads,
    stages: {
      brief_references: null,
      concepts: null,
      vector: null,
      refinements: null,
      directions: null,
      deliverables: null,
    },
    approvedLogo: null,
    staleStages: [],
    capabilities: Object.fromEntries(
      ["save", "upload", "generate", "convert", "export"].map((key) => [
        key,
        { status: "unavailable", reason: "Synthetic fixture" },
      ]),
    ),
  });
const draft = (saved = false): LogoDraftRecord => ({
  workspace: saved ? workspace() : null,
  base: saved ? heads : null,
  brief: structuredClone(brief),
  references: [],
  dirty: true,
  pendingIntent: null,
  pendingExport: null,
  pendingMutation: null,
  conflict: false,
});
const memory = () => {
  const store = createLogoDraftMemory();
  store.bind({ ownerId, generation: 1 });
  return store;
};
function savedDraft(project: string, dirty = false): LogoDraftRecord {
  return { ...draft(true), workspace: { ...workspace(), projectId: project }, dirty };
}

describe("provider-owned logo drafts", () => {
  it("retains incomplete and overlong editable values synchronously with an unsaved guard", () => {
    const store = memory(),
      value = draft(true);
    value.brief = { ...brief, name: "", activity: "seed".repeat(3000), logoTypes: [] };
    let observed = false;
    store.subscribe(() => {
      observed = store.hasUnsaved();
    });
    store.set(projectId, value);
    expect(store.get(projectId)?.brief).toEqual(value.brief);
    expect(observed).toBe(true);
    value.brief.activity = "changed outside the store";
    expect(store.get(projectId)?.brief.activity).toHaveLength(12000);
    expect(Object.isFrozen(store.get(projectId)?.brief)).toBe(true);
  });
  it("keeps drafts only for saved projects", () => {
    const store = memory();
    expect(() => store.set(projectId, draft())).toThrow();
    expect(store.get(projectId)).toBeNull();
    expect(store.hasUnsaved()).toBe(false);
  });
  it("hides private values while unverified and recovers the same owner's exact draft", () => {
    const store = memory(),
      value = draft(true);
    store.set(projectId, value);
    const original = store.get(projectId);
    store.bind(null);
    expect(store.get(projectId)).toBeNull();
    expect(store.hasUnsaved()).toBe(true);
    expect(() => store.set(projectId, value)).toThrow();
    store.bind({ ownerId, generation: 9 });
    expect(store.get(projectId)).toEqual(original);
  });
  it("clears the former owner's buffers on a different verified owner and on confirmed logout", () => {
    const store = memory();
    store.set(projectId, draft(true));
    store.bind(null);
    store.bind({ ownerId: id(4), generation: 2 });
    expect(store.get(projectId)).toBeNull();
    expect(store.hasUnsaved()).toBe(false);
    const other = { ...draft(true), workspace: { ...workspace(), ownerId: id(4) } };
    store.set(projectId, other);
    store.clear();
    store.bind({ ownerId: id(4), generation: 3 });
    expect(store.get(projectId)).toBeNull();
  });
  it("rejects foreign workspace ownership, mismatched base and method/body combinations", () => {
    const store = memory(),
      value = draft(true);
    expect(() => store.set(projectId, { ...value, workspace: { ...workspace(), ownerId: id(4) } })).toThrow();
    expect(() => store.set(projectId, { ...value, base: { ...heads, projectRevision: 2 } })).toThrow();
    const forged = {
      requestKey,
      command: { method: "saveLogoBrief", body: { requestKey, expected: heads, selections: [] } },
    };
    expect(() => store.set(projectId, { ...value, pendingMutation: forged } as unknown as LogoDraftRecord)).toThrow();
    expect(store.get(projectId)).toBeNull();
  });
  it("retains export options and generation/manual intents under their original keys", () => {
    const store = memory(),
      value = draft(true);
    value.dirty = false;
    value.pendingExport = {
      requestKey,
      expected: heads,
      approvedLogoId: id(5),
      directionApprovalId: id(6),
      variantSetId: id(7),
      pngLongEdge: 4096,
      socialSelections: [{ kind: "avatar", presetId: "square" }],
    };
    store.set(projectId, value);
    store.bind(null);
    expect(store.hasUnsaved()).toBe(true);
    store.bind({ ownerId, generation: 8 });
    expect(store.get(projectId)?.pendingExport).toEqual(value.pendingExport);
    expect(() =>
      store.set(projectId, { ...value, pendingExport: { ...value.pendingExport!, requestKey: id(8) } }),
    ).toThrow();
    expect(() =>
      store.set(projectId, { ...value, pendingExport: { ...value.pendingExport!, pngLongEdge: 512 } }),
    ).toThrow();
    store.set(projectId, {
      ...value,
      pendingExport: null,
      pendingIntent: { requestKey, quoteId: id(9), acceptedMaxCostMicrousd: 7, expected: heads },
    });
    expect(store.hasUnsaved()).toBe(true);
    const current = store.get(projectId)!;
    expect(() =>
      store.set(projectId, { ...current, pendingIntent: { ...current.pendingIntent!, quoteId: id(10) } }),
    ).toThrow();
  });
  it("requires strict durable bodies even when the editable draft is incomplete", () => {
    const store = memory(),
      value = draft(true);
    value.brief.name = "";
    store.set(projectId, value);
    const incomplete = {
      requestKey,
      command: { method: "saveLogoBrief" as const, body: { requestKey, expected: heads, brief: value.brief } },
    };
    expect(() => store.set(projectId, { ...value, pendingMutation: incomplete })).toThrow();
    expect(store.get(projectId)?.pendingMutation).toBeNull();
  });
  it("preserves a direction draft across same-owner checks and counts it as unsaved", () => {
    const store = memory();
    const directionDraft = {
      approvedLogoId: id(20),
      paletteVersionId: id(21),
      typographyVersionId: id(22),
      graphicsVersionId: id(23),
      reviewedConsistencyHash: null,
    };
    store.set(projectId, { ...draft(true), dirty: false, directionDraft } as LogoDraftRecord);
    expect(store.hasUnsaved()).toBe(true);
    store.bind(null);
    expect(store.get(projectId)).toBeNull();
    store.bind({ ownerId, generation: 2 });
    expect((store.get(projectId) as LogoDraftRecord & { directionDraft: unknown }).directionDraft).toEqual(
      directionDraft,
    );
    store.bind({ ownerId: id(24), generation: 3 });
    expect(store.get(projectId)).toBeNull();
    expect(store.hasUnsaved()).toBe(false);
  });
  it("rejects direction drafts on unsaved projects and malformed review hashes", () => {
    const store = memory();
    const directionDraft = {
      approvedLogoId: id(20),
      paletteVersionId: id(21),
      typographyVersionId: id(22),
      graphicsVersionId: id(23),
      reviewedConsistencyHash: "bad",
    };
    expect(() => store.set(projectId, { ...draft(true), directionDraft } as LogoDraftRecord)).toThrow();
    expect(() =>
      store.set(projectId, {
        ...draft(),
        directionDraft: { ...directionDraft, reviewedConsistencyHash: null },
      } as LogoDraftRecord),
    ).toThrow();
  });

  it("retains unsent vector controls separately from an admitted mutation", () => {
    const store = memory();
    const vectorDraft = {
      baseVectorRevisionId: id(30),
      edit: { kind: "rotation" as const, componentId: "symbol", degrees: 15 },
    };
    store.set(projectId, { ...draft(true), dirty: false, vectorDraft } as LogoDraftRecord);
    expect(store.hasUnsaved()).toBe(true);
    expect(store.get(projectId)?.pendingMutation).toBeNull();
    store.bind(null);
    expect(store.get(projectId)).toBeNull();
    store.bind({ ownerId, generation: 2 });
    expect((store.get(projectId) as LogoDraftRecord & { vectorDraft: unknown }).vectorDraft).toEqual(vectorDraft);
    store.clear();
    expect(store.hasUnsaved()).toBe(false);
    expect(() => {
      store.bind({ ownerId, generation: 3 });
      store.set(projectId, { ...draft(), vectorDraft } as LogoDraftRecord);
    }).toThrow();
  });

  it("opens more than twenty projects by evicting only saved baselines", () => {
    const store = memory();
    for (let n = 1; n <= 25; n++) store.set(id(100 + n), savedDraft(id(100 + n)));
    expect(store.hasUnsaved()).toBe(false);
    expect(store.get(id(101))).toBeNull();
    expect(store.get(id(105))).toBeNull();
    expect(store.get(id(106))?.workspace?.projectId).toBe(id(106));
    expect(store.get(id(125))?.workspace?.projectId).toBe(id(125));
    store.set(id(101), savedDraft(id(101)));
    expect(store.get(id(101))?.workspace?.projectId).toBe(id(101));
  });

  it("preserves edits, pending requests and vector proposal drafts while making room", () => {
    const store = memory(),
      pending = { requestKey, quoteId: id(9), acceptedMaxCostMicrousd: 7, expected: heads };
    store.set(id(101), savedDraft(id(101), true));
    store.set(id(102), { ...savedDraft(id(102)), pendingIntent: pending });
    store.set(id(103), savedDraft(id(103)));
    const proposal = {
      baseVectorRevisionId: id(400),
      instruction: "Make the symbol larger",
      targetComponentIds: ["symbol"],
      dirty: true,
      pendingGeneration: null,
      pendingApplication: null,
      selectedProposalId: null,
    };
    store.setVectorProposal(id(103), proposal);
    for (let n = 4; n <= 21; n++) store.set(id(100 + n), savedDraft(id(100 + n)));
    expect(store.get(id(101))?.dirty).toBe(true);
    expect(store.get(id(102))?.pendingIntent).toEqual(pending);
    expect(store.get(id(103))).not.toBeNull();
    expect(store.getVectorProposal(id(103))).toEqual(proposal);
    expect(store.get(id(104))).toBeNull();
    expect(store.get(id(121))).not.toBeNull();
    expect(store.hasUnsaved()).toBe(true);
  });

  it("keeps every existing recovery record when no clean baseline can be evicted", () => {
    const store = memory();
    for (let n = 1; n <= 20; n++) store.set(id(100 + n), savedDraft(id(100 + n), true));
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    expect(() => store.set(id(121), savedDraft(id(121)))).toThrow();
    for (let n = 1; n <= 20; n++) expect(store.get(id(100 + n))?.dirty).toBe(true);
    expect(store.get(id(121))).toBeNull();
    expect(notifications).toBe(0);
  });
});
