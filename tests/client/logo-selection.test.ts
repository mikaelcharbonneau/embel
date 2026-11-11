import { describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import {
  selectLogoCandidate,
  recoverLogoSelection,
  LogoSelectionConflictResolvedError,
} from "../../src/components/logo-creation/selection-controller";
import { syntheticLogoBatch, syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";

function setup() {
  const memory = createLogoDraftMemory(),
    original = syntheticLogoWorkspace(),
    batch = syntheticLogoBatch();
  const workspace = { ...original, capabilities: { ...original.capabilities, save: { status: "available" as const } } };
  const account = { status: "ready" as const, userId: workspace.ownerId, generation: 1 },
    projectId = workspace.projectId;
  const source = {
    kind: "concept" as const,
    batchId: batch.id,
    slotId: batch.slots[0]!.id,
    attemptId: batch.slots[0]!.attempts[0]!.id,
  };
  memory.bind({ ownerId: account.userId, generation: 1 });
  memory.set(projectId, {
    workspace,
    base: workspace.heads,
    brief: { name: "Élan & Co", activity: "", audience: "", personality: "", logoTypes: ["wordmark"] },
    references: [],
    dirty: false,
    conflict: false,
    pendingExport: null,
    pendingMutation: null,
  });
  const nextWorkspace = {
    ...workspace,
    heads: {
      ...workspace.heads,
      workspaceRevision: 1,
      stageRevisions: { ...workspace.heads.stageRevisions, concepts: 1 },
    },
    stages: { ...workspace.stages, concepts: { stage: "concepts" as const, id: id(904), revision: 1 } },
  };
  const receipt = {
    ownerId: workspace.ownerId,
    projectId,
    requestKey: id(903),
    workspace: nextWorkspace,
    revision: {
      version: 2,
      id: id(904),
      ownerId: workspace.ownerId,
      projectId,
      stage: "concepts",
      revision: 1,
      parentRevisionId: null,
      inputRevisions: [],
      inputHash: "a".repeat(64),
      createdAt: "2026-10-06T12:00:00Z",
      payload: { batchIds: [batch.id], selected: source },
    },
  };
  const posts: unknown[] = [];
  let lose = false,
    committed = false,
    current = true;
  const client = createAccountLogoClient(
    account,
    projectId,
    () => current,
    () => {
      current = false;
    },
    async (url, options) => {
      if (String(url).endsWith("/concepts/selection")) {
        posts.push(JSON.parse(String(options?.body)));
        committed = true;
        if (lose) throw new Error("Lost response");
        return Response.json(receipt);
      }
      return Response.json(
        committed
          ? {
              status: "succeeded",
              requestKey: receipt.requestKey,
              receipt,
              outputs: [],
              billing: { status: "recorded", confirmedMicrousd: 0 },
              reason: null,
            }
          : { status: "not_found" },
      );
    },
  );
  return {
    memory,
    projectId,
    source,
    posts,
    receipt,
    options: { client, memory, projectId, isCurrent: () => current, createRequestKey: () => id(903) },
    lose() {
      lose = true;
    },
    foreign() {
      current = false;
    },
  };
}
describe("manual saved logo selection", () => {
  it("retains exact source before sending and creates no approval or generation", async () => {
    const f = setup(),
      receipt = await selectLogoCandidate(f.options, f.source);
    expect(receipt?.revision.stage).toBe("concepts");
    expect(f.posts).toHaveLength(1);
    expect(f.memory.get(f.projectId)?.workspace?.approvedLogo).toBeNull();
    expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull();
  });
  it("lost response preserves the original command, then check recovers without resending", async () => {
    const f = setup();
    f.lose();
    await expect(selectLogoCandidate(f.options, f.source)).rejects.toThrow();
    expect(f.memory.get(f.projectId)?.pendingMutation?.requestKey).toBe(id(903));
    await recoverLogoSelection(f.options, false);
    expect(f.posts).toHaveLength(1);
    expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull();
  });
  it("dirty edits and a foreign account never select", async () => {
    const f = setup();
    f.memory.set(f.projectId, { ...f.memory.get(f.projectId)!, dirty: true });
    await expect(selectLogoCandidate(f.options, f.source)).rejects.toThrow();
    expect(f.posts).toHaveLength(0);
    f.foreign();
    expect(await recoverLogoSelection(f.options, true)).toBeNull();
    expect(f.posts).toHaveLength(0);
  });
});

function pendingSelection() {
  const f = setup(),
    original = f.memory.get(f.projectId)!;
  const command = {
    method: "selectLogoConcept" as const,
    body: {
      requestKey: id(903),
      expected: original.base!,
      batchId: f.source.batchId,
      slotId: f.source.slotId,
      attemptId: f.source.attemptId,
    },
  };
  f.memory.set(f.projectId, { ...original, pendingMutation: { requestKey: command.body.requestKey, command } });
  const retained = f.memory.get(f.projectId)!,
    order: string[] = [],
    posts: unknown[] = [];
  const account = { status: "ready" as const, userId: original.workspace!.ownerId, generation: 1 };
  const controls: {
    generation: number;
    workspace: typeof f.receipt.workspace;
    request(index: number): Promise<Response>;
  } = {
    generation: 1,
    workspace: f.receipt.workspace,
    request: async () => Response.json({ status: "not_found" }),
  };
  let reads = 0;
  const client = createAccountLogoClient(
    account,
    f.projectId,
    (captured) => captured.generation === controls.generation,
    () => {},
    async (path, options) => {
      if (String(path).endsWith(`/requests/${command.body.requestKey}`)) {
        order.push("request");
        return controls.request(++reads);
      }
      if (String(path).endsWith("/logo")) {
        order.push("workspace");
        return Response.json(controls.workspace);
      }
      if (String(path).endsWith("/concepts/selection")) {
        order.push("selection");
        posts.push(JSON.parse(String(options?.body)));
        return Response.json(f.receipt);
      }
      throw new Error("Unexpected synthetic request");
    },
  );
  const success = () =>
    Response.json({
      status: "succeeded",
      requestKey: f.receipt.requestKey,
      receipt: f.receipt,
      outputs: [],
      billing: { status: "recorded", confirmedMicrousd: 0 },
      reason: null,
    });
  return {
    ...f,
    controls,
    retained,
    command,
    order,
    posts,
    success,
    options: { ...f.options, client, isCurrent: () => controls.generation === account.generation },
  };
}

describe("retained selection conflict recovery", () => {
  it.each([false, true])(
    "retires an impossible stale intent only after two absent reads around newer heads (retry=%s)",
    async (retry) => {
      const f = pendingSelection();
      await expect(recoverLogoSelection(f.options, retry)).rejects.toBeInstanceOf(LogoSelectionConflictResolvedError);
      expect(f.order).toEqual(["request", "workspace", "request"]);
      expect(f.posts).toEqual([]);
      const next = f.memory.get(f.projectId)!;
      expect(next).toEqual({ ...f.retained, pendingMutation: null });
      expect(next.base).toEqual(f.command.body.expected); // No implicit rebase or new selection.
    },
  );
  it("applies the original receipt when its commit becomes visible between the two checks", async () => {
    const f = pendingSelection();
    f.controls.request = async (index) => (index === 1 ? Response.json({ status: "not_found" }) : f.success());
    const receipt = await recoverLogoSelection(f.options, true);
    expect(receipt?.requestKey).toBe(f.command.body.requestKey);
    expect(f.order).toEqual(["request", "workspace", "request"]);
    expect(f.posts).toEqual([]);
    expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull();
    expect(f.memory.get(f.projectId)?.workspace).toEqual(f.receipt.workspace);
  });
  it("preserves exact retry behavior when no irreversible head advance has been observed", async () => {
    const f = pendingSelection();
    f.controls.workspace = f.retained.workspace! as typeof f.controls.workspace;
    await recoverLogoSelection(f.options, true);
    expect(f.order).toEqual(["request", "workspace", "selection"]);
    expect(f.posts).toEqual([f.command.body]);
    expect(f.memory.get(f.projectId)?.pendingMutation).toBeNull();
  });
  it.each([1, 2])("retains the exact original intent after request read %s fails", async (failure) => {
    const f = pendingSelection();
    f.controls.request = async (index) => {
      if (index === failure) throw new Error("Synthetic network failure");
      return Response.json({ status: "not_found" });
    };
    await expect(recoverLogoSelection(f.options, true)).rejects.toThrow();
    expect(f.memory.get(f.projectId)).toBe(f.retained);
    expect(f.posts).toEqual([]);
  });
  it("keeps unknown request states even after newer workspace heads are known", async () => {
    const f = pendingSelection();
    f.controls.request = async (index) =>
      index === 1
        ? Response.json({ status: "not_found" })
        : Response.json({
            status: "needs_reconciliation",
            requestKey: f.command.body.requestKey,
            receipt: null,
            outputs: [],
            billing: { status: "unknown", confirmedMicrousd: null },
            reason: "Synthetic unresolved request",
          });
    await recoverLogoSelection(f.options, true);
    expect(f.memory.get(f.projectId)).toBe(f.retained);
    expect(f.posts).toEqual([]);
  });
  it.each(["draft", "account"] as const)(
    "retains the original intent when %s changes during the second lookup",
    async (change) => {
      const f = pendingSelection();
      let finish!: (response: Response) => void;
      f.controls.request = async (index) =>
        index === 1
          ? Response.json({ status: "not_found" })
          : new Promise((resolve) => {
              finish = resolve;
            });
      const pending = recoverLogoSelection(f.options, true);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      if (change === "draft")
        f.memory.set(f.projectId, {
          ...f.retained,
          dirty: true,
          brief: { ...f.retained.brief, activity: "Keep this new edit" },
        });
      else {
        f.controls.generation++;
        f.memory.bind({ ownerId: f.retained.workspace!.ownerId, generation: f.controls.generation });
      }
      finish(Response.json({ status: "not_found" }));
      expect(await pending).toBeNull();
      expect(f.memory.get(f.projectId)?.pendingMutation).toEqual(f.retained.pendingMutation);
      expect(f.posts).toEqual([]);
      if (change === "draft") expect(f.memory.get(f.projectId)?.brief.activity).toBe("Keep this new edit");
    },
  );
});
