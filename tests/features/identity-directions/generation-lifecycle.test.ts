// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect, useLayoutEffect, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import { logoOperationSchema, type LogoCostQuote, type LogoGenerationIntent, type LogoRequestState } from "@/domain/logo-jobs";
import type { IdentityDirectionsOverview } from "@/domain/logo-directions";
import type { LogoManualCommand, LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { useIdentityDirections, type IdentityDirectionsController } from "@/features/identity-directions/components/use-identity-directions";
import { IdentityDirectionsView } from "@/features/identity-directions/components/identity-directions-panel";
import { directionFixture, id } from "./fixtures";
import { visualOverview } from "../../fixtures/visual-direction";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let mounted: Root | null = null;
afterEach(async () => { if (mounted) { await act(async () => mounted!.unmount()); mounted = null; } document.body.innerHTML = ""; vi.unstubAllGlobals(); });
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); try { check(); return; } catch (e) { error = e; } } throw error; }
async function setup(options: { available?: boolean; legacyUnavailable?: boolean; fonts?: boolean; lose?: boolean } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
  const overview = directionFixture(); let history: IdentityDirectionsOverview | null = null, historyStatus = 200; let fonts = options.fonts === false ? [] : overview.fonts;
  let visual = visualOverview({ ownerId: overview.ownerId, projectId: overview.projectId });
  let workspace: LogoWorkspaceV2 = { version: 2, ownerId: overview.ownerId, projectId: overview.projectId, approvedLogo: overview.currentApprovedLogo,
    heads: { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 3, stageRevisions: { brief_references: 1, concepts: 0, vector: 1, refinements: 0, directions: 1, deliverables: 0 } },
    stages: { brief_references: { stage: "brief_references", id: id(6), revision: 1 }, concepts: null, vector: { stage: "vector", id: id(5), revision: 1 }, refinements: null, directions: { stage: "directions", id: id(8), revision: 1 }, deliverables: null }, staleStages: [],
    capabilities: { save: { status: "available" }, generate: options.legacyUnavailable || options.available === false ? { status: "unavailable", reason: "Synthetic provider unavailable" } : { status: "available" }, upload: { status: "unavailable", reason: "fixture" }, convert: { status: "unavailable", reason: "fixture" }, export: { status: "unavailable", reason: "fixture" } } };
  const stage = (name: string, revisionId: string, payload: unknown) => ({ version: 2, id: revisionId, ownerId: overview.ownerId, projectId: overview.projectId, stage: name, revision: 1, parentRevisionId: null, inputRevisions: [], inputHash: "a".repeat(64), payload, createdAt: "2026-10-07T00:00:00Z" });
  const revisions: Record<string, unknown> = {
    [id(6)]: stage("brief_references", id(6), { name: "Fluid", activity: "Design", audience: "Teams", personality: "Clear", logoTypes: ["wordmark"], referenceSnapshotId: id(9), sourceProjectRevision: 1 }),
    [id(5)]: stage("vector", id(5), { vectorRevisionId: id(4), approvalId: id(3) }),
    [id(8)]: stage("directions", id(8), { directionIds: overview.directions.map(d => d.id), selectionId: null, approvalId: null }),
  };
  const requests: { path: string; method: string; body: unknown; signal: AbortSignal | null | undefined }[] = [], posts: LogoGenerationIntent[] = [];
  let capabilityReady = options.available !== false;
  let requestStatus = 200, overviewStatus = 200, historyWait: Promise<Response> | null = null;
  let quote: LogoCostQuote | null = null, state: LogoRequestState = { status: "not_found" }, owner = overview.ownerId, sessionWait: Promise<Response> | null = null, admissionWait: Promise<Response> | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : null; requests.push({ path, method, body, signal: init?.signal });
    if (path === "/api/session") return sessionWait ?? json({ user: { id: owner } });
    if (path.endsWith("/capabilities")) { const observed = Date.now(); return json({ ownerId: overview.ownerId, projectId: overview.projectId, observedAt: new Date(observed).toISOString(), operations: Object.fromEntries(logoOperationSchema.options.map(operation => [operation, capabilityReady && operation === "identity.logo_directions" ? { status: "available", expiresAt: new Date(observed + 30_000).toISOString() } : { status: "unavailable" }])) }); }
    if (path.endsWith("/fonts")) return json(fonts);
    if (path.endsWith("/visual-direction")) return json(visual);
    if (path.endsWith("/quotes")) { quote = { id: id(100), ownerId: overview.ownerId, projectId: overview.projectId, request: body, expected: body.expected, inputHash: "a".repeat(64), policyIdentity: "b".repeat(64), handlerVersion: "directions-v1", provider: "synthetic", model: "synthetic-directions", engine: null, estimatedCostMicrousd: 10000, maxCostMicrousd: 25000, externalProviderCostMicrousd: null, expiresAt: "2099-01-01T00:00:00Z", conceptPlan: null, targetSlotIds: [] }; return json(quote); }
    if (path.endsWith("/requests")) {
      posts.push(body);
      const receipt = { ownerId: overview.ownerId, projectId: overview.projectId, requestKey: body.requestKey, operation: "identity.logo_directions" as const, batchId: null, jobIds: [id(101)], inputHash: "a".repeat(64) };
      state = { status: "running", requestKey: body.requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null };
      if (options.lose) throw new Error("Synthetic acknowledgement lost");
      return admissionWait ?? json(receipt);
    }
    if (path.includes("/requests/")) return json(state, requestStatus);
    if (path.endsWith("/logo")) return json(workspace);
    if (path.includes("/directions?")) return path.includes("cursor=") && history ? historyWait ?? json(history, historyStatus) : json(overview, overviewStatus);
    if (path.includes("/reference-snapshots/")) return json({ version: 2, id: id(9), ownerId: overview.ownerId, projectId: overview.projectId, revision: 1, references: [] });
    if (path.includes("/stages/")) return revisions[path.split("/").at(-1)!] ? json(revisions[path.split("/").at(-1)!]) : json({}, 404);
    return json({}, 503);
  };
  vi.stubGlobal("fetch", fetcher);
  let value: IdentityDirectionsController | undefined, memory: LogoDraftMemory | undefined, sessionControl: ReturnType<typeof useAccountSession> | undefined, shown = true;
  function Inner({ client }: { client: ReturnType<typeof createAccountLogoClient> }) { const controller = useIdentityDirections(client, workspace); useLayoutEffect(() => { value = controller; }); return createElement(IdentityDirectionsView, { controller }); }
  function Harness() {
    const context = useAccountSession(), account = context.session.status === "ready" ? context.session : null;
    const client = useMemo(() => account ? createAccountLogoClient(account, overview.projectId, context.isCurrent, context.expire, fetcher) : null, [account, context.isCurrent, context.expire]);
    useEffect(() => () => client?.dispose(), [client]);
    useLayoutEffect(() => { sessionControl = context; memory = context.logoDrafts; });
    return shown && client ? createElement(Inner, { client }) : null;
  }
  const container = document.createElement("div"); document.body.appendChild(container); mounted = createRoot(container);
  const render = async () => { await act(async () => { mounted!.render(createElement(AccountSessionProvider, null, createElement(Harness))); }); };
  await render(); await until(() => { expect(value?.overview).not.toBeNull(); expect(value?.loading).toBe(false); });
  return { container, overview, requests, posts, get controller() { return value!; }, get memory() { return memory!; }, get quote() { return quote; }, get state() { return state; },
    completeDirections() {
      const previous = structuredClone(overview), next = directionFixture();
      next.directions = next.directions.map((d, i) => ({ ...d, id: id(210 + i), name: `Generated direction ${i + 1}`, paletteVersionId: id(220 + i), typographyVersionId: id(230 + i), graphicsVersionId: id(240 + i) }));
      next.palettes = next.palettes.map((d, i) => ({ ...d, id: id(220 + i) }));
      next.typography = next.typography.map((d, i) => ({ ...d, id: id(230 + i) }));
      next.graphics = next.graphics.map((d, i) => ({ ...d, id: id(240 + i) }));
      next.nextCursor = "history"; Object.assign(overview, next); history = previous;
      const revision = { ...stage("directions", id(208), { directionIds: next.directions.map(d => d.id), selectionId: null, approvalId: null }), revision: 2, parentRevisionId: id(8) };
      revisions[id(208)] = revision;
      workspace = { ...workspace, heads: { ...workspace.heads, workspaceRevision: 4, stageRevisions: { ...workspace.heads.stageRevisions, directions: 2 } }, stages: { ...workspace.stages, directions: { stage: "directions", id: id(208), revision: 2 } } };
      if (state.status !== "not_found") state = { ...state, status: "succeeded", billing: { status: "recorded", confirmedMicrousd: 9000 } };
    },
    setHistory(next: IdentityDirectionsOverview, status = 200) { history = next; historyStatus = status; },
    setOverviewStatus(status: number) { overviewStatus = status; },
    pauseHistory() { const pending = deferred<Response>(); historyWait = pending.promise; return pending; },
    setCapabilityReady(value: boolean) { capabilityReady = value; },
    setVisualDirection(next: typeof visual) { visual = next; },
    setRequestStatus(status: number) { requestStatus = status; },
    setState(next: LogoRequestState) { state = next; }, setFonts(next: typeof fonts) { fonts = next; }, setWorkspace(next: LogoWorkspaceV2) { workspace = next; }, get workspace() { return workspace; },
    async navigate(show: boolean) { shown = show; await render(); },
    async reverify(nextOwner = owner) { owner = nextOwner; await act(async () => { sessionControl!.refresh(); }); },
    pauseSession() { const pending = deferred<Response>(); sessionWait = pending.promise; return () => { sessionWait = null; pending.resolve(json({ user: { id: owner } })); }; },
    pauseAdmission() { const pending = deferred<Response>(); admissionWait = pending.promise; return pending; },
  };
}

describe("mounted direction generation admission", () => {
  it("requires review for saved inspiration and invalidates an estimate when reviewed guidance changes", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    const visual = visualOverview({ ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, likes: true });
    f.setVisualDirection(visual);
    await act(async () => { await f.controller.generation!.refreshFonts(); });
    expect(f.controller.generation!.state.canEstimate).toBe(false);
    expect(f.controller.generation!.state.unavailableReason).toContain("Review and save");
    const reviewed = visualOverview({ ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, likes: true, reviewed: true });
    f.setVisualDirection(reviewed);
    await act(async () => { await f.controller.generation!.refreshFonts(); await f.controller.generation!.prepare(); });
    expect(f.quote).not.toBeNull(); expect(f.posts).toHaveLength(0);
    f.setVisualDirection({ ...reviewed, current: { ...reviewed.current!, id: id(700), revision: 2, guidance: { ...reviewed.current!.guidance, colors: "Different color guidance" } }, history: [reviewed.current!] });
    await act(async () => { await f.controller.generation!.confirmQuote(id(100)); });
    expect(f.posts).toHaveLength(0); expect(f.controller.generation!.state.generation.quote).toBeNull();
    expect(f.controller.generation!.state.message).toContain("reviewed visual direction");
  });
  it("prepares a directions-only estimate and requires a separate explicit cost confirmation", async () => {
    const f = await setup();
    await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); });
    expect(f.posts).toHaveLength(0);
    expect(f.quote?.request).toEqual({ operation: "directions", approvedLogoId: id(3), expected: f.workspace.heads });
    expect(f.container.textContent).toContain("Estimated cost");
    expect(f.container.textContent).toContain("Maximum cost");
    expect(f.container.textContent).toContain("Failed provider requests can still incur costs");
    await act(async () => { await Promise.all([f.controller.generation!.confirmQuote(id(100)), f.controller.generation!.confirmQuote(id(100))]); });
    expect(f.posts).toHaveLength(1);
    expect(f.memory.get(id(2))?.pendingIntent).toEqual(f.posts[0]);
    expect(f.posts[0]).toMatchObject({ acceptedMaxCostMicrousd: 25000 });
    expect(f.workspace.approvedLogo?.id).toBe(id(3));
  });
  it("disables quote admission when generation capability or owned font permissions are absent", async () => {
    const f = await setup({ available: false });
    await until(() => expect(f.controller.generation).not.toBeNull());
    await act(async () => { await f.controller.generation!.prepare(); });
    expect(f.controller.generation!.state.canEstimate).toBe(false);
    expect(f.container.textContent).toContain("Identity direction generation is currently unavailable");
    expect(f.requests.some(r => r.path.endsWith("/quotes"))).toBe(false);
    expect(f.posts).toEqual([]);
  });
  it("requires a new explicit estimate after the reviewed font sources change", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); });
    f.setFonts([]);
    await act(async () => { await f.controller.generation!.confirmQuote(id(100)); });
    expect(f.posts).toEqual([]); expect(f.memory.get(id(2))?.pendingIntent).toBeNull();
    expect(f.controller.generation!.state.generation.quote).toBeNull();
    expect(f.container.textContent).toContain("Review a new estimate");
    expect(f.requests.filter(r => r.path.endsWith("/quotes"))).toHaveLength(1);
  });
  it("keeps a lost acknowledgement across navigation and same-owner re-verification without another admission", async () => {
    const f = await setup({ lose: true }); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); await f.controller.generation!.confirmQuote(id(100)); });
    const original = f.memory.get(id(2))!.pendingIntent;
    expect(original).not.toBeNull(); expect(f.posts).toHaveLength(1);
    await f.navigate(false); await f.navigate(true);
    await until(() => expect(f.controller.generation?.state.generation.request?.status).toBe("running"));
    expect(f.memory.get(id(2))?.pendingIntent).toEqual(original);
    const release = f.pauseSession(); await f.reverify();
    expect(f.container.textContent).not.toContain("Synthetic direction 1"); expect(f.memory.get(id(2))).toBeNull();
    await act(async () => release());
    await until(() => expect(f.controller.generation?.state.generation.request?.status).toBe("running"));
    expect(f.memory.get(id(2))?.pendingIntent).toEqual(original); expect(f.posts).toHaveLength(1);
  });
  it("does not let manual mix discard or edits remove a live generation intent", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); await f.controller.generation!.confirmQuote(id(100)); });
    const original = f.memory.get(id(2))!.pendingIntent;
    await act(async () => { await f.controller.preview({ paletteVersionId: id(20), typographyVersionId: id(30), graphicsVersionId: id(40) }); await f.controller.discardAndReload(); });
    expect(f.memory.get(id(2))?.pendingIntent).toEqual(original);
    expect(f.memory.get(id(2))?.directionDraft).toBeFalsy();
    expect(f.controller.canSave).toBe(false); expect(f.posts).toHaveLength(1);
  });
  it("loads retained direction history without changing the current three choices", async () => {
    const f = await setup(); f.overview.nextCursor = "history";
    const older = directionFixture();
    older.directions = older.directions.map((d, i) => ({ ...d, id: id(200 + i), name: `Earlier direction ${i + 1}` }));
    f.setHistory(older);
    await act(async () => { await f.controller.refresh(); });
    expect(f.container.textContent).toContain("Load earlier directions");
    await act(async () => { await f.controller.loadHistory(); });
    expect(f.controller.directionIds).toEqual([id(10), id(11), id(12)]);
    expect(f.container.textContent).toContain("Earlier direction 1");
    expect(f.container.querySelectorAll("button[aria-label^='Choose']")).toHaveLength(3);
    expect(f.memory.get(id(2))?.directionDraft).toBeFalsy(); expect(f.posts).toEqual([]);
  });
  it("shows an empty permitted-font state without quoting or suggesting paid substitutes", async () => {
    const f = await setup({ fonts: false }); await until(() => expect(f.controller.generation?.state.fonts).toEqual([]));
    await act(async () => { await f.controller.generation!.prepare(); });
    expect(f.container.textContent).toContain("No owned fonts");
    expect(f.requests.some(r => r.path.endsWith("/quotes"))).toBe(false); expect(f.posts).toEqual([]);
  });
  it("cancels an estimate without retaining or admitting a generation intent", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); f.controller.generation!.cancelQuote(); });
    expect(f.container.textContent).not.toContain("Confirm and generate 3 directions");
    expect(f.controller.generation!.state.canEstimate).toBe(true);
    expect(f.memory.get(id(2))?.pendingIntent).toBeNull(); expect(f.posts).toEqual([]);
  });
  it("invalidates a quoted estimate when the approved workspace heads change", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); });
    const record = f.memory.get(id(2))!, workspace = { ...f.workspace, heads: { ...f.workspace.heads, projectRevision: 2, workspaceRevision: 4 } };
    f.setWorkspace(workspace);
    await act(async () => { f.memory.set(id(2), { ...record, workspace, base: workspace.heads }); });
    await act(async () => { await f.controller.generation!.confirmQuote(id(100)); });
    expect(f.posts).toEqual([]); expect(f.controller.generation!.state.generation.quote).toBeNull();
    expect(f.memory.get(id(2))?.workspace?.heads.projectRevision).toBe(2);
  });
  it("retains partial output and unknown billing through reconciliation and a failed later read", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); await f.controller.generation!.confirmQuote(id(100)); });
    const original = f.memory.get(id(2))!.pendingIntent, running = f.state;
    if (running.status === "not_found") throw new Error("Fixture request was not admitted");
    const output = { id: id(150), reference: { ownerId: id(1), projectId: id(2), assetId: id(151), versionId: id(152), contentHash: "c".repeat(64) }, verification: { status: "verified" as const, contentHash: "c".repeat(64), mimeType: "image/png", byteLength: 100, checkedAt: "2026-10-07T00:00:00Z" }, purpose: "brand_asset" as const, sourceReceiptId: id(153), rightsEvidenceId: null, publicationState: "committed" as const };
    f.setState({ ...running, status: "needs_reconciliation", outputs: [output], reason: "billing_unknown" });
    await until(() => expect(f.controller.generation?.state.checking).toBe(false));
    await act(async () => { await f.controller.generation!.checkRequest(); });
    expect(f.container.textContent).toContain("1 verified output is retained"); expect(f.container.textContent).toContain("API charge not confirmed");
    expect(f.memory.get(id(2))?.pendingIntent).toEqual(original);
    expect(f.requests.some(r => r.path.endsWith("/reconcile") && r.method === "POST")).toBe(true);
    f.setRequestStatus(503);
    await act(async () => { await f.controller.generation!.checkRequest(); });
    expect(f.controller.generation!.state.generation.request).toMatchObject({ status: "needs_reconciliation", outputs: [output] });
    expect(f.posts).toHaveLength(1);
    f.setRequestStatus(200); f.setState({ ...running, status: "partial", outputs: [output], reason: "incomplete", billing: { status: "recorded", confirmedMicrousd: 8000 } });
    await act(async () => { await f.controller.generation!.checkRequest(); });
    expect(f.memory.get(id(2))?.pendingIntent).toBeNull();
    expect(f.container.textContent).toContain("partial results"); expect(f.container.textContent).toContain("Recorded API charge: $0.008");
    expect(f.controller.directionIds).toEqual([id(10), id(11), id(12)]); expect(f.posts).toHaveLength(1);
  });
  it("does not make a not-found check into another paid request", async () => {
    const f = await setup({ lose: true }); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); await f.controller.generation!.confirmQuote(id(100)); });
    const original = f.memory.get(id(2))!.pendingIntent; f.setState({ status: "not_found" });
    await until(() => expect(f.controller.generation?.state.checking).toBe(false));
    await act(async () => { await f.controller.generation!.checkRequest(); await f.controller.generation!.prepare(); });
    expect(f.posts).toHaveLength(1); expect(f.memory.get(id(2))?.pendingIntent).toEqual(original);
    expect(f.controller.generation!.state.canEstimate).toBe(false);
  });
  it("does not mislabel another pending logo operation as three directions", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); await f.controller.generation!.confirmQuote(id(100)); });
    const current = f.state; if (current.status === "not_found" || !current.receipt || !("operation" in current.receipt)) throw new Error("Fixture request missing");
    f.setState({ ...current, receipt: { ...current.receipt, operation: "identity.logo_refine" } });
    await until(() => expect(f.controller.generation?.state.checking).toBe(false));
    await act(async () => { await f.controller.generation!.checkRequest(); });
    expect(f.container.textContent).not.toContain("Generating three coordinated directions");
    expect(f.container.textContent).toContain("Another logo operation");
  });
  it("keeps loaded history after a failed next page and returns to the preceding page", async () => {
    const f = await setup(); f.overview.nextCursor = "history";
    const older = directionFixture(); older.nextCursor = id(202);
    older.directions = older.directions.map((d, i) => ({ ...d, id: id(200 + i), name: `Earlier direction ${i + 1}` }));
    f.setHistory(older); await act(async () => { await f.controller.refresh(); await f.controller.loadHistory(); });
    // Refresh replaces the read snapshot; the new cursor is observed on the next render.
    await act(async () => { await f.controller.loadHistory(); });
    expect(f.container.textContent).toContain("Earlier direction 1");
    f.setHistory(older, 503); await act(async () => { await f.controller.loadHistory(); });
    expect(f.container.textContent).toContain("Earlier direction 1"); expect(f.controller.history.error).not.toBeNull();
    await act(async () => { await f.controller.loadHistory("previous"); });
    expect(f.container.textContent).not.toContain("Earlier direction 1"); expect(f.controller.directionIds).toHaveLength(3);
  });
  it("fences a different owner from the former owner's cards, cost review and pending intent", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); await f.controller.generation!.confirmQuote(id(100)); });
    await f.reverify(id(999));
    await until(() => { expect(f.memory.get(id(2))).toBeNull(); expect(f.container.textContent).not.toContain("Synthetic direction 1"); });
    expect(f.container.textContent).not.toContain("Recorded API charge"); expect(f.posts).toHaveLength(1);
  });

  it("adopts a completed current set only by refreshing the saved workspace and keeps its predecessor in history", async () => {
    const f = await setup(); const logo = JSON.stringify(f.workspace.approvedLogo);
    await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); await f.controller.generation!.confirmQuote(id(100)); });
    f.completeDirections();
    await until(() => expect(f.controller.generation?.state.checking).toBe(false));
    await act(async () => { await f.controller.generation!.checkRequest(); });
    await until(() => expect(f.controller.directionIds).toEqual([id(210), id(211), id(212)]));
    expect(f.memory.get(id(2))?.pendingIntent).toBeNull(); expect(f.memory.get(id(2))?.workspace?.heads.workspaceRevision).toBe(4);
    expect(f.container.textContent).toContain("Generated direction 3");
    expect(f.container.textContent).toContain("Recorded API charge: $0.009");
    await act(async () => { await f.controller.loadHistory(); });
    expect(f.container.textContent).toContain("Synthetic direction 1");
    expect(JSON.stringify(f.memory.get(id(2))?.workspace?.approvedLogo)).toBe(logo);
    expect(f.posts).toHaveLength(1);
  });
  it("aborts an in-flight admission on navigation while retaining its exact intent for read-only recovery", async () => {
    const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
    await act(async () => { await f.controller.generation!.prepare(); });
    const wait = f.pauseAdmission(); let pending: Promise<void> | undefined;
    await act(async () => { pending = f.controller.generation!.confirmQuote(id(100)); });
    await until(() => expect(f.posts).toHaveLength(1));
    const original = f.memory.get(id(2))!.pendingIntent, admission = f.requests.find(r => r.path.endsWith("/requests"))!;
    expect(admission.signal?.aborted).toBe(false);
    await f.navigate(false); expect(admission.signal?.aborted).toBe(true);
    expect(f.memory.get(id(2))?.pendingIntent).toEqual(original);
    const active = f.state; if (active.status === "not_found") throw new Error("Fixture admission missing");
    await act(async () => { wait.resolve(json(active.receipt)); await pending; });
    await f.navigate(true);
    await until(() => expect(f.controller.generation?.state.generation.request?.status).toBe("running"));
    expect(f.posts).toHaveLength(1); expect(f.memory.get(id(2))?.pendingIntent).toEqual(original);
  });

  it("releases history loading when a refresh interrupts its page read and that refresh fails", async () => {
    const f = await setup(); f.overview.nextCursor = "history"; const older = directionFixture();
    older.directions = older.directions.map((d, i) => ({ ...d, id: id(200 + i), name: `Earlier direction ${i + 1}` })); f.setHistory(older);
    await act(async () => { await f.controller.refresh(); });
    const wait = f.pauseHistory(); let pending: Promise<void> | undefined;
    await act(async () => { pending = f.controller.loadHistory(); });
    await until(() => expect(f.controller.history.loading).toBe(true));
    f.setOverviewStatus(503);
    await act(async () => { await f.controller.refresh(); });
    await act(async () => { wait.resolve(json(older)); await pending; });
    expect(f.controller.history.loading).toBe(false); expect(f.controller.history.canLoadMore).toBe(true);
    expect(f.controller.directionIds).toEqual([id(10), id(11), id(12)]);
  });
  it.each(["saveLogoBrief", "saveLogoEdit"] as const)("preserves a foreign %s request when stale directions offer local discard", async method => {
    const f = await setup(); const record = f.memory.get(id(2))!, requestKey = id(500);
    f.overview.stale = true; const workspace = { ...f.workspace, staleStages: [{ stage: "directions" as const, reasons: ["earlier_brief"] }] }; f.setWorkspace(workspace);
    const command: LogoManualCommand = method === "saveLogoBrief"
      ? { method, body: { requestKey, expected: record.base!, brief: { ...record.brief, name: "Retained brief edit" } } }
      : { method, body: { requestKey, expected: record.base!, baseVectorRevisionId: id(4), edit: { kind: "rotation", componentId: "symbol", degrees: 10 } } };
    await act(async () => { f.memory.set(id(2), { ...record, workspace, pendingMutation: { requestKey, command } }); await f.controller.refresh(); });
    const retained = f.memory.get(id(2))!;
    expect(f.container.textContent).toContain("earlier inputs");
    await act(async () => { await f.controller.discardAndReload(); });
    expect(f.memory.get(id(2))).toEqual(retained);
    expect(f.memory.get(id(2))?.pendingMutation?.command).toEqual(command);
    expect(f.controller.canDiscardDraft).toBe(false); expect(f.controller.canSave).toBe(false); expect(f.posts).toHaveLength(0);
    const release = f.pauseSession(); await f.reverify(); expect(f.memory.get(id(2))).toBeNull();
    await act(async () => release());
    await until(() => expect(f.memory.get(id(2))?.pendingMutation?.command).toEqual(command));
    expect(f.posts).toHaveLength(0);
  });
  it.each(["brief", "vector", "conflict"] as const)("preserves unrelated %s work during an explicit local mix discard", async kind => {
    const f = await setup(), record = f.memory.get(id(2))!;
    const directionDraft = { approvedLogoId: id(3), paletteVersionId: id(20), typographyVersionId: id(30), graphicsVersionId: id(40), reviewedConsistencyHash: null };
    await act(async () => { f.memory.set(id(2), { ...record, directionDraft,
      ...(kind === "brief" ? { dirty: true, brief: { ...record.brief, name: "Unsaved name" } } : kind === "vector" ? { vectorDraft: { baseVectorRevisionId: id(4), edit: { kind: "rotation" as const, componentId: "symbol", degrees: 10 } } } : { conflict: true }) }); });
    const retained = f.memory.get(id(2));
    await act(async () => { await f.controller.discardAndReload(); });
    expect(f.memory.get(id(2))).toEqual(retained); expect(f.controller.canDiscardDraft).toBe(false); expect(f.posts).toHaveLength(0);
  });
  it("discards only an unsent local mix and then reloads without a destructive shared reset", async () => {
    const f = await setup(), record = f.memory.get(id(2))!;
    await act(async () => { f.memory.set(id(2), { ...record, directionDraft: { approvedLogoId: id(3), paletteVersionId: id(20), typographyVersionId: id(30), graphicsVersionId: id(40), reviewedConsistencyHash: null } }); });
    expect(f.controller.canDiscardDraft).toBe(true); expect(f.controller.hasDirectionDraft).toBe(true);
    expect(f.container.textContent).toContain("Discard mix draft and reload");
    await act(async () => { await f.controller.discardAndReload(); });
    expect(f.memory.get(id(2))?.directionDraft).toBeFalsy(); expect(f.memory.get(id(2))?.brief).toEqual(record.brief);
    expect(f.memory.get(id(2))?.workspace?.approvedLogo).toEqual(record.workspace?.approvedLogo); expect(f.posts).toHaveLength(0);
  });

});


it("uses fresh directions-only capability even when historical aggregate generation is unavailable", async () => {
  const f = await setup({ legacyUnavailable: true });
  await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
  await act(async () => { await f.controller.generation!.prepare(); });
  expect(f.quote?.request.operation).toBe("directions"); expect(f.posts).toEqual([]);
});

it("retains a displayed direction quote on readiness loss and resumes only on a later explicit click", async () => {
  const f = await setup(); await until(() => expect(f.controller.generation?.state.canEstimate).toBe(true));
  await act(async () => { await f.controller.generation!.prepare(); }); const original = f.quote;
  f.setCapabilityReady(false);
  await act(async () => { await f.controller.generation!.refreshAvailability(); });
  expect(f.controller.generation!.state.generation.quote).toEqual(original);
  const confirm = [...f.container.querySelectorAll("button")].find(button => button.textContent === "Confirm and generate 3 directions");
  expect(confirm?.disabled).toBe(true);
  await act(async () => { await f.controller.generation!.confirmQuote(id(100)); }); expect(f.posts).toEqual([]);
  f.setCapabilityReady(true); await act(async () => { await f.controller.generation!.refreshAvailability(); });
  expect(f.posts).toEqual([]); await act(async () => { await f.controller.generation!.confirmQuote(id(100)); }); expect(f.posts).toHaveLength(1);
  f.setCapabilityReady(false); await act(async () => { await f.controller.generation!.refreshAvailability(); await f.controller.generation!.checkRequest(); });
  expect(f.controller.generation!.state.generation.request?.status).toBe("running"); expect(f.posts).toHaveLength(1);
});
