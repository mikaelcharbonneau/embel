// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRefinementPreparation } from "../../src/components/logo-creation/use-refinement-preparation";
import { createLogoCreationController } from "../../src/components/logo-creation/creation-controller";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import { syntheticLogoWorkspace, syntheticLogoBatch, syntheticLogoQuote, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import type { LogoRasterSource } from "../../src/domain/logo-workspace";
import type { LogoQuoteRequest } from "../../src/domain/logo-jobs";

describe("committed refinement readiness with real React, memory and quote controller", () => {
  let root: Root;
  const roots: Root[] = [], clients: { dispose(): void }[] = [], controllers: { dispose(): void }[] = [];
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const host = document.createElement("div"); document.body.append(host); root = createRoot(host); roots.push(root); });
  afterEach(async () => { for (const item of roots.splice(0)) await act(async () => item.unmount()); for (const item of controllers.splice(0)) item.dispose(); for (const item of clients.splice(0)) item.dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

  function fixture() {
    const resolved = syntheticResolvedLogoConcept(), batch = syntheticLogoBatch(), foundation = syntheticLogoWorkspace();
    const workspace = { ...foundation, heads: { ...foundation.heads, workspaceRevision: 1, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1 } },
      stages: { ...foundation.stages, brief_references: { stage: "brief_references" as const, id: resolved.brief.id, revision: 1 } } };
    const account = { status: "ready" as const, userId: workspace.ownerId, generation: 1 };
    const memory = createLogoDraftMemory(); memory.bind({ ownerId: account.userId, generation: account.generation });
    memory.set(workspace.projectId, { workspace, base: workspace.heads, brief: { name: "Élan & Co", activity: "Tea shop", audience: "Local readers", personality: "Warm", logoTypes: ["wordmark"] }, references: [], dirty: false,
      pendingIntent: null, pendingCreation: null, pendingExport: null, pendingMutation: null, conflict: false });
    const raster: LogoRasterSource = { kind: "concept", batchId: batch.id, slotId: batch.slots[0]!.id, attemptId: batch.slots[0]!.attempts[0]!.id };
    const request: Extract<LogoQuoteRequest, { operation: "refine_preview" }> = { operation: "refine_preview", expected: workspace.heads, source: raster, instruction: "Widen the saved lettering." };
    const state = { ready: false, pending: false, current: true, source: raster as LogoRasterSource };
    const paths: string[] = [], reject = vi.fn(), isCurrent = () => state.current;
    const client = createAccountLogoClient(account, workspace.projectId, isCurrent, () => { state.current = false; }, async input => {
      const path = String(input); paths.push(path);
      if (path.endsWith(`/batches/${batch.id}`)) return Response.json(batch);
      if (path.endsWith(`/stages/brief_references/revisions/${resolved.brief.id}`)) return Response.json(resolved.brief);
      if (path.endsWith(`/reference-snapshots/${resolved.referenceSnapshot.id}`)) return Response.json(resolved.referenceSnapshot);
      if (path.endsWith("/quotes")) return Response.json({ ...syntheticLogoQuote(), request, expected: workspace.heads, conceptPlan: null, targetSlotIds: [batch.slots[0]!.id], expiresAt: new Date(Date.now() + 60_000).toISOString() });
      throw new Error("No admission, provider or unrelated request is permitted");
    }); clients.push(client);
    const controller = createLogoCreationController({ client, projectId: workspace.projectId, getWorkspace: () => memory.get(workspace.projectId)?.workspace ?? null,
      hasUnsavedInputs: () => !state.ready || state.pending || Boolean(memory.get(workspace.projectId)?.dirty), getPendingIntent: () => null,
      retainIntent() { throw new Error("Quote preparation must not admit work"); }, clearIntent() {}, refreshWorkspace: async () => "reloaded", isOperationAvailable: () => true, isCurrent,
      now: Date.now, createRequestKey: () => crypto.randomUUID() }); controllers.push(controller);
    let handle: ReturnType<typeof useRefinementPreparation> | null = null;
    function Harness() { handle = useRefinementPreparation({ account, projectId: workspace.projectId, client, controller, memory, canEdit: state.ready, pending: state.pending,
      selectedSource: state.source, isCurrent, onRejected: reject }); return null; }
    async function render() { await act(async () => root.render(<StrictMode><Harness /></StrictMode>)); }
    async function enqueue() { await act(async () => { expect(handle!.enqueue(request)).toBe(true); expect(handle!.enqueue(request)).toBe(false); }); }
    return { state, memory, workspace, render, enqueue, paths, reject, controller, get pending() { return handle!.pending; } };
  }

  it("waits for delayed committed editability and opens exactly one real quote without admission", async () => {
    const f = fixture(); await f.render(); await f.enqueue(); await f.render();
    expect(f.paths).toEqual([]); expect(f.controller.getSnapshot().phase).toBe("idle"); expect(f.pending).toBe(true);
    f.state.ready = true; await f.render(); await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe("awaiting_confirmation"));
    await f.render(); expect(f.paths.filter(path => path.endsWith("/quotes"))).toHaveLength(1); expect(f.paths.some(path => path.endsWith("/requests"))).toBe(false); expect(f.reject).not.toHaveBeenCalled();
  });
  it("waits while the committed workspace still has an operation in progress", async () => {
    const f = fixture(); await f.render(); await f.enqueue(); f.state.ready = true; f.state.pending = true; await f.render(); expect(f.paths).toEqual([]);
    f.state.pending = false; await f.render(); await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe("awaiting_confirmation")); expect(f.reject).not.toHaveBeenCalled();
  });
  it.each(["owner", "heads", "draft", "selection"] as const)("rejects %s invalidation before readiness without any quote or admission", async kind => {
    const f = fixture(); await f.render(); await f.enqueue();
    const previous = f.memory.get(f.workspace.projectId)!;
    if (kind === "owner") f.state.current = false;
    if (kind === "heads") { const heads = { ...f.workspace.heads, workspaceRevision: 2 }; f.memory.set(f.workspace.projectId, { ...previous, base: heads, workspace: { ...f.workspace, heads } }); }
    if (kind === "draft") f.memory.set(f.workspace.projectId, { ...previous, dirty: true, brief: { ...previous.brief, name: "Keep this unsaved name" } });
    if (kind === "selection") f.state.source = { kind: "refinement", rasterRevisionId: "00000000-0000-4000-8000-000000000999" };
    f.state.ready = true; await f.render(); expect(f.reject).toHaveBeenCalledOnce(); expect(f.paths).toEqual([]); expect(f.pending).toBe(false);
    if (kind === "draft") expect(f.memory.get(f.workspace.projectId)?.brief.name).toBe("Keep this unsaved name");
  });
  it("drops an unmounted pending handoff without issuing a quote", async () => {
    const f = fixture(); await f.render(); await f.enqueue(); await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1); expect(f.paths).toEqual([]);
  });
});
