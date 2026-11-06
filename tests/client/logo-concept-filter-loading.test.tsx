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
const composer = () => host.querySelector<HTMLFormElement>('form[aria-label="Logo concept changes"]')!;
const instruction = () => composer().querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe logo changes"]')!;
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
function expectInitialPresentation(state: "loading" | "unavailable") {
  const message = state === "loading" ? "Loading saved logo details…" : "Saved logo details unavailable.";
  expect(host.textContent).not.toContain("Choose a logo for this project.");
  expect(host.textContent).not.toContain("Select a logo above to get started.");
  expect(host.querySelector('[aria-label="Generation review"]')).toBeNull();
  expect(composer().querySelector('[role="status"]')?.textContent).toBe(message);
  expect(instruction().placeholder).toBe(message);
  expect(composer().getAttribute("aria-busy")).toBe(String(state === "loading"));
  expect(composer().querySelector('button[aria-label="Generate refinement"]')!.getAttribute("aria-label")).toBe("Generate refinement");
  expect(composer().querySelector<HTMLButtonElement>('button[aria-label="Generate refinement"]')!.disabled).toBe(true);
  const continuation = [...host.querySelectorAll("button")].find(node => node.textContent === "Continue to visual directions →");
  if (continuation) { expect(continuation.disabled).toBe(true); expect(continuation.title).toBe(message); }
}
// Initial-read cases seed retained local text while collapsed. The separate
// background-refresh case below exercises the visible editor and its focus.
async function typeInstruction(value: string, focusEditor = false) {
  await act(async () => {
    const input = instruction();
    if (focusEditor) input.focus(); else composer().querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function noWrites(f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>) { expect(f.selections).toEqual([]); expect(f.admissions).toEqual([]); }

describe("saved Logo gallery filtering and initial read presentation", () => {
  it("keeps the visible refinement editor and keyboard focus through a delayed same-owner refresh", async () => {
    const { f, fetcher: real, base } = await sixPreviews(), held = gate();
    let refreshing = false, reads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).split("?")[0] === base && refreshing) { reads++; await held.promise; }
      return real(input, init);
    };
    try {
      await mount(f.workspace.projectId, fetcher);
      await until(() => expect(images()).toHaveLength(6));
      await click("Refine logo"); await typeInstruction("Keep my visible editor", true);
      const form = composer(), input = instruction();
      expect(input.closest("[hidden]")).toBeNull();
      refreshing = true; await click("Project context"); await click("Refresh saved brand");
      await until(() => expect(reads).toBeGreaterThan(0));
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close project context"]')!.click()); input.focus();
      await act(async () => held.release());
      await until(() => expect(button("Refresh saved brand")?.disabled).toBe(false));
      expect(composer()).toBe(form); expect(instruction()).toBe(input);
      expect(input.closest("[hidden]")).toBeNull(); expect(input.value).toBe("Keep my visible editor");
      expect(document.activeElement).toBe(input); noWrites(f);
    } finally { held.release(); }
  });
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
      await mount(f.workspace.projectId, fetcher); await until(() => { expect(historyReads).toBeGreaterThan(0); expect(workspaceReads).toBeGreaterThan(0); }); expectLoading(); expectInitialPresentation("loading");
      const form = composer(), input = instruction(), status = form.querySelector('[role="status"]'), initialCards = cards();
      await typeInstruction("Keep this local refinement message");
      await act(async () => history.release()); expectLoading(); expectInitialPresentation("loading");
      await act(async () => workspace.release()); await until(() => expect(detailReads).toBeGreaterThan(0)); expectLoading(); expectInitialPresentation("loading");
      await act(async () => detail.release()); await until(() => expect(images()).toHaveLength(6));
      expect(grid().textContent).toContain("6 of 6 concepts ready"); expect(grid().getAttribute("aria-busy")).not.toBe("true");
      expect(composer()).toBe(form); expect(instruction()).toBe(input); expect(form.querySelector('[role="status"]')).toBe(status);
      expect(input.value).toBe("Keep this local refinement message"); expect(document.activeElement).toBe(composer().querySelector('[aria-haspopup="dialog"]'));
      cards().forEach((card, index) => expect(card).toBe(initialCards[index]));
      expect(host.textContent).toContain("Project logo choice saved.");
      expect(input.placeholder).toBe("Describe what you’d like to change…");
      expect(composer().getAttribute("aria-busy")).toBe("false"); noWrites(f);
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
      await mount(f.workspace.projectId, fetcher); await until(() => expect(reads).toBeGreaterThan(0)); expectLoading(); expectInitialPresentation("loading");
      const form = composer(), input = instruction();
      await typeInstruction("Keep my message after a failed read");
      await act(async () => held.release()); await until(() => expect(grid().textContent).toContain("Saved concept details unavailable"));
      expectInitialPresentation("unavailable"); expect(composer()).toBe(form); expect(instruction()).toBe(input);
      expect(input.value).toBe("Keep my message after a failed read"); expect(document.activeElement).toBe(composer().querySelector('[aria-haspopup="dialog"]'));
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
      await mount(f.workspace.projectId, fetcher); await until(() => { expect(reads).toBeGreaterThan(0); expect(workspaceReads).toBeGreaterThan(0); }); expectLoading(); expectInitialPresentation("loading");
      const form = composer(), input = instruction();
      await act(async () => held.release()); expectLoading(); expectInitialPresentation("loading");
      await act(async () => workspace.release()); await until(() => expect(grid().textContent).toContain("Awaiting your first exploration"));
      expect(grid().textContent).toContain("0 of 6 concepts ready"); expect(grid().getAttribute("aria-busy")).not.toBe("true"); expect(cards()).toHaveLength(6);
      expect(composer()).toBe(form); expect(instruction()).toBe(input);
      expect(host.textContent).toContain("Choose a logo for this project.");
      expect(composer().querySelector('[role="status"]')!.textContent).toBe("Select a logo above to get started.");
      expect(input.placeholder).toBe("Select a logo, then describe your changes…");
      expect(composer().querySelector('button[aria-label="Generate refinement"]')!.getAttribute("aria-label")).toBe("Generate refinement");
      expect(host.querySelector('[aria-label="Generation review"]')).toBeNull(); noWrites(f);
    } finally { await act(async () => { held.release(); workspace.release(); }); }
  });

  it("does not reset a confirmed empty composer during a held same-owner workspace refresh", async () => {
    const { f, fetcher: real, base } = await sixPreviews(), held = gate();
    let refresh = false, refreshReads = 0;
    const emptyWorkspace = { ...f.workspace, heads: { ...f.workspace.heads, workspaceRevision: 1, stageRevisions: { ...f.workspace.heads.stageRevisions, concepts: 0 } }, stages: { ...f.workspace.stages, concepts: null } };
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === base) { if (refresh) { refreshReads++; await held.promise; } return Response.json(emptyWorkspace); }
      if (path === `${base}/batches`) return Response.json({ ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, items: [], nextCursor: null });
      return real(input, init);
    };
    try {
      await mount(f.workspace.projectId, fetcher);
      await until(() => expect(grid().textContent).toContain("Awaiting your first exploration"));
      const form = composer(), input = instruction(), status = form.querySelector('[role="status"]');
      await typeInstruction("Keep this draft during an explicit refresh");
      refresh = true; await click("Project context"); await click("Refresh saved brand");
      await until(() => expect(refreshReads).toBeGreaterThan(0));
      expect(composer()).toBe(form); expect(instruction()).toBe(input); expect(form.querySelector('[role="status"]')).toBe(status);
      expect(status!.textContent).toBe("Select a logo above to get started.");
      expect(input.placeholder).toBe("Select a logo, then describe your changes…");
      expect(input.value).toBe("Keep this draft during an explicit refresh");
      expect(composer().getAttribute("aria-busy")).not.toBe("true");
      expect(host.querySelector('[aria-label="Generation review"]')).toBeNull();
      await act(async () => held.release());
      await until(() => expect(button("Refresh saved brand")).toBeDefined());
      expect(composer()).toBe(form); expect(instruction()).toBe(input); noWrites(f);
    } finally { await act(async () => held.release()); }
  });
});
