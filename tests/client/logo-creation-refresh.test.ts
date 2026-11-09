import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import { loadLogoWorkspaceBaseline } from "../../src/components/identity/use-logo-workspace";
import { createLogoCreationController } from "../../src/components/logo-creation/creation-controller";
import { refreshLogoCreationWorkspace } from "../../src/components/logo-creation/workspace-refresh";
import { syntheticLogoQuote, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoGenerationIntent, LogoQuoteRequest } from "../../src/domain/logo-jobs";
import type { LogoWorkspaceReloadResult } from "../../src/components/identity/use-logo-workspace";

/** Real client, baseline loader and private memory; synthetic HTTP only. This
 * exercises the controller/refresh port, not an unrun browser effect lifecycle. */
function setup() {
  const source = syntheticResolvedLogoConcept(), original = syntheticLogoWorkspace();
  const h1 = { ...original, heads: { ...original.heads, workspaceRevision: 1, referenceRevision: 1, stageRevisions: { ...original.heads.stageRevisions, brief_references: 1 } },
    stages: { ...original.stages, brief_references: { stage: "brief_references" as const, id: source.brief.id, revision: 1 } },
    capabilities: { ...original.capabilities, generate: { status: "available" as const }, save: { status: "available" as const } } };
  const h2 = { ...h1, heads: { ...h1.heads, workspaceRevision: 2, stageRevisions: { ...h1.heads.stageRevisions, brief_references: 2 } }, stages: { ...h1.stages, brief_references: { stage: "brief_references" as const, id: id(950), revision: 2 } } };
  const brief2 = { ...source.brief, id: id(950), revision: 2, parentRevisionId: source.brief.id, payload: { ...source.brief.payload, activity: "A new activity saved in another tab" } };
  let server = h1, current = true, unavailable = false, hold: Promise<void> | null = null;
  const memory = createLogoDraftMemory(), account = { status: "ready" as const, userId: h1.ownerId, generation: 1 };
  const { name, activity, audience, personality, logoTypes } = source.brief.payload;
  memory.bind({ ownerId: account.userId, generation: account.generation });
  memory.set(h1.projectId, { workspace: h1, base: h1.heads, brief: { name, activity, audience, personality, logoTypes }, references: [], dirty: false, conflict: false, pendingIntent: null, pendingMutation: null, pendingExport: null });
  const quotes: LogoQuoteRequest[] = [], posts: LogoGenerationIntent[] = [], paths: string[] = [], reloadFlags: boolean[] = [];
  const client = createAccountLogoClient(account, h1.projectId, () => current, () => { current = false; }, async (path, options) => {
    const url = String(path); paths.push(url);
    if (url.endsWith("/quotes")) {
      const body = JSON.parse(String(options?.body)) as LogoQuoteRequest; quotes.push(body);
      if (JSON.stringify(body.expected) !== JSON.stringify(server.heads)) return Response.json({ error: { code: "conflict", message: "Head conflict" } }, { status: 409 });
      return Response.json({ ...syntheticLogoQuote(), id: id(960 + quotes.length), expected: server.heads, request: body, expiresAt: "2026-10-06T13:00:00Z" });
    }
    if (url.endsWith("/requests")) {
      const body = JSON.parse(String(options?.body)) as LogoGenerationIntent; posts.push(body);
      return Response.json({ error: { code: "conflict", message: "This request conflicts with the current state." }, rejection: { status: "rejected", ownerId: h1.ownerId, projectId: h1.projectId, requestKey: body.requestKey, quoteId: body.quoteId } }, { status: 409 });
    }
    if (url.endsWith("/logo")) { if (hold) await hold; if (unavailable) return new Response(null, { status: 503 }); return Response.json(server); }
    if (url.endsWith(`/stages/brief_references/revisions/${id(950)}`)) return Response.json(brief2);
    if (url.endsWith(`/stages/brief_references/revisions/${source.brief.id}`)) return Response.json(source.brief);
    if (url.endsWith(`/reference-snapshots/${source.referenceSnapshot.id}`)) return Response.json(source.referenceSnapshot);
    return new Response(null, { status: 404 });
  });
  const reload = async (discard: boolean): Promise<LogoWorkspaceReloadResult> => {
    reloadFlags.push(discard);
    const captured = memory.get(h1.projectId);
    try {
      const baseline = await loadLogoWorkspaceBaseline({ client, account, projectId: h1.projectId, memory, signal: new AbortController().signal, isCurrent: () => current });
      if (!baseline || !current || memory.get(h1.projectId) !== captured) return "unavailable";
      memory.set(h1.projectId, { ...captured!, workspace: baseline.workspace, base: baseline.workspace.heads, brief: baseline.brief, references: baseline.references });
      return "reloaded";
    } catch { return "unavailable"; }
  };
  const controller = createLogoCreationController({ client, projectId: h1.projectId, getWorkspace: () => memory.get(h1.projectId)?.workspace ?? null,
    hasUnsavedInputs: () => !!memory.get(h1.projectId)?.dirty, getPendingIntent: () => memory.get(h1.projectId)?.pendingIntent ?? null,
    retainIntent: pendingIntent => memory.set(h1.projectId, { ...memory.get(h1.projectId)!, pendingIntent }),
    clearIntent: requestKey => { const draft = memory.get(h1.projectId); if (draft?.pendingIntent?.requestKey === requestKey) memory.set(h1.projectId, { ...draft, pendingIntent: null }); },
    refreshWorkspace: () => refreshLogoCreationWorkspace({ memory, projectId: h1.projectId, isCurrent: () => current, reload }),
    isCurrent: () => current, now: () => Date.parse("2026-10-06T12:00:00Z"), createRequestKey: () => id(970 + posts.length) });
  const request = (): LogoQuoteRequest => { const workspace = memory.get(h1.projectId)!.workspace!; return { operation: "concepts", expected: workspace.heads, briefRevisionId: workspace.stages.brief_references!.id, referenceSnapshotId: source.referenceSnapshot.id }; };
  async function rejectAfterOtherTabSaved() { await controller.prepare(request()); server = h2; await controller.confirmQuote(controller.getSnapshot().quote!.id); expect(controller.getSnapshot().phase).toBe("rejected"); }
  return { controller, memory, projectId: h1.projectId, h1, h2, request, quotes, posts, paths, reloadFlags, rejectAfterOtherTabSaved,
    advanceServer() { server = h2; }, unavailable() { unavailable = true; }, hold() { let resolve!: () => void; hold = new Promise<void>(yes => { resolve = yes; }); return resolve; },
    foreign() { current = false; memory.bind({ ownerId: id(999), generation: 2 }); },
    edit(kind: "brief" | "vector" | "direction") { const draft = memory.get(h1.projectId)!;
      memory.set(h1.projectId, kind === "brief" ? { ...draft, dirty: true, brief: { ...draft.brief, name: "Keep my edited name" } }
        : kind === "vector" ? { ...draft, vectorDraft: { baseVectorRevisionId: id(980), edit: { kind: "locks", componentIds: ["symbol"] } } }
        : { ...draft, directionDraft: { approvedLogoId: id(981), paletteVersionId: id(982), typographyVersionId: id(983), graphicsVersionId: id(984), reviewedConsistencyHash: null } });
    } };
}

describe("returning to cost review refreshes authoritative workspace heads", () => {
  it("refreshes H1 to genuinely advanced server H2 before requesting a fresh quote", async () => {
    const f = setup(); await f.rejectAfterOtherTabSaved();
    expect(f.memory.get(f.projectId)!.base).toEqual(f.h1.heads);
    await f.controller.returnToCostReview();
    expect(f.reloadFlags).toEqual([false]); expect(f.memory.get(f.projectId)!.base).toEqual(f.h2.heads);
    expect(f.controller.getSnapshot().phase).toBe("idle"); expect(f.quotes).toHaveLength(1); expect(f.posts).toHaveLength(1);
    await f.controller.prepare(f.request()); expect(f.quotes[1]!.expected).toEqual(f.h2.heads);
    expect(f.controller.getSnapshot().phase).toBe("awaiting_confirmation"); expect(f.posts).toHaveLength(1);
  });
  it.each(["brief", "vector", "direction"] as const)("preserves an unsaved %s draft and requests resolution instead of discarding it", async kind => {
    const f = setup(); await f.rejectAfterOtherTabSaved(); f.edit(kind); const original = f.memory.get(f.projectId);
    await f.controller.returnToCostReview();
    expect(f.controller.getSnapshot().phase).toBe("resolve_draft"); expect(f.memory.get(f.projectId)).toBe(original); expect(f.reloadFlags).toEqual([]);
    await f.controller.prepare(f.request()); expect(f.quotes).toHaveLength(1); expect(f.posts).toHaveLength(1);
  });
  it("cancelling a closed cost dialog cannot bypass the required workspace refresh", async () => {
    const f = setup(); await f.rejectAfterOtherTabSaved(); f.controller.cancelQuote();
    expect(f.controller.getSnapshot().phase).toBe("rejected"); await f.controller.prepare(f.request()); expect(f.quotes).toHaveLength(1);
  });
  it("a quote-time head conflict also offers explicit refresh without any admission", async () => {
    const f = setup(); f.advanceServer(); await f.controller.prepare(f.request());
    expect(f.controller.getSnapshot().phase).toBe("rejected"); expect(f.posts).toHaveLength(0);
    await f.controller.returnToCostReview(); await f.controller.prepare(f.request());
    expect(f.quotes[1]!.expected).toEqual(f.h2.heads); expect(f.controller.getSnapshot().phase).toBe("awaiting_confirmation"); expect(f.posts).toHaveLength(0);
  });
  it("blocks new quote clicks while the owner-fenced refresh is still in flight", async () => {
    const f = setup(); await f.rejectAfterOtherTabSaved(); const release = f.hold();
    const refreshing = f.controller.returnToCostReview(); expect(f.controller.getSnapshot().phase).toBe("refreshing_workspace");
    await f.controller.prepare(f.request()); expect(f.quotes).toHaveLength(1); release(); await refreshing;
    expect(f.controller.getSnapshot().phase).toBe("idle"); expect(f.memory.get(f.projectId)!.base).toEqual(f.h2.heads);
  });
  it("preserves edits introduced during refresh instead of applying its stale baseline", async () => {
    const f = setup(); await f.rejectAfterOtherTabSaved(); const release = f.hold();
    const refreshing = f.controller.returnToCostReview(); f.edit("brief"); const original = f.memory.get(f.projectId); release(); await refreshing;
    expect(f.memory.get(f.projectId)).toBe(original); expect(f.controller.getSnapshot().phase).toBe("resolve_draft"); expect(f.quotes).toHaveLength(1);
  });
  it("a failed refresh remains blocked instead of reopening quotes on stale H1", async () => {
    const f = setup(); await f.rejectAfterOtherTabSaved(); f.unavailable(); await f.controller.returnToCostReview();
    expect(f.controller.getSnapshot().phase).toBe("rejected"); expect(f.memory.get(f.projectId)!.base).toEqual(f.h1.heads);
    await f.controller.prepare(f.request()); expect(f.quotes).toHaveLength(1);
  });
  it("does not expose or apply H2 after the verified account changes during refresh", async () => {
    const f = setup(); await f.rejectAfterOtherTabSaved(); const release = f.hold();
    const refreshing = f.controller.returnToCostReview(); f.foreign(); release(); await refreshing;
    expect(f.memory.get(f.projectId)).toBeNull(); expect(f.controller.getSnapshot().quote).toBeNull(); expect(f.posts).toHaveLength(1);
  });
});
