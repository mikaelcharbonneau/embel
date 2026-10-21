import { describe, expect, it, vi } from "vitest";
import { readProjectCardPreview } from "@/components/workspace/project-card-preview";
import { logoStageRevisionSchema, type LogoStage } from "@/domain/logo-workspace";
import { syntheticLogoBatch, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";

function fixture() {
  const workspace = structuredClone(syntheticLogoWorkspace()), batch = syntheticLogoBatch(), brief = structuredClone(syntheticResolvedLogoConcept().brief);
  const refinement = syntheticRasterRefinement();
  const concepts = structuredClone(logoStageRevisionSchema.parse({ ...brief, id: id(800), stage: "concepts", payload: { batchIds: [batch.id], selected: { kind: "refinement", rasterRevisionId: refinement.id } } }));
  workspace.stages.brief_references = { id: brief.id, stage: "brief_references", revision: brief.revision };
  workspace.stages.concepts = { id: concepts.id, stage: "concepts", revision: concepts.revision };
  workspace.heads.stageRevisions.brief_references = brief.revision;
  workspace.heads.stageRevisions.concepts = concepts.revision;
  const client = {
    getLogoWorkspace: vi.fn(async () => workspace),
    getLogoStageRevision: vi.fn(async (stage: LogoStage) => stage === "brief_references" ? brief : concepts),
    readLogoConceptBatch: vi.fn(async () => batch),
    readLogoRasterRefinement: vi.fn(async () => refinement),
  };
  const read = (signal = new AbortController().signal) => readProjectCardPreview({ client, ownerId: workspace.ownerId, projectId: workspace.projectId, signal });
  return { workspace, brief, concepts, batch, refinement, client, read };
}

describe("project-card saved artwork", () => {
  it("reads the exact persisted refinement and brief name without selecting, approving or changing project metadata", async () => {
    const f = fixture(), before = structuredClone({ workspace: f.workspace, concepts: f.concepts, refinement: f.refinement });
    expect(await f.read()).toEqual({ name: f.brief.payload.name, receipt: f.refinement.preview });
    expect(f.client.readLogoRasterRefinement).toHaveBeenCalledExactlyOnceWith(f.refinement.id, expect.any(AbortSignal));
    expect(f.client.readLogoConceptBatch).not.toHaveBeenCalled();
    expect({ workspace: f.workspace, concepts: f.concepts, refinement: f.refinement }).toEqual(before);
  });

  it("uses the selected concept attempt instead of an arbitrary recent batch or title treatment", async () => {
    const f = fixture();
    if (f.concepts.stage !== "concepts") throw new Error("Fixture stage");
    const slot = f.batch.slots[0]!;
    f.concepts.payload.selected = { kind: "concept", batchId: f.batch.id, slotId: slot.id, attemptId: slot.attempts[0]!.id };
    expect(await f.read()).toEqual({ name: f.brief.payload.name, receipt: slot.attempts[0]!.preview });
    expect(f.client.readLogoConceptBatch).toHaveBeenCalledExactlyOnceWith(f.batch.id, expect.any(AbortSignal));
    expect(f.client.readLogoRasterRefinement).not.toHaveBeenCalled();
  });

  it("keeps an honest empty fallback for projects before logo work or before a selection", async () => {
    const f = fixture(); f.client.getLogoWorkspace.mockResolvedValue(syntheticLogoWorkspace());
    expect(await f.read()).toEqual({ name: null, receipt: null });
    expect(f.client.getLogoStageRevision).not.toHaveBeenCalled();
    f.client.getLogoWorkspace.mockResolvedValue(f.workspace);
    if (f.concepts.stage !== "concepts") throw new Error("Fixture stage");
    f.concepts.payload.selected = null;
    expect(await f.read()).toEqual({ name: f.brief.payload.name, receipt: null });
    expect(f.client.readLogoRasterRefinement).not.toHaveBeenCalled();
  });

  it.each(["ownerId", "projectId", "id", "revision"] as const)("rejects a stage with mismatched %s before reading private image metadata", async key => {
    const f = fixture();
    Object.assign(f.brief, { [key]: key === "revision" ? 999 : id(999) });
    await expect(f.read()).rejects.toMatchObject({ status: 502 });
    expect(f.client.readLogoRasterRefinement).not.toHaveBeenCalled();
  });

  it("rejects foreign workspace metadata before following its stage pointers", async () => {
    const f = fixture(); f.client.getLogoWorkspace.mockResolvedValue({ ...f.workspace, ownerId: id(999) });
    await expect(f.read()).rejects.toMatchObject({ status: 502 });
    expect(f.client.getLogoStageRevision).not.toHaveBeenCalled();
  });

  it("does not publish a late selected image after the read is aborted", async () => {
    const f = fixture(), controller = new AbortController();
    let finish!: (value: typeof f.refinement) => void;
    f.client.readLogoRasterRefinement.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.read(controller.signal);
    await vi.waitFor(() => expect(f.client.readLogoRasterRefinement).toHaveBeenCalledOnce());
    controller.abort(); finish(f.refinement);
    expect(await pending).toBeNull();
    expect(await f.read(controller.signal)).toBeNull();
    expect(f.client.getLogoWorkspace).toHaveBeenCalledTimes(1);
  });
});
