import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../../src/components/identity/logo-draft-memory";
import { cancelVectorMutation, recoverVectorCancellation } from "../../../src/features/logo-vector/client/cancellation";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../../fixtures/logo-creation";
import type { LogoManualCommand, LogoMutationReceipt, LogoWorkspaceV2 } from "../../../src/domain/logo-workspace";
function fixture() {
  const workspace = syntheticLogoWorkspace(), projectId = workspace.projectId, account = { status: "ready" as const, userId: workspace.ownerId, generation: 1 };
  const command: Extract<LogoManualCommand, { method: "saveLogoEdit" }> = { method: "saveLogoEdit", body: { requestKey: id(810), expected: workspace.heads, baseVectorRevisionId: id(811), edit: { kind: "text", componentId: "lettering", text: "Keep my draft" } } };
  const memory = createLogoDraftMemory(); memory.bind({ ownerId: account.userId, generation: account.generation });
  memory.set(projectId, { workspace, base: workspace.heads, brief: { name: "Newer unsaved brief", activity: "", audience: "", personality: "", logoTypes: ["wordmark"] }, references: [], dirty: true, conflict: false, pendingMutation: { requestKey: command.body.requestKey, command }, pendingIntent: null, pendingCreation: null, pendingExport: null,
    vectorDraft: { baseVectorRevisionId: command.body.baseVectorRevisionId, edit: command.body.edit } });
  const proof = { status: "cancelled", ownerId: workspace.ownerId, projectId, requestKey: command.body.requestKey, command };
  let current = true, state: unknown = proof, status = 200, lost = false, afterSend: (() => void) | null = null, success: LogoMutationReceipt | null = null, remote: LogoWorkspaceV2 = workspace;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const client = createAccountLogoClient(account, projectId, () => current, () => { current = false; }, async (url, options) => {
    const path = String(url); calls.push({ path, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : null });
    afterSend?.(); afterSend = null;
    if (lost) throw Error("Lost cancellation acknowledgement");
    if (status !== 200) return new Response(null, { status });
    if (path.includes("/edits/requests/")) return Response.json(state);
    if (path.includes("/requests/")) return Response.json(success ? { status: "succeeded", requestKey: success.requestKey, receipt: success, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null } : { status: "not_found" });
    return Response.json(remote);
  });
  return { command, proof, memory, projectId, calls, options: { account, client, memory, projectId, isCurrent: () => current },
    state(value: unknown) { state = value; }, fail(code: number) { status = code; }, lose() { lost = true; }, recover() { lost = false; }, onSend(run: () => void) { afterSend = run; }, foreign() { current = false; },
    succeeded() {
      remote = { ...workspace, heads: { ...workspace.heads, workspaceRevision: workspace.heads.workspaceRevision + 1, stageRevisions: { ...workspace.heads.stageRevisions, refinements: workspace.heads.stageRevisions.refinements + 1 } }, stages: { ...workspace.stages, refinements: { stage: "refinements", id: id(812), revision: workspace.heads.stageRevisions.refinements + 1 } } };
      success = { ownerId: account.userId, projectId, requestKey: command.body.requestKey, workspace: remote, revision: { version: 2, id: id(812), ownerId: account.userId, projectId, stage: "refinements", revision: workspace.heads.stageRevisions.refinements + 1, parentRevisionId: null, inputRevisions: [], inputHash: "a".repeat(64), createdAt: "2026-10-07T00:00:00Z", payload: { rasterRevisionIds: [], vectorRevisionId: id(813), approvalId: null, sourceRequestKey: command.body.requestKey } } };
      state = { ...proof, status: "succeeded", receipt: success };
    },
  };
}
describe("explicit vector edit cancellation in owner memory", () => {
  it("releases only the original pending request on exact proof while preserving the entire unsaved draft", async () => {
    const f = fixture(), before = f.memory.get(f.projectId)!;
    expect(await cancelVectorMutation(f.options)).toEqual(f.proof);
    expect(f.memory.get(f.projectId)).toEqual({ ...before, pendingMutation: null });
    expect(f.calls).toEqual([{ path: `/api/projects/${f.projectId}/logo/edits/requests/${f.command.body.requestKey}/cancel`, method: "POST", body: f.command }]);
  });
  it("lost acknowledgement leaves the original pending until a read proves cancellation without another POST", async () => {
    const f = fixture(); f.lose(); await expect(cancelVectorMutation(f.options)).rejects.toThrow();
    expect(f.memory.get(f.projectId)?.pendingMutation?.command).toEqual(f.command); f.recover();
    expect(await recoverVectorCancellation(f.options)).toEqual(f.proof);
    expect(f.calls.map(call => call.method)).toEqual(["POST", "GET"]); expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull(); expect(f.memory.get(f.projectId)?.vectorDraft).toBeTruthy();
  });
  it("not_found and generic HTTP errors can never release an unresolved original", async () => {
    const f = fixture(); f.state({ status: "not_found" }); expect(await recoverVectorCancellation(f.options)).toBeNull();
    await expect(cancelVectorMutation(f.options)).rejects.toThrow(); expect(f.memory.get(f.projectId)?.pendingMutation?.command).toEqual(f.command);
    for (const status of [404, 409, 422, 503]) { f.fail(status); await expect(cancelVectorMutation(f.options)).rejects.toThrow(); expect(f.memory.get(f.projectId)?.pendingMutation?.command).toEqual(f.command); }
  });
  it("rejects mismatched command proofs without releasing local work", async () => {
    const f = fixture(); f.state({ ...f.proof, command: { ...f.command, body: { ...f.command.body, edit: { kind: "text", componentId: "lettering", text: "Other" } } } });
    await expect(cancelVectorMutation(f.options)).rejects.toThrow(); await expect(recoverVectorCancellation(f.options)).rejects.toThrow();
    expect(f.memory.get(f.projectId)?.pendingMutation?.command).toEqual(f.command);
  });
  it("preserves edits made while cancellation is in flight", async () => {
    const f = fixture(), newer = { baseVectorRevisionId: id(811), edit: { kind: "text" as const, componentId: "lettering", text: "Newer draft" } };
    f.onSend(() => f.memory.set(f.projectId, { ...f.memory.get(f.projectId)!, vectorDraft: newer }));
    await cancelVectorMutation(f.options); expect(f.memory.get(f.projectId)?.vectorDraft).toEqual(newer); expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull();
  });
  it("ignores an old proof if another continuation already replaced the retained request", async () => {
    const f = fixture(), newer = { ...f.command, body: { ...f.command.body, requestKey: id(814) } };
    f.onSend(() => { const latest = f.memory.get(f.projectId)!; f.memory.set(f.projectId, { ...latest, pendingMutation: null }); f.memory.set(f.projectId, { ...latest, pendingMutation: { requestKey: newer.body.requestKey, command: newer } }); });
    expect(await cancelVectorMutation(f.options)).toBeNull(); expect(f.memory.get(f.projectId)?.pendingMutation?.command).toEqual(newer);
  });
  it("never follows a late response into a foreign account or reads after the account changed", async () => {
    const f = fixture(); f.onSend(() => f.foreign()); expect(await cancelVectorMutation(f.options)).toBeNull(); expect(f.memory.get(f.projectId)?.pendingMutation?.command).toEqual(f.command);
    expect(await recoverVectorCancellation(f.options)).toBeNull(); expect(f.calls).toHaveLength(1);
  });
  it("recovers an already successful exact edit through current heads rather than claiming cancellation", async () => {
    const f = fixture(); f.succeeded(); expect(await cancelVectorMutation(f.options)).toMatchObject({ status: "succeeded" });
    expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull(); expect(f.calls.map(call => call.method)).toEqual(["POST", "GET", "GET"]);
    expect(f.memory.get(f.projectId)?.brief.name).toBe("Newer unsaved brief");
  });
});
