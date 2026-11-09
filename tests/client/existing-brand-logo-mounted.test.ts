// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "../../src/components/workspace/account-session";
import { LogoCreationWorkspace } from "../../src/components/logo-creation/logo-creation-workspace";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { logoMutationReceiptSchema, type LogoMutationReceipt, type LogoStageRevision } from "../../src/domain/logo-workspace";
import { syntheticLogoBrief, syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";
import { publishInspirationLikes } from "../../src/components/workspace/inspiration-likes-signal";
import { logoInspirationHeading } from "../../src/domain/logo-saved-inputs";

/** Mounted React, real owner-scoped client/hook/memory; synthetic same-origin
 * HTTP only. No browser, provider, storage, or live database is exercised. */
function fixture() {
  const original = syntheticLogoWorkspace();
  const state = { workspace: { ...original, capabilities: { ...original.capabilities, save: { status: "available" as const } } },
    projectRevision: 1, name: "Élan & Co", owner: original.ownerId, forceConflict: false, loseAfterCommit: false, loseBeforeCommit: false, untypedRetryConflict: false, hideReceiptRead: false, loseRejectionResponse: false,
    rejections: new Map<string, { status: string; ownerId: string; projectId: string; requestKey: string; inputHash: string }>(),
    posts: [] as { path: string; body: unknown }[], reads: [] as string[], receipts: new Map<string, LogoMutationReceipt>(), stages: new Map<string, LogoStageRevision>(), requestReads: 0 };
  const snapshot = { version: 2, id: id(800), ownerId: original.ownerId, projectId: original.projectId, revision: 1, references: [] };
  const fetcher: typeof fetch = async (url, options) => {
    const path = String(url), method = options?.method ?? "GET";
    if (path === "/api/session") return Response.json({ user: { id: state.owner } });
    if (state.owner !== original.ownerId) return new Response(null, { status: 404 });
    // The Logo step reads the saved brand and inspiration and prepares its brief by itself.
    if (path.endsWith("/saved-inputs")) return Response.json({ ownerId: original.ownerId, projectId: original.projectId, projectRevision: state.projectRevision,
      inspirationSelectionRevision: 0, inspirationCount: 0, references: [], uploadNotes: [], nameConflict: false, draft: syntheticLogoBrief({ name: state.name }) });
    if (path.endsWith("/capabilities")) {
      const observed = Date.now();
      return Response.json({ ownerId: original.ownerId, projectId: original.projectId, observedAt: new Date(observed).toISOString(), operations: {
        "identity.logo_concept": { status: "available", expiresAt: new Date(observed + 30_000).toISOString() },
        "identity.logo_refine": { status: "unavailable" }, "identity.logo_vectorize": { status: "unavailable" },
        "identity.logo_directions": { status: "unavailable" }, "identity.logo_export": { status: "unavailable" },
      } });
    }
    if (path.endsWith("/quotes")) return Response.json({}, { status: 503 });
    if (method !== "GET") {
      const body = JSON.parse(String(options?.body)); state.posts.push({ path, body });
      if (!path.endsWith("/initialize") && !path.endsWith("/brief")) throw new Error(`Unexpected mutation: ${path}`);
      if (state.loseBeforeCommit) { state.loseBeforeCommit = false; throw new Error("Synthetic request connection failure"); }
      if (state.untypedRetryConflict) return Response.json({ error: { code: "conflict", message: "Unproved conflict" } }, { status: 409 });
      const known = state.receipts.get(body.requestKey); if (known) return Response.json(known);
      if (body.expected.projectRevision !== state.projectRevision || state.forceConflict || state.rejections.has(body.requestKey)) {
        const rejection = state.rejections.get(body.requestKey) ?? { status: "rejected", ownerId: original.ownerId, projectId: original.projectId, requestKey: body.requestKey, inputHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
        state.rejections.set(body.requestKey, rejection);
        if (state.loseRejectionResponse) { state.loseRejectionResponse = false; throw new Error("Synthetic lost rejection acknowledgement"); }
        return Response.json({ error: { code: "conflict", message: "Inputs changed" }, rejection }, { status: 409 });
      }
      const revision = { version: 2, id: id(801 + state.stages.size), ownerId: original.ownerId, projectId: original.projectId, stage: "brief_references", revision: state.stages.size + 1, parentRevisionId: state.workspace.stages.brief_references?.id ?? null,
        inputRevisions: [], inputHash: "a".repeat(64), createdAt: "2026-10-07T00:00:00Z", payload: { ...body.brief, referenceSnapshotId: snapshot.id, sourceProjectRevision: state.projectRevision } } as LogoStageRevision;
      state.workspace = { ...state.workspace, heads: { ...state.workspace.heads, projectRevision: state.projectRevision, workspaceRevision: state.workspace.heads.workspaceRevision + 1, stageRevisions: { ...state.workspace.heads.stageRevisions, brief_references: revision.revision } },
        stages: { ...state.workspace.stages, brief_references: { stage: "brief_references", id: revision.id, revision: revision.revision } } };
      const receipt = logoMutationReceiptSchema.parse({ ownerId: original.ownerId, projectId: original.projectId, requestKey: body.requestKey, workspace: state.workspace, revision });
      state.receipts.set(body.requestKey, receipt); state.stages.set(revision.id, revision);
      if (state.loseAfterCommit) { state.loseAfterCommit = false; throw new Error("Synthetic lost acknowledgement"); }
      return Response.json(receipt);
    }
    state.reads.push(path);
    if (path.endsWith("/logo")) return Response.json({ ...state.workspace, heads: { ...state.workspace.heads, projectRevision: state.projectRevision } });
    if (path === `/api/projects/${original.projectId}`) return Response.json({ project: { id: original.projectId, owner_id: original.ownerId, scope: "complete_brand", title: "Saved brand", current_revision: state.projectRevision, created_at: "2026-10-06T00:00:00Z",
      context: contextSnapshotSchema.parse({ selectedName: state.name, activity: "Design studio", offering: "Brand systems", knownAudience: "Founders", intake: { suppliedName: state.name } }) } });
    if (path.includes("/requests/")) { state.requestReads++; const receipt = state.hideReceiptRead ? undefined : state.receipts.get(path.split("/").at(-1)!); return Response.json(receipt ? { status: "succeeded", requestKey: receipt.requestKey, receipt, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null } : state.rejections.has(path.split("/").at(-1)!) ? { status: "failed", requestKey: path.split("/").at(-1)!, receipt: null, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: "admission_rejected" } : { status: "not_found" }); }
    if (path.includes("/stages/brief_references/revisions/")) return Response.json(state.stages.get(path.split("/").at(-1)!));
    if (path.endsWith(`/reference-snapshots/${snapshot.id}`)) return Response.json(snapshot);
    if (path.includes("/batches?")) return Response.json({ ownerId: original.ownerId, projectId: original.projectId, items: [], nextCursor: null });
    throw new Error(`Unexpected read: ${path}`);
  };
  return { state, fetcher, original };
}

describe("existing-brand initialization through the actual logo workspace", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label);
  /** The Logo message names the brand of the brief currently in the step. */
  const message = () => host.querySelector(".logo-conversation-message")?.textContent ?? "";
  async function until(test: () => boolean) { for (let i = 0; i < 80 && !test(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); expect(test(), host.textContent ?? "DOM state").toBe(true); }
  async function click(label: string) { await until(() => button(label)?.disabled === false); await act(async () => { button(label)!.click(); }); }
  async function mount(f = fixture()) {
    vi.stubGlobal("fetch", f.fetcher);
    function App() { const account = useAccountSession(); return createElement("div", null, createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoCreationWorkspace, { projectId: f.original.projectId })); }
    await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
    await until(() => f.state.reads.some(path => path.endsWith("/logo"))); return f;
  }
  const briefName = (post: { body: unknown } | undefined) => (post?.body as { brief?: { name?: string } } | undefined)?.brief?.name;
  it.each(["Élan & Co", "Cedar 🦊", null])("reads saved inputs from an empty Logo draft before checking generation font support: %s", async savedName => {
    const f = fixture(), transport = f.fetcher, quotes: unknown[] = [], reads: string[] = [];
    f.fetcher = async (url, options) => {
      const path = String(url);
      if (path.endsWith("/saved-inputs")) {
        reads.push(path);
        return Response.json({ ownerId: f.original.ownerId, projectId: f.original.projectId, projectRevision: 1, inspirationSelectionRevision: 0,
          inspirationCount: 0, references: [], uploadNotes: [], nameConflict: false, draft: savedName === null ? null : syntheticLogoBrief({ name: savedName }) });
      }
      if (path.endsWith("/capabilities")) {
        const observed = Date.now();
        return Response.json({ ownerId: f.original.ownerId, projectId: f.original.projectId, observedAt: new Date(observed).toISOString(), operations: {
          "identity.logo_concept": { status: "available", expiresAt: new Date(observed + 30_000).toISOString() },
          "identity.logo_refine": { status: "unavailable" }, "identity.logo_vectorize": { status: "unavailable" },
          "identity.logo_directions": { status: "unavailable" }, "identity.logo_export": { status: "unavailable" },
        } });
      }
      if (path.endsWith("/quotes")) { quotes.push(JSON.parse(String(options?.body))); return Response.json({}, { status: 503 }); }
      return transport(url, options);
    };
    await mount(f); await until(() => reads.length > 0);
    if (savedName === null) {
      await until(() => host.textContent!.includes("Choose and save a brand name in your project before generating logo concepts."));
      expect(f.state.posts).toEqual([]); expect(quotes).toEqual([]); return;
    }
    await until(() => f.state.posts.length === 1 && message().includes(savedName));
    expect(briefName(f.state.posts[0])).toBe(savedName); expect(f.state.posts[0]!.path).toMatch(/\/initialize$/);
    if (savedName === "Élan & Co") await until(() => quotes.length === 1);
    else {
      expect(host.textContent).toContain("Some characters in this name cannot yet be rendered");
      expect(quotes).toEqual([]);
    }
    expect(button("Explore six concepts")?.disabled).toBe(true);
  });
  it("updates its brief when Inspiration likes change on the same page before any concepts exist", async () => {
    const f = fixture(), transport = f.fetcher; let liked = false;
    const personality = `Calm\n${logoInspirationHeading("2026-10-13.1", 1)}\nVelto brand (colors): Colors: Vibrant lime and light violet.`;
    f.fetcher = async (url, options) => {
      if (String(url).endsWith("/saved-inputs") && liked) return Response.json({ ownerId: f.original.ownerId, projectId: f.original.projectId, projectRevision: 1,
        inspirationSelectionRevision: 1, inspirationCount: 1, references: [], uploadNotes: [], nameConflict: false, draft: syntheticLogoBrief({ name: f.state.name, personality }) });
      return transport(url, options);
    };
    await mount(f); await until(() => f.state.posts.length === 1 && message().includes("Élan & Co"));
    const workspaceReads = () => f.state.reads.filter(path => path.endsWith("/logo")).length, before = workspaceReads();
    // Inspiration publishes its saved revision on load (recorded), then after a like.
    await act(async () => publishInspirationLikes(f.original.ownerId, f.original.projectId, "0:0"));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(f.state.posts).toHaveLength(1);
    liked = true;
    await act(async () => publishInspirationLikes(f.original.ownerId, f.original.projectId, "1:0"));
    await until(() => f.state.posts.length === 2);
    expect(f.state.posts[1]!.path).toMatch(/\/brief$/);
    expect((f.state.posts[1]!.body as { brief: { personality: string } }).brief.personality).toBe(personality);
    expect(workspaceReads()).toBeGreaterThan(before);
  });
  it("Check original save resolves a committed lost acknowledgement of the automatic brief without replay", async () => {
    const f = fixture(); f.state.loseAfterCommit = true; await mount(f);
    await until(() => button("Check original save")?.disabled === false);
    expect(f.state.posts).toHaveLength(1); expect(briefName(f.state.posts[0])).toBe("Élan & Co");
    expect(host.textContent).toContain("We couldn’t confirm your logo brief was saved. Check the save below before continuing.");
    await click("Check original save"); await until(() => !button("Check original save"));
    expect(f.state.posts).toHaveLength(1); expect(message()).toContain("Élan & Co");
  });
  it("explicit retry after an unsent request reuses the exact body/key on initialize", async () => {
    const f = fixture(); f.state.loseBeforeCommit = true; await mount(f);
    await click("Check original save"); expect(f.state.posts).toHaveLength(1);
    await click("Check and retry original save"); await until(() => !button("Check original save"));
    expect(f.state.posts).toHaveLength(2); expect(f.state.posts[1]).toEqual(f.state.posts[0]);
  });
  it("a definitive conflict keeps the draft, then discard and Refresh logo inputs save from the current source", async () => {
    const f = fixture(); f.state.forceConflict = true; await mount(f);
    await until(() => host.textContent!.includes("Saved inputs changed")); expect(button("Check original save")).toBeUndefined();
    await click("Discard local edits and reload"); await click("Discard edits and load saved version");
    f.state.forceConflict = false; await click("Refresh logo inputs");
    await until(() => f.state.posts.length === 2 && f.state.stages.size === 1);
    expect(f.state.posts[1]!.path).toBe(`/api/projects/${f.original.projectId}/logo/initialize`); expect(briefName(f.state.posts[1])).toBe("Élan & Co");
  });
  it("recovers a committed rejection after its acknowledgement is lost using only the exact original body", async () => {
    const f = fixture(); f.state.forceConflict = true; f.state.loseRejectionResponse = true; await mount(f);
    await until(() => button("Check original save")?.disabled === false);
    await click("Check original save"); expect(button("Check original save")).toBeDefined(); expect(f.state.posts).toHaveLength(1);
    await click("Check and retry original save"); await until(() => !button("Check original save") && host.textContent!.includes("Saved inputs changed"));
    expect(f.state.posts).toHaveLength(2); expect(f.state.posts[1]).toEqual(f.state.posts[0]); expect(f.state.stages.size).toBe(0);
  });
  it("retains the exact original key when a retry receives an unproved HTTP conflict", async () => {
    const f = fixture(); f.state.loseAfterCommit = true; await mount(f);
    await until(() => button("Check original save")?.disabled === false);
    f.state.hideReceiptRead = true; f.state.untypedRetryConflict = true;
    await click("Check and retry original save");
    expect(button("Check original save")).toBeDefined(); expect(f.state.posts).toHaveLength(2); expect(f.state.posts[1]).toEqual(f.state.posts[0]);
    f.state.hideReceiptRead = false; f.state.untypedRetryConflict = false;
    await click("Check original save"); await until(() => !button("Check original save")); expect(f.state.posts).toHaveLength(2);
  });
  it("does not clear the original initialization when recovery carries a different source revision", async () => {
    const f = fixture(); f.state.loseAfterCommit = true; await mount(f);
    await until(() => button("Check original save")?.disabled === false);
    const [key, original] = [...f.state.receipts][0]!;
    if (original.revision.stage !== "brief_references") throw new Error("Wrong fixture stage");
    f.state.receipts.set(key, { ...original, revision: { ...original.revision, payload: { ...original.revision.payload, sourceProjectRevision: 99 } } });
    await click("Check original save");
    expect(button("Check original save")).toBeDefined(); expect(f.state.posts).toHaveLength(1);
  });
  it.each([false, true])("retry recovery reads the current workspace after confirming an older original receipt (hidden read: %s)", async hideReceiptRead => {
    const f = fixture(); f.state.loseAfterCommit = true; await mount(f);
    await until(() => button("Check original save")?.disabled === false);
    const first = [...f.state.receipts.values()][0]!;
    if (first.revision.stage !== "brief_references") throw new Error("Wrong fixture stage");
    const next: LogoStageRevision = { ...first.revision, id: id(850), revision: 2, parentRevisionId: first.revision.id, payload: { ...first.revision.payload, name: "Saved later in another tab" } };
    f.state.stages.set(next.id, next);
    f.state.workspace = { ...f.state.workspace, heads: { ...f.state.workspace.heads, workspaceRevision: 2, stageRevisions: { ...f.state.workspace.heads.stageRevisions, brief_references: 2 } }, stages: { ...f.state.workspace.stages, brief_references: { stage: "brief_references", id: next.id, revision: 2 } } };
    f.state.hideReceiptRead = hideReceiptRead;
    await click("Check and retry original save"); await until(() => !button("Check original save"));
    await until(() => message().includes("Saved later in another tab")); expect(f.state.posts).toHaveLength(hideReceiptRead ? 2 : 1);
  });
  it("same-owner reverification keeps an unresolved initialization while another owner sees no retained name", async () => {
    const f = fixture(); f.state.loseBeforeCommit = true; await mount(f);
    await until(() => button("Check original save")?.disabled === false); await click("Recheck account");
    await until(() => message().includes("Élan & Co") && button("Check original save")?.disabled === false); expect(f.state.posts).toHaveLength(1);
    f.state.owner = id(998); await click("Recheck account"); await until(() => !host.textContent?.includes("Élan & Co"));
    expect(f.state.posts).toHaveLength(1);
  });
});
