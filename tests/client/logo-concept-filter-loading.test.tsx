// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { logoConceptBatchSchema } from "@/domain/logo-jobs";
import { logoFixtureId as id } from "../fixtures/logo-creation";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";

// Actual account/client/receipt verification with synthetic same-origin HTTP.
// Six distinct owned preview references share fixture PNG bytes. DOM/URL checks,
// not browser raster decoding, keyboard navigation or production visual evidence.
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); let next = 0;
  const NativeURL = URL; vi.stubGlobal("URL", class extends NativeURL { static createObjectURL = vi.fn(() => `blob:gallery-${++next}`); static revokeObjectURL = vi.fn(); });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); try { check(); return; } catch (cause) { error = cause; } } throw error; }
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const grid = () => host.querySelector<HTMLElement>('[aria-label="Logo concepts"]')!;
const images = () => [...(grid()?.querySelectorAll<HTMLImageElement>('img[src^="blob:"]') ?? [])];
const cards = () => [...(grid()?.querySelectorAll<HTMLLIElement>('li[data-concept-ordinal]') ?? [])];
const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function mount(projectId: string, fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  function App() { const account = useAccountSession(); return createElement("main", null, createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoCreationWorkspace, { projectId })); }
  await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
  await until(() => expect(grid()).not.toBeNull());
}
async function sixPreviews() {
  const f = await syntheticRefinementWorkspaceHttp(), base = `/api/projects/${f.workspace.projectId}/logo`;
  const original = f.batch.slots[0]!.acceptedPreview!, version = original.reference.versionId;
  const batch = logoConceptBatchSchema.parse({ ...f.batch, slots: f.batch.slots.map((slot, ordinal) => {
    const preview = { ...original, id: id(3000 + ordinal), sourceReceiptId: id(3100 + ordinal),
      reference: { ...original.reference, assetId: id(3200 + ordinal), versionId: id(3300 + ordinal) } };
    return { ...slot, acceptedPreview: preview, attempts: [{ ...slot.attempts[0]!, state: "succeeded", preview, providerResponseReceiptId: id(3400 + ordinal), reason: null }] };
  }) });
  const versions = new Set(batch.slots.map(slot => slot.acceptedPreview!.reference.versionId)), assetReads: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input).split("?")[0]!;
    if (path === `${base}/batches/${batch.id}`) return Response.json(batch);
    if ([...versions].some(value => path === `/api/assets/${value}/preview`)) { assetReads.push(path); return f.fetcher(`/api/assets/${version}/preview`, init); }
    return f.fetcher(input, init);
  };
  return { f, batch, base, assetReads, fetcher };
}
function expectLoading() {
  expect(grid().textContent).not.toContain("0 of 6 concepts ready");
  expect(grid().textContent).not.toContain("Awaiting your first exploration");
  expect(grid().textContent).toContain("Loading saved concepts…");
  expect(grid().getAttribute("aria-busy")).toBe("true");
  expect(cards()).toHaveLength(6);
  expect([...grid().querySelectorAll("button")].some(node => node.textContent === "Generate six concepts" && !node.disabled)).toBe(false);
}
function noWrites(f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>) { expect(f.selections).toEqual([]); expect(f.quotes).toEqual([]); expect(f.admissions).toEqual([]); }

describe("saved Logo gallery filtering and initial read presentation", () => {
  it("keeps all six verified image nodes and URLs across Selected/All, then clears even hidden bytes on owner change", async () => {
    const { f, fetcher, assetReads } = await sixPreviews(); await mount(f.workspace.projectId, fetcher);
    await until(() => { expect(images()).toHaveLength(6); expect(host.querySelector('img[alt="Selected logo"]')).not.toBeNull(); });
    const before = images(), urls = before.map(image => image.src), reads = [...assetReads];
    expect(new Set(urls).size).toBe(6);
    await click("Selected");
    expect(cards()).toHaveLength(6); expect(cards().filter(card => !card.hidden)).toHaveLength(1);
    expect(cards().filter(card => card.hidden)).toHaveLength(5);
    images().forEach((image, ordinal) => expect(image).toBe(before[ordinal])); expect(assetReads).toEqual(reads);
    for (const url of urls) expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
    await click("All concepts · 6");
    expect(cards().every(card => !card.hidden)).toBe(true); expect(images()).toHaveLength(6);
    images().forEach((image, ordinal) => expect(image).toBe(before[ordinal])); expect(assetReads).toEqual(reads);
    await click("Selected"); f.owner = id(9999); await click("Recheck account");
    await until(() => expect(host.querySelectorAll('img[src^="blob:"]')).toHaveLength(0));
    for (const url of urls) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    noWrites(f);
  });

  it("keeps six truthful loading cards through delayed history, workspace and batch reads before showing saved concepts", async () => {
    const { f, fetcher: real, base, batch } = await sixPreviews(), history = gate(), workspace = gate(), detail = gate();
    let historyReads = 0, workspaceReads = 0, detailReads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/batches`) { historyReads++; await history.promise; }
      if (path === base) { workspaceReads++; await workspace.promise; }
      if (path === `${base}/batches/${batch.id}`) { detailReads++; await detail.promise; }
      return real(input, init);
    };
    try {
      await mount(f.workspace.projectId, fetcher); await until(() => { expect(historyReads).toBeGreaterThan(0); expect(workspaceReads).toBeGreaterThan(0); }); expectLoading();
      await act(async () => history.release()); expectLoading();
      await act(async () => workspace.release()); await until(() => expect(detailReads).toBeGreaterThan(0)); expectLoading();
      await act(async () => detail.release()); await until(() => expect(images()).toHaveLength(6));
      expect(grid().textContent).toContain("6 of 6 concepts ready"); expect(grid().getAttribute("aria-busy")).not.toBe("true"); noWrites(f);
    } finally { await act(async () => { history.release(); workspace.release(); detail.release(); }); }
  });

  it.each(["workspace", "history", "detail"] as const)("shows unavailable instead of first-exploration claims after a failed initial %s read", async failure => {
    const { f, fetcher: real, base, batch } = await sixPreviews(), held = gate(); let reads = 0;
    const emptyWorkspace = { ...f.workspace, heads: { ...f.workspace.heads, workspaceRevision: 1, stageRevisions: { ...f.workspace.heads.stageRevisions, concepts: 0 } }, stages: { ...f.workspace.stages, concepts: null } };
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (failure === "history" && path === base) return Response.json(emptyWorkspace);
      const target = failure === "workspace" ? base : failure === "history" ? `${base}/batches` : `${base}/batches/${batch.id}`;
      if (path === target) { reads++; await held.promise; return Response.json({}, { status: 503 }); }
      return real(input, init);
    };
    try {
      await mount(f.workspace.projectId, fetcher); await until(() => expect(reads).toBeGreaterThan(0)); expectLoading();
      await act(async () => held.release()); await until(() => expect(grid().textContent).toContain("Saved concept details unavailable"));
      expect(grid().textContent).not.toContain("Awaiting your first exploration"); expect(grid().textContent).not.toContain("0 of 6 concepts ready");
      expect(cards()).toHaveLength(6); expect(images()).toHaveLength(0); expect(grid().getAttribute("aria-busy")).not.toBe("true"); noWrites(f);
    } finally { await act(async () => held.release()); }
  });

  it("shows first exploration only after both saved workspace and empty history are confirmed", async () => {
    const { f, fetcher: real, base } = await sixPreviews(), held = gate(), workspace = gate(); let reads = 0, workspaceReads = 0;
    const emptyWorkspace = { ...f.workspace, heads: { ...f.workspace.heads, workspaceRevision: 1, stageRevisions: { ...f.workspace.heads.stageRevisions, concepts: 0 } }, stages: { ...f.workspace.stages, concepts: null } };
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === base) { workspaceReads++; await workspace.promise; return Response.json(emptyWorkspace); }
      if (path === `${base}/batches`) { reads++; await held.promise; return Response.json({ ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, items: [], nextCursor: null }); }
      return real(input, init);
    };
    try {
      await mount(f.workspace.projectId, fetcher); await until(() => { expect(reads).toBeGreaterThan(0); expect(workspaceReads).toBeGreaterThan(0); }); expectLoading();
      await act(async () => held.release()); expectLoading();
      await act(async () => workspace.release()); await until(() => expect(grid().textContent).toContain("Awaiting your first exploration"));
      expect(grid().textContent).toContain("0 of 6 concepts ready"); expect(grid().getAttribute("aria-busy")).not.toBe("true"); expect(cards()).toHaveLength(6); noWrites(f);
    } finally { await act(async () => { held.release(); workspace.release(); }); }
  });
});
