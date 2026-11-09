import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../../src/components/identity/logo-draft-memory";
import { createVectorRecoveryIntent, submitVectorIntent, recoverVectorMutation } from "../../../src/features/logo-vector/client/recovery";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../../fixtures/logo-creation";
import type { LogoMutationReceipt, LogoWorkspaceV2 } from "../../../src/domain/logo-workspace";

function fixture() {
  const original = syntheticLogoWorkspace(), workspace: LogoWorkspaceV2 = { ...original, capabilities: { ...original.capabilities, save: { status: "available" } } };
  const memory = createLogoDraftMemory(), account = { status: "ready" as const, userId: workspace.ownerId, generation: 1 }, projectId = workspace.projectId;
  memory.bind({ ownerId: account.userId, generation: account.generation }); memory.set(projectId, { workspace, base: workspace.heads, brief: { name: "Synthetic", activity: "", audience: "", personality: "", logoTypes: ["wordmark"] }, references: [], dirty: false, conflict: false, pendingMutation: null, pendingIntent: null, pendingExport: null,
    vectorDraft: { baseVectorRevisionId: id(80), edit: { kind: "rotation", componentId: "symbol", degrees: 15 } } });
  let current = true, lose = false, commit = true, conflict = false, receipt: LogoMutationReceipt | null = null, remote = workspace;
  const requests: { path: string; body: unknown }[] = [];
  const client = createAccountLogoClient(account, projectId, () => current, () => { current = false; }, async (url, options) => {
    const path = String(url);
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)); requests.push({ path, body });
      if (conflict) return new Response(null, { status: 409 });
      const stage = path.endsWith("/edits") ? "refinements" : "vector", revision = body.expected.stageRevisions[stage] + 1;
      remote = { ...workspace, heads: { ...workspace.heads, workspaceRevision: body.expected.workspaceRevision + 1, stageRevisions: { ...workspace.heads.stageRevisions, [stage]: revision } }, stages: { ...workspace.stages, [stage]: { stage, id: id(84), revision } } };
      if (path.endsWith("/vector/accept")) remote.approvedLogo = { id: id(85), ownerId: account.userId, projectId, vectorRevisionId: body.vectorRevisionId, stageRevisionId: id(84), approvedAt: "2026-10-07T00:00:00Z" };
      const base = { version: 2 as const, id: id(84), ownerId: account.userId, projectId, revision, parentRevisionId: null, inputRevisions: [], inputHash: "a".repeat(64), createdAt: "2026-10-07T00:00:00Z" };
      receipt = { ownerId: account.userId, projectId, requestKey: body.requestKey, workspace: remote,
        revision: stage === "refinements" ? { ...base, stage, payload: { rasterRevisionIds: [], vectorRevisionId: id(86), approvalId: null, sourceRequestKey: body.requestKey } } : { ...base, stage, payload: { vectorRevisionId: body.vectorRevisionId ?? id(80), approvalId: remote.approvedLogo?.id ?? null } } };
      if (!commit) receipt = null; if (lose) throw Error("lost acknowledgement"); return Response.json(receipt);
    }
    if (path.includes("/requests/")) return Response.json(receipt ? { status: "succeeded", requestKey: receipt.requestKey, receipt, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null } : { status: "not_found" });
    return Response.json(remote);
  });
  const options = { account, client, memory, projectId, isCurrent: () => current };
  const intent = () => createVectorRecoveryIntent({ kind: "edit", request: { requestKey: id(82), expected: workspace.heads, baseVectorRevisionId: id(80), edit: { kind: "rotation", componentId: "symbol", degrees: 15 } } });
  return { options, memory, workspace, projectId, intent, requests, lose(committed = true) { lose = true; commit = committed; }, recover() { lose = false; commit = true; }, conflict() { conflict = true; }, foreign() { current = false; }, newer() { remote = { ...remote, heads: { ...remote.heads, workspaceRevision: remote.heads.workspaceRevision + 1 } }; } };
}
describe("exact vector mutation recovery in shared owner memory", () => {
  it("retains the exact edit before sending and clears it only after committed owned state", async () => {
    const f = fixture(), intent = f.intent(); const receipt = await submitVectorIntent(f.options, intent);
    expect(receipt?.revision.stage).toBe("refinements"); expect(f.memory.get(f.projectId)?.vectorDraft).toBeNull(); expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull(); expect(f.requests).toEqual([{ path: `/api/projects/${f.projectId}/logo/edits`, body: intent.request }]);
    expect(Object.isFrozen(intent.request)).toBe(true);
  });
  it("lost acknowledgement checks the original receipt without another write or head rollback", async () => {
    const f = fixture(); f.lose(); await expect(submitVectorIntent(f.options, f.intent())).rejects.toThrow();
    expect(f.memory.get(f.projectId)?.pendingMutation?.requestKey).toBe(id(82)); expect(f.memory.get(f.projectId)?.vectorDraft).toBeTruthy(); f.newer();
    await recoverVectorMutation(f.options, false); expect(f.requests).toHaveLength(1); expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull(); expect(f.memory.get(f.projectId)?.base?.workspaceRevision).toBe(f.workspace.heads.workspaceRevision + 2);
  });
  it("a not-found read never retries until the explicit unchanged-request action", async () => {
    const f = fixture(); f.lose(false); const intent = f.intent(); await expect(submitVectorIntent(f.options, intent)).rejects.toThrow();
    await recoverVectorMutation(f.options, false); expect(f.requests).toHaveLength(1); f.recover(); await recoverVectorMutation(f.options, true);
    expect(f.requests).toHaveLength(2); expect(f.requests[0]!.body).toEqual(f.requests[1]!.body);
  });
  it("conflicts retain the original edit and cannot be silently rebased", async () => {
    const f = fixture(); f.conflict(); await expect(submitVectorIntent(f.options, f.intent())).rejects.toMatchObject({ status: 409 });
    expect(f.memory.get(f.projectId)?.vectorDraft).toBeTruthy(); expect(f.memory.get(f.projectId)?.pendingMutation?.command.body.expected).toEqual(f.workspace.heads); expect(f.memory.get(f.projectId)?.conflict).toBe(true);
  });
  it("foreign account continuations never read or resend the old owner's request", async () => {
    const f = fixture(); f.lose(); await expect(submitVectorIntent(f.options, f.intent())).rejects.toThrow(); f.foreign();
    expect(await recoverVectorMutation(f.options, true)).toBeNull(); expect(f.requests).toHaveLength(1);
  });
});
