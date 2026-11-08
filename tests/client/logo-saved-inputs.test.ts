/** Synthetic account reads and acknowledged saves; no provider calls. */
import { describe, expect, it, vi } from "vitest";
import { prepareSavedLogoConcepts } from "../../src/components/logo-creation/saved-inputs-controller";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { DEFAULT_LOGO_CONCEPT_TYPES, logoInspirationHeading, logoSavedInputsSchema, type LogoSavedInputs } from "../../src/domain/logo-saved-inputs";
import type { LogoBriefDraft, LogoBriefRevision, LogoReferenceSelection } from "../../src/domain/logo-workspace";
import { syntheticLogoBrief, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";

function setup(existing = false) {
  const fixture = syntheticResolvedLogoConcept(), initial = syntheticLogoWorkspace();
  const workspace = { ...initial, capabilities: { ...initial.capabilities, save: { status: "available" as const } },
    ...(existing ? { heads: { ...initial.heads, workspaceRevision: 1, referenceRevision: 1, stageRevisions: { ...initial.heads.stageRevisions, brief_references: 1 } },
      stages: { ...initial.stages, brief_references: { stage: "brief_references" as const, id: fixture.brief.id, revision: 1 } } } : {}) };
  const memory = createLogoDraftMemory(), ownerId = workspace.ownerId, projectId = workspace.projectId;
  memory.bind({ ownerId, generation: 1 });
  const oldBrief = syntheticLogoBrief({ name: "My custom exact name" });
  memory.set(projectId, { workspace, base: workspace.heads, brief: existing ? oldBrief : { name: "", activity: "", audience: "", personality: "", logoTypes: [] },
    references: [], dirty: false, conflict: false, pendingMutation: null, pendingIntent: null, pendingCreation: null, pendingExport: null });
  let source: LogoSavedInputs = logoSavedInputsSchema.parse({ ownerId, projectId, projectRevision: 1, inspirationSelectionRevision: 2,
    draft: syntheticLogoBrief({ logoTypes: DEFAULT_LOGO_CONCEPT_TYPES, personality: "Calm\nSaved inspiration: fixture creator — selected typography and shape." }), nameConflict: false, inspirationCount: 2, references: [] });
  let revision: LogoBriefRevision = { ...fixture.brief, payload: { ...fixture.brief.payload, ...oldBrief } };
  let current = true, uncertainSave = false, readGate: Promise<void> | null = null, savedGate: Promise<void> | null = null;
  const saves: LogoBriefDraft[] = [], progress: string[] = [];
  const readSavedInputs = vi.fn(async () => { if (readGate) await readGate; return source; });
  const readBriefRevision = vi.fn(async () => revision);
  const saveBrief = vi.fn(async (brief: LogoBriefDraft) => {
    saves.push(brief);
    const previous = memory.get(projectId)!;
    memory.set(projectId, { ...previous, brief, dirty: true, pendingMutation: { requestKey: id(950), command: { method: "saveLogoBrief", body: { requestKey: id(950), expected: previous.base!, brief } } } });
    if (savedGate) await savedGate;
    if (uncertainSave) return;
    const number = previous.workspace!.heads.stageRevisions.brief_references + 1;
    revision = { ...fixture.brief, id: id(960 + number), revision: number, parentRevisionId: previous.workspace!.stages.brief_references?.id ?? null,
      payload: { ...fixture.brief.payload, ...brief } };
    const nextWorkspace = { ...previous.workspace!, heads: { ...previous.workspace!.heads, referenceRevision: Math.max(1, previous.workspace!.heads.referenceRevision), workspaceRevision: previous.workspace!.heads.workspaceRevision + 1,
      stageRevisions: { ...previous.workspace!.heads.stageRevisions, brief_references: number } },
      stages: { ...previous.workspace!.stages, brief_references: { stage: "brief_references" as const, id: revision.id, revision: number } } };
    memory.set(projectId, { ...memory.get(projectId)!, workspace: nextWorkspace, base: nextWorkspace.heads, brief, dirty: false, pendingMutation: null });
  });
  // Saving references keeps the brief and advances the same stage, like the real command.
  const referenceSaves: LogoReferenceSelection[][] = [];
  const saveReferences = vi.fn(async (selections: LogoReferenceSelection[]) => {
    referenceSaves.push(selections);
    const previous = memory.get(projectId)!, number = previous.workspace!.heads.stageRevisions.brief_references + 1;
    revision = { ...revision, id: id(980 + number), revision: number, parentRevisionId: previous.workspace!.stages.brief_references?.id ?? null, payload: { ...revision.payload, referenceSnapshotId: id(990 + number) } };
    const nextWorkspace = { ...previous.workspace!, heads: { ...previous.workspace!.heads, workspaceRevision: previous.workspace!.heads.workspaceRevision + 1,
      stageRevisions: { ...previous.workspace!.heads.stageRevisions, brief_references: number } },
      stages: { ...previous.workspace!.stages, brief_references: { stage: "brief_references" as const, id: revision.id, revision: number } } };
    memory.set(projectId, { ...previous, workspace: nextWorkspace, base: nextWorkspace.heads, references: selections, dirty: false, pendingMutation: null });
  });
  const controller = new AbortController();
  const run = () => prepareSavedLogoConcepts({ ownerId, projectId, signal: controller.signal, isCurrent: () => current,
    getDraft: () => memory.get(projectId), readSavedInputs, saveBrief, saveReferences, readBriefRevision, onProgress: phase => progress.push(phase) });
  const check = () => prepareSavedLogoConcepts({ ownerId, projectId, signal: controller.signal, isCurrent: () => current, checkOnly: true,
    getDraft: () => memory.get(projectId), readSavedInputs, saveBrief, saveReferences, readBriefRevision, onProgress: phase => progress.push(phase) });
  return { run, check, memory, projectId, ownerId, saves, referenceSaves, progress, readSavedInputs, readBriefRevision, get source() { return source; }, get revision() { return revision; },
    updateSource(change: Partial<LogoSavedInputs>) { source = { ...source, ...change }; },
    /** Changes the saved brief as if it had been saved with these details. */
    editSavedBrief(change: Partial<LogoBriefDraft>) {
      revision = { ...revision, payload: { ...revision.payload, ...change } };
      const value = memory.get(projectId)!; memory.set(projectId, { ...value, brief: { ...value.brief, ...change } });
    },
    /** The brand is saved again after the logo brief. */
    advanceProject() {
      const value = memory.get(projectId)!, heads = { ...value.workspace!.heads, projectRevision: 2 };
      memory.set(projectId, { ...value, workspace: { ...value.workspace!, heads }, base: heads }); source = { ...source, projectRevision: 2 };
    },
    saveUnavailable() { const value = memory.get(projectId)!; memory.set(projectId, { ...value, workspace: { ...value.workspace!, capabilities: { ...value.workspace!.capabilities, save: { status: "unavailable", reason: "Fixture unavailable" } } } }); },
    loseSave() { uncertainSave = true; },
    holdRead() { let release!: () => void; readGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    holdSave() { let release!: () => void; savedGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    edit() { const value = memory.get(projectId)!; memory.set(projectId, { ...value, dirty: true, brief: { ...value.brief, name: "Keep my edit" } }); },
    changeAccount() { current = false; memory.bind({ ownerId: id(999), generation: 2 }); },
  };
}

describe("saved brand and inspiration preparation", () => {
  it("saves the authoritative six-type brief and only returns a quote after the exact revision is acknowledged", async () => {
    const f = setup(), release = f.holdSave();
    const preparing = f.run();
    await vi.waitFor(() => expect(f.saves).toHaveLength(1));
    expect(f.readBriefRevision).not.toHaveBeenCalled();
    expect(f.memory.get(f.projectId)?.pendingMutation).not.toBeNull();
    release();
    const result = await preparing;
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("Expected prepared inputs");
    expect(result.request).toEqual({ operation: "concepts", expected: f.memory.get(f.projectId)!.workspace!.heads, briefRevisionId: f.revision.id, referenceSnapshotId: f.revision.payload.referenceSnapshotId });
    expect(f.saves[0]).toEqual(f.source.draft);
    expect(f.saves[0]?.logoTypes).toHaveLength(6);
    expect(f.progress).toEqual(["reading", "saving"]);
    expect(f.memory.get(f.projectId)?.dirty).toBe(false);
  });
  it("attaches liked uploaded images as whole-image references after the brief, and quotes the final revision", async () => {
    const f = setup(), liked = [{ referenceId: id(701), aspects: ["overall_feel" as const] }, { referenceId: id(702), aspects: ["overall_feel" as const] }];
    f.updateSource({ references: liked });
    const result = await f.run();
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("Expected prepared inputs");
    expect(f.saves).toHaveLength(1); expect(f.referenceSaves).toEqual([liked]);
    const saved = f.memory.get(f.projectId)!;
    expect(saved.references).toEqual(liked); expect(saved.workspace!.heads.stageRevisions.brief_references).toBe(2);
    expect(result.request).toEqual({ operation: "concepts", expected: saved.workspace!.heads, briefRevisionId: f.revision.id, referenceSnapshotId: f.revision.payload.referenceSnapshotId });
    // Nothing changed: no further saves. Unliking every image clears the references.
    expect(await f.run()).toMatchObject({ status: "prepared" }); expect(f.referenceSaves).toHaveLength(1);
    f.updateSource({ references: [] });
    expect(await f.run()).toMatchObject({ status: "prepared" }); expect(f.referenceSaves).toEqual([liked, []]); expect(f.saves).toHaveLength(1);
  });
  it("only compares in check mode: newer likes or liked images are reported, nothing is saved", async () => {
    const f = setup(true);
    expect(await f.check()).toMatchObject({ status: "checked", outdated: true });
    f.editSavedBrief({ personality: `Warm\n${logoInspirationHeading("2026-10-13.1", 2)}` });
    expect(await f.check()).toMatchObject({ status: "checked", outdated: false });
    f.updateSource({ references: [{ referenceId: id(701), aspects: ["overall_feel"] }] });
    expect(await f.check()).toMatchObject({ status: "checked", outdated: true });
    expect(f.saves).toEqual([]); expect(f.referenceSaves).toEqual([]);
  });
  it("reads saved source even when saving is unavailable, then reports the blocker without writing", async () => {
    const f = setup(); f.saveUnavailable(); const result = await f.run();
    expect(result).toMatchObject({ status: "blocked", source: f.source, message: expect.stringContaining("Logo saving is unavailable") });
    expect(f.readSavedInputs).toHaveBeenCalledOnce(); expect(f.saves).toHaveLength(0);
  });
  it("blocks a missing saved name without inventing one or saving a brief", async () => {
    const f = setup(); f.updateSource({ draft: null });
    expect(await f.run()).toMatchObject({ status: "blocked", message: expect.stringContaining("Choose and save a brand name") });
    expect(f.saves).toHaveLength(0);
  });
  it("uses the name chosen in the project without asking when it differs from the name first supplied", async () => {
    const f = setup(); f.updateSource({ nameConflict: true });
    expect(await f.run()).toMatchObject({ status: "prepared", used: "brand" });
    expect(f.saves).toEqual([f.source.draft]);
  });
  it("updates a brief made before the latest inspiration without asking, keeping its chosen logo types", async () => {
    const f = setup(true);
    expect(await f.run()).toMatchObject({ status: "prepared", used: "brand" });
    expect(f.saves).toEqual([{ ...f.source.draft, logoTypes: ["wordmark"] }]);
    expect(f.memory.get(f.projectId)?.workspace?.heads.stageRevisions.brief_references).toBe(2);
  });
  it("updates a brief saved before the latest brand change without asking", async () => {
    const f = setup(true); f.editSavedBrief({ personality: `Warm\n${logoInspirationHeading("2026-10-13.1", 2)}` }); f.advanceProject();
    expect(await f.run()).toMatchObject({ status: "prepared", used: "brand" });
    expect(f.saves).toHaveLength(1); expect(f.saves[0]?.name).toBe(f.source.draft?.name);
  });
  it("keeps a brief edited by hand after the latest brand and inspiration", async () => {
    const f = setup(true); f.editSavedBrief({ personality: `Warm\n${logoInspirationHeading("2026-10-13.1", 2)}` });
    expect(await f.run()).toMatchObject({ status: "prepared", used: "current" });
    expect(f.saves).toHaveLength(0); expect(f.memory.get(f.projectId)?.brief.name).toBe("My custom exact name");
  });
  it("keeps an existing logo brief when the project has no saved name", async () => {
    const f = setup(true); f.updateSource({ draft: null });
    expect(await f.run()).toMatchObject({ status: "prepared", used: "current" });
    expect(f.saves).toHaveLength(0);
  });
  it("does not create another brief revision when the saved inputs are already identical", async () => {
    const f = setup(); expect(await f.run()).toMatchObject({ status: "prepared" });
    expect(await f.run()).toMatchObject({ status: "prepared" }); expect(f.saves).toHaveLength(1);
  });
  it("retains an uncertain save and never reads a new quote basis or sends another save", async () => {
    const f = setup(); f.loseSave();
    expect(await f.run()).toMatchObject({ status: "blocked", message: expect.stringContaining("confirm your logo brief was saved") });
    const retained = f.memory.get(f.projectId);
    expect(retained?.pendingMutation).not.toBeNull(); expect(f.readBriefRevision).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ status: "blocked" });
    expect(f.memory.get(f.projectId)).toBe(retained); expect(f.saves).toHaveLength(1);
  });
  it("preserves edits entered while saved inputs are loading", async () => {
    const f = setup(), release = f.holdRead(), result = f.run(); f.edit(); const retained = f.memory.get(f.projectId); release();
    expect(await result).toMatchObject({ status: "blocked" }); expect(f.memory.get(f.projectId)).toBe(retained); expect(f.saves).toHaveLength(0);
  });
  it("does not save or expose a delayed response after an account change", async () => {
    const f = setup(), release = f.holdRead(), result = f.run(); f.changeAccount(); release();
    expect(await result).toEqual({ status: "obsolete" }); expect(f.saves).toHaveLength(0); expect(f.memory.get(f.projectId)).toBeNull();
  });
  it("blocks stale project revisions before saving", async () => {
    const f = setup(); f.updateSource({ projectRevision: 2 });
    expect(await f.run()).toMatchObject({ status: "blocked", message: expect.stringContaining("changed") }); expect(f.saves).toHaveLength(0);
  });
});

describe("saved logo inputs transport", () => {
  it("uses the fixed bounded account route and rejects foreign inputs", async () => {
    const f = setup(), seen: string[] = [];
    let response = f.source;
    const client = createAccountLogoClient({ status: "ready", userId: f.ownerId, generation: 1 }, f.projectId, () => true, vi.fn(), async (path, init) => {
      seen.push(String(path)); expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error" }); return Response.json(response);
    });
    expect(await client.readLogoSavedInputs()).toEqual(f.source);
    expect(seen).toEqual([`/api/projects/${f.projectId}/logo/saved-inputs`]);
    response = { ...response, ownerId: id(998) };
    await expect(client.readLogoSavedInputs()).rejects.toMatchObject({ status: 502 });
  });
});
