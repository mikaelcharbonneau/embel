import { describe, expect, it, vi } from "vitest";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { createLogoDraftMemory, type LogoDraftRecord } from "@/components/identity/logo-draft-memory";
import type { LogoMutationReceipt, LogoStageRevision, LogoWorkspaceV2 } from "@/domain/logo-workspace";
import * as actions from "@/features/identity-directions/components/direction-actions";
import { directionFixture, id } from "./fixtures";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(approval = false) {
  const overview = directionFixture(), components = { paletteVersionId: id(20), typographyVersionId: id(31), graphicsVersionId: id(42) };
  const consistency = { hash: "a".repeat(64), status: "pass" as const, checks: [], warnings: [], blockingReasons: [] };
  overview.selection = { id: id(81), ownerId: id(1), projectId: id(2), approvedLogoId: id(3), inputRevisions: [], ...components, sourceDirectionIds: [id(10), id(11), id(12)], consistency };
  const workspace: LogoWorkspaceV2 = { version: 2, ownerId: id(1), projectId: id(2), approvedLogo: overview.currentApprovedLogo,
    heads: { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 3, stageRevisions: { brief_references: 1, concepts: 0, vector: 1, refinements: 0, directions: 1, deliverables: 0 } },
    stages: { brief_references: { stage: "brief_references", id: id(6), revision: 1 }, concepts: null, vector: { stage: "vector", id: id(5), revision: 1 }, refinements: null, directions: { stage: "directions", id: id(8), revision: 1 }, deliverables: null }, staleStages: [],
    capabilities: { save: { status: "available" }, upload: { status: "unavailable", reason: "fixture" }, generate: { status: "unavailable", reason: "fixture" }, convert: { status: "unavailable", reason: "fixture" }, export: { status: "unavailable", reason: "fixture" } } };
  const record: LogoDraftRecord = { workspace, base: workspace.heads, brief: { name: "Fluid", activity: "Design", audience: "Teams", personality: "Clear", logoTypes: ["wordmark"] }, references: [], dirty: false, directionDraft: { approvedLogoId: id(3), ...components, reviewedConsistencyHash: approval ? consistency.hash : null }, pendingCreation: null, pendingIntent: null, pendingExport: null, pendingMutation: null, conflict: false };
  const command = approval ? actions.buildDirectionApprovalCommand(record, overview, id(100)) : actions.buildDirectionSelectionCommand(record, { approvedLogoId: id(3), components, sourceDirectionIds: [id(10), id(11), id(12)], comparisonHash: consistency.hash, consistency }, id(100));
  const revision: LogoStageRevision<"directions"> = { version: 2, id: id(80), ownerId: id(1), projectId: id(2), stage: "directions", revision: 2, parentRevisionId: id(8), inputRevisions: [], inputHash: "a".repeat(64), createdAt: "2026-10-07T00:00:00Z", payload: { directionIds: [id(10), id(11), id(12)], selectionId: id(81), approvalId: approval ? id(82) : null } };
  const saved: LogoWorkspaceV2 = { ...workspace, heads: { ...workspace.heads, workspaceRevision: 4, stageRevisions: { ...workspace.heads.stageRevisions, directions: 2 } }, stages: { ...workspace.stages, directions: { stage: "directions", id: id(80), revision: 2 } } };
  if (approval) overview.approval = { id: id(82), ownerId: id(1), projectId: id(2), approvedLogoId: id(3), directionSelectionId: id(81), consistencyHash: consistency.hash, approvedAt: "2026-10-07T00:00:00Z" };
  const receipt: LogoMutationReceipt = { ownerId: id(1), projectId: id(2), requestKey: id(100), workspace: saved, revision };
  const succeeded = { status: "succeeded" as const, requestKey: id(100), receipt, outputs: [], billing: { status: "recorded" as const, confirmedMicrousd: 0 }, reason: null };
  const memory = createLogoDraftMemory(); memory.bind({ ownerId: id(1), generation: 1 }); memory.set(id(2), record);
  const read = vi.fn(async (): Promise<unknown> => ({ status: "not_found" }));
  const post = vi.fn<(body: actions.DirectionCommand["body"], signal?: AbortSignal) => Promise<LogoMutationReceipt>>(async () => receipt), getWorkspace = vi.fn(async () => saved), getOverview = vi.fn(async () => overview), getStage = vi.fn<(stage: string, revisionId: string, signal?: AbortSignal) => Promise<LogoStageRevision<"directions">>>(async () => revision);
  const client = { readLogoRequest: read, selectIdentityDirectionComponents: post, approveIdentityDirection: post, getLogoWorkspace: getWorkspace, getIdentityDirections: getOverview, getLogoStageRevision: getStage } as unknown as AccountLogoClient;
  let active = true; const controller = new AbortController();
  const context = { memory, client, projectId: id(2), current: () => active, signal: controller.signal };
  const retain = () => memory.set(id(2), { ...memory.get(id(2))!, pendingMutation: { requestKey: id(100), command } });
  return { context, memory, command, record, receipt, overview, revision, saved, succeeded, read, post, getWorkspace, getOverview, getStage, controller, retain, expire: () => { active = false; } };
}

describe("explicit retained direction request recovery", () => {
  it.each([false, true])("lost precommit retries the exact %s command and original heads after a fresh read", async approval => {
    const f = fixture(approval); f.post.mockRejectedValueOnce(new Error("lost before commit"));
    await expect(actions.dispatchDirectionCommand(f.context, f.command)).rejects.toThrow("lost before commit");
    const retained = f.memory.get(id(2))!.pendingMutation;
    await actions.replayDirectionCommand(f.context);
    expect(f.read).toHaveBeenCalledWith(id(100), f.context.signal);
    expect(f.post).toHaveBeenCalledTimes(2); expect(f.post.mock.calls.map(call => call[0])).toEqual([f.command.body, f.command.body]);
    expect(retained?.command).toEqual(f.command); expect(f.memory.get(id(2))!.pendingMutation).toBeNull(); expect(f.memory.get(id(2))!.base).toEqual(f.saved.heads);
  });
  it.each([false, true])("lost acknowledgement recovers %s without any POST", async approval => {
    const f = fixture(approval); f.retain(); f.read.mockResolvedValue(f.succeeded);
    await actions.replayDirectionCommand(f.context);
    expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))!.pendingMutation).toBeNull();
  });
  it("checking a missing request remains read-only and retains the command", async () => {
    const f = fixture(); f.retain(); await actions.reconcileDirectionCommand(f.context);
    expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))!.pendingMutation?.command).toEqual(f.command);
  });
  it.each([null, {}, { status: "not_found", requestKey: id(999) }, { status: "mystery" }, { status: "succeeded", receipt: null }, { status: "needs_reconciliation", requestKey: id(100), receipt: null, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: "uncertain" }])("never resends an unavailable, malformed or uncertain lookup: %j", async state => {
    const f = fixture(); f.retain(); f.read.mockResolvedValue(state);
    await actions.replayDirectionCommand(f.context).catch(() => null);
    expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))!.pendingMutation?.command).toEqual(f.command);
  });
  it("lookup errors leave the original command intact", async () => {
    const f = fixture(); f.retain(); f.read.mockRejectedValue(new Error("offline"));
    await expect(actions.replayDirectionCommand(f.context)).rejects.toThrow(); expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))!.pendingMutation).not.toBeNull();
  });
  it.each(["request", "owner", "project"])("rejects a succeeded receipt with a foreign %s", async field => {
    const f = fixture(); f.retain(); const state = structuredClone(f.succeeded);
    if (field === "request") state.requestKey = id(999); else if (field === "owner") state.receipt.ownerId = id(999); else state.receipt.projectId = id(999);
    f.read.mockResolvedValue(state); await actions.replayDirectionCommand(f.context).catch(() => null);
    expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))!.pendingMutation).not.toBeNull();
  });
  it.each(["session", "unmount", "owner", "body"])("fences %s changes while lookup is pending", async change => {
    const f = fixture(); f.retain(); const pending = deferred<unknown>(); f.read.mockReturnValue(pending.promise); const running = actions.replayDirectionCommand(f.context);
    if (change === "session") f.expire(); else if (change === "unmount") f.controller.abort(); else if (change === "owner") f.memory.bind({ ownerId: id(999), generation: 2 }); else { const value = f.memory.get(id(2))!, changedCommand = structuredClone(f.command); changedCommand.body.requestKey = id(101); f.memory.set(id(2), { ...value, pendingMutation: null }); f.memory.set(id(2), { ...value, pendingMutation: { requestKey: id(101), command: changedCommand } }); }
    pending.resolve({ status: "not_found" }); await running; expect(f.post).not.toHaveBeenCalled();
  });
  it("double click shares one recovery transition", async () => {
    const f = fixture(); f.retain(); const pending = deferred<unknown>(); f.read.mockReturnValue(pending.promise);
    const first = actions.replayDirectionCommand(f.context), second = actions.replayDirectionCommand(f.context);
    pending.resolve({ status: "not_found" }); await Promise.all([first, second]);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.post).toHaveBeenCalledTimes(1); expect(f.memory.get(id(2))!.pendingMutation).toBeNull();
  });
  it("historical success reads current heads without rolling back or erasing newer drafts", async () => {
    const f = fixture(); f.retain(); f.read.mockResolvedValue(f.succeeded);
    const later = structuredClone(f.saved); later.heads.workspaceRevision++; later.heads.stageRevisions.directions++; later.stages.directions = { stage: "directions", id: id(90), revision: 3 };
    const laterRevision = { ...f.revision, id: id(90), revision: 3, parentRevisionId: id(80), payload: { ...f.revision.payload, selectionId: id(91) } };
    const overview = structuredClone(f.overview); overview.selection!.id = id(91); overview.selection!.paletteVersionId = id(21);
    f.getWorkspace.mockResolvedValue(later); f.getOverview.mockResolvedValue(overview); f.getStage.mockImplementation(async (_stage, revisionId) => revisionId === id(80) ? f.revision : laterRevision);
    const value = f.memory.get(id(2))!, newerDraft = { ...value.directionDraft!, typographyVersionId: id(32) };
    f.memory.set(id(2), { ...value, directionDraft: newerDraft, brief: { ...value.brief, audience: "New local draft" }, dirty: true });
    expect(await actions.reconcileDirectionCommand(f.context)).toEqual(overview);
    expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))).toMatchObject({ pendingMutation: null, base: later.heads, directionDraft: newerDraft, dirty: true, conflict: true, brief: { audience: "New local draft" } });
    expect(f.getStage).toHaveBeenCalledWith("directions", id(80), f.context.signal);
  });
  it("an aborted old lookup cannot lock a remounted recovery or settle it later", async () => {
    const f = fixture(); f.retain(); const old = deferred<unknown>(); f.read.mockReturnValueOnce(old.promise);
    const abandoned = actions.replayDirectionCommand(f.context); f.controller.abort();
    const recovered = actions.replayDirectionCommand({ ...f.context, signal: new AbortController().signal });
    await recovered; expect(f.post).toHaveBeenCalledTimes(1); expect(f.memory.get(id(2))!.pendingMutation).toBeNull();
    old.resolve(f.succeeded); await abandoned; expect(f.post).toHaveBeenCalledTimes(1);
  });
  it("a success with uncertain billing is not accepted as a verified manual result", async () => {
    const f = fixture(); f.retain(); f.read.mockResolvedValue({ ...f.succeeded, billing: { status: "unknown", confirmedMicrousd: null } });
    await actions.replayDirectionCommand(f.context).catch(() => null);
    expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))!.pendingMutation).not.toBeNull();
  });
  it("a changed immutable stage readback leaves the receipt unresolved", async () => {
    const f = fixture(); f.retain(); f.read.mockResolvedValue(f.succeeded);
    f.getStage.mockResolvedValue({ ...f.revision, inputHash: "b".repeat(64) });
    await expect(actions.replayDirectionCommand(f.context)).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled(); expect(f.memory.get(id(2))!.pendingMutation).not.toBeNull();
  });
  it("arrival of the original POST after a missing lookup uses one exact-key server transition", async () => {
    const f = fixture(); let savedBody: unknown = null, transitions = 0;
    const commit = (body: actions.DirectionCommand["body"]) => { if (!savedBody) { savedBody = structuredClone(body); transitions++; } else expect(body).toEqual(savedBody); return f.receipt; };
    f.post.mockImplementationOnce(async () => { throw new Error("original still in flight"); }).mockImplementation(async body => commit(body));
    await expect(actions.dispatchDirectionCommand(f.context, f.command)).rejects.toThrow();
    f.read.mockImplementationOnce(async () => { const observed = { status: "not_found" }; commit(f.command.body); return observed; });
    let settled = 0; const unsubscribe = f.memory.subscribe(() => { if (!f.memory.get(id(2))?.pendingMutation) settled++; });
    await actions.replayDirectionCommand(f.context); unsubscribe();
    expect(transitions).toBe(1); expect(settled).toBe(1); expect(f.post.mock.calls[1]![0]).toEqual(f.command.body);
  });
  it("keeps drafts edited during successful receipt validation", async () => {
    const f = fixture(); f.retain(); f.read.mockResolvedValue(f.succeeded); const readback = deferred<LogoStageRevision<"directions">>(); f.getStage.mockReturnValue(readback.promise);
    const running = actions.reconcileDirectionCommand(f.context); await Promise.resolve();
    const value = f.memory.get(id(2))!, draft = { ...value.directionDraft!, typographyVersionId: id(32) };
    f.memory.set(id(2), { ...value, directionDraft: draft }); readback.resolve(f.revision); await running;
    expect(f.memory.get(id(2))).toMatchObject({ pendingMutation: null, directionDraft: draft });
  });
  it("does not rebase an unrelated retained generation while clearing this successful request", async () => {
    const f = fixture(); f.retain(); f.read.mockResolvedValue(f.succeeded); const value = f.memory.get(id(2))!;
    const pendingIntent = { requestKey: id(101), quoteId: id(102), acceptedMaxCostMicrousd: 0, expected: value.base! };
    f.memory.set(id(2), { ...value, pendingIntent }); await actions.reconcileDirectionCommand(f.context);
    expect(f.memory.get(id(2))).toMatchObject({ pendingMutation: null, base: value.base, pendingIntent, conflict: true });
  });
});
