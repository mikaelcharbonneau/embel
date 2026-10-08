import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import { selectLogoCandidate, recoverLogoSelection } from "../../src/components/logo-creation/selection-controller";
import { syntheticLogoBatch, syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";

function setup() {
  const memory = createLogoDraftMemory(), original = syntheticLogoWorkspace(), batch = syntheticLogoBatch();
  const workspace = { ...original, capabilities: { ...original.capabilities, save: { status: "available" as const } } };
  const account = { status: "ready" as const, userId: workspace.ownerId, generation: 1 }, projectId = workspace.projectId;
  const source = { kind: "concept" as const, batchId: batch.id, slotId: batch.slots[0]!.id, attemptId: batch.slots[0]!.attempts[0]!.id };
  memory.bind({ ownerId: account.userId, generation: 1 }); memory.set(projectId, { workspace, base: workspace.heads, brief: { name: "Élan & Co", activity: "", audience: "", personality: "", logoTypes: ["wordmark"] }, references: [], dirty: false, conflict: false, pendingIntent: null, pendingCreation: null, pendingExport: null, pendingMutation: null });
  const nextWorkspace = { ...workspace, heads: { ...workspace.heads, workspaceRevision: 1, stageRevisions: { ...workspace.heads.stageRevisions, concepts: 1 } }, stages: { ...workspace.stages, concepts: { stage: "concepts" as const, id: id(904), revision: 1 } } };
  const receipt = { ownerId: workspace.ownerId, projectId, requestKey: id(903), workspace: nextWorkspace,
    revision: { version: 2, id: id(904), ownerId: workspace.ownerId, projectId, stage: "concepts", revision: 1, parentRevisionId: null, inputRevisions: [], inputHash: "a".repeat(64), createdAt: "2026-10-06T12:00:00Z", payload: { batchIds: [batch.id], selected: source } } };
  const posts: unknown[] = []; let lose = false, committed = false, current = true;
  const client = createAccountLogoClient(account, projectId, () => current, () => { current = false; }, async (url, options) => {
    if (String(url).endsWith("/concepts/selection")) { posts.push(JSON.parse(String(options?.body))); committed = true; if (lose) throw new Error("Lost response"); return Response.json(receipt); }
    return Response.json(committed ? { status: "succeeded", requestKey: receipt.requestKey, receipt, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null } : { status: "not_found" });
  });
  return { memory, projectId, source, posts, receipt, options: { client, memory, projectId, isCurrent: () => current, createRequestKey: () => id(903) }, lose() { lose = true; }, foreign() { current = false; } };
}
describe("manual saved logo selection", () => {
  it("retains exact source before sending and creates no approval or generation", async () => {
    const f = setup(), receipt = await selectLogoCandidate(f.options, f.source);
    expect(receipt?.revision.stage).toBe("concepts"); expect(f.posts).toHaveLength(1); expect(f.memory.get(f.projectId)?.workspace?.approvedLogo).toBeNull(); expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull();
  });
  it("lost response preserves the original command, then check recovers without resending", async () => {
    const f = setup(); f.lose(); await expect(selectLogoCandidate(f.options, f.source)).rejects.toThrow();
    expect(f.memory.get(f.projectId)?.pendingMutation?.requestKey).toBe(id(903));
    await recoverLogoSelection(f.options, false); expect(f.posts).toHaveLength(1); expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull();
  });
  it("dirty edits and a foreign account never select", async () => {
    const f = setup(); f.memory.set(f.projectId, { ...f.memory.get(f.projectId)!, dirty: true });
    await expect(selectLogoCandidate(f.options, f.source)).rejects.toThrow(); expect(f.posts).toHaveLength(0);
    f.foreign(); expect(await recoverLogoSelection(f.options, true)).toBeNull(); expect(f.posts).toHaveLength(0);
  });
});
