/** Synthetic account reads and acknowledged saves; no provider calls. */
import { describe, expect, it, vi } from "vitest";
import { prepareSavedLogoConcepts, type LogoSavedInputChoice } from "../../src/components/logo-creation/saved-inputs-controller";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { DEFAULT_LOGO_CONCEPT_TYPES, logoSavedInputsSchema, type LogoSavedInputs } from "../../src/domain/logo-saved-inputs";
import type { LogoBriefDraft, LogoBriefRevision } from "../../src/domain/logo-workspace";
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
    draft: syntheticLogoBrief({ logoTypes: DEFAULT_LOGO_CONCEPT_TYPES, personality: "Calm\nSaved inspiration: fixture creator — selected typography and shape." }), nameConflict: false, inspirationCount: 2 });
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
  const controller = new AbortController();
  const run = (choice?: LogoSavedInputChoice) => prepareSavedLogoConcepts({ ownerId, projectId, signal: controller.signal, isCurrent: () => current,
    getDraft: () => memory.get(projectId), readSavedInputs, saveBrief, readBriefRevision, onProgress: phase => progress.push(phase) }, choice);
  return { run, memory, projectId, ownerId, saves, progress, readSavedInputs, readBriefRevision, get source() { return source; }, get revision() { return revision; },
    updateSource(change: Partial<LogoSavedInputs>) { source = { ...source, ...change }; },
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
  it("requires an explicit name choice and revalidates the source before saving", async () => {
    const f = setup(); f.updateSource({ nameConflict: true }); const result = await f.run();
    expect(result.status).toBe("review"); expect(f.saves).toHaveLength(0);
    if (result.status !== "review") throw new Error("Expected name review");
    expect(await f.run({ review: result.review, use: "brand" })).toMatchObject({ status: "prepared", used: "brand" });
    expect(f.readSavedInputs).toHaveBeenCalledTimes(2); expect(f.saves).toHaveLength(1);
  });
  it("requires a fresh review when saved inspiration changes while a choice is shown", async () => {
    const f = setup(); f.updateSource({ nameConflict: true }); const result = await f.run();
    if (result.status !== "review") throw new Error("Expected name review");
    f.updateSource({ inspirationSelectionRevision: 3 });
    expect(await f.run({ review: result.review, use: "brand" })).toMatchObject({ status: "review", review: { source: { inspirationSelectionRevision: 3 } } });
    expect(f.saves).toHaveLength(0);
  });
  it("keeps a custom saved brief until the user chooses which context to use", async () => {
    const f = setup(true), before = f.memory.get(f.projectId); const result = await f.run();
    expect(result.status).toBe("review"); expect(f.memory.get(f.projectId)).toBe(before);
    if (result.status !== "review") throw new Error("Expected context review");
    expect(await f.run({ review: result.review, use: "current" })).toMatchObject({ status: "prepared", used: "current" });
    expect(f.saves).toHaveLength(0); expect(f.memory.get(f.projectId)?.brief.name).toBe("My custom exact name");
  });
  it("replaces a clean saved brief only after the explicit update choice", async () => {
    const f = setup(true), result = await f.run();
    if (result.status !== "review") throw new Error("Expected context review");
    expect(await f.run({ review: result.review, use: "brand" })).toMatchObject({ status: "prepared", used: "brand" });
    expect(f.saves).toHaveLength(1); expect(f.memory.get(f.projectId)?.workspace?.heads.stageRevisions.brief_references).toBe(2);
  });
  it("lets the user explicitly keep a valid existing logo brief when the project has no saved name", async () => {
    const f = setup(true); f.updateSource({ draft: null }); const result = await f.run();
    if (result.status !== "review") throw new Error("Expected existing brief review");
    expect(await f.run({ review: result.review, use: "current" })).toMatchObject({ status: "prepared", used: "current" });
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
