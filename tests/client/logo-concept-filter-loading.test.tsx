// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { logoConceptBatchSchema } from "@/domain/logo-jobs";
import { logoMutationReceiptSchema, logoStageRevisionSchema, type LogoWorkspaceV2 } from "@/domain/logo-workspace";
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
// Before the first set, Explore six concepts sits in the logo types question.
const typesQuestion = () => host.querySelector<HTMLElement>("fieldset.logo-types-question")!;
const composer = () => host.querySelector<HTMLFormElement>('form[aria-label="Logo concept changes"]')!;
const instruction = () => composer().querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')!;
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
  expect(composer().querySelector('button[aria-label="Refine"]')!.getAttribute("aria-label")).toBe("Refine");
  expect(composer().querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!.disabled).toBe(true);
  const continuation = [...host.querySelectorAll("button")].find(node => node.textContent === "Continue");
  if (continuation) { expect(continuation.disabled).toBe(true); expect(continuation.title).toBe(message); }
}
// Initial-read cases seed retained local text while focus stays elsewhere.
async function typeInstruction(value: string, focusEditor = false) {
  await act(async () => {
    const input = instruction();
    if (focusEditor) input.focus(); else button("Recheck account").focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function noWrites(f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>) { expect(f.selections).toEqual([]); expect(f.admissions).toEqual([]); }

describe("saved Logo gallery filtering and initial read presentation", () => {
  it("keeps all six verified image nodes and URLs, then clears their bytes on owner change", async () => {
    const { f, fetcher, assetReads } = await sixPreviews(); await mount(f.workspace.projectId, fetcher);
    await until(() => { expect(images()).toHaveLength(6); expect(host.querySelector('img[alt="Selected logo"]')).not.toBeNull(); });
    const before = images(), urls = before.map(image => image.src), reads = [...assetReads];
    expect(new Set(urls).size).toBe(6);
    // The redesigned gallery has no Selected/All filter: all six stay visible and the chosen one is outlined.
    expect(host.textContent).not.toContain("All concepts · 6");
    expect(cards().every(card => !card.hidden)).toBe(true);
    images().forEach((image, ordinal) => expect(image).toBe(before[ordinal])); expect(assetReads).toEqual(reads);
    for (const url of urls) expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
    f.owner = id(9999); await click("Recheck account");
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
      expect(input.value).toBe("Keep this local refinement message"); expect(document.activeElement).toBe(button("Recheck account"));
      cards().forEach((card, index) => expect(card).toBe(initialCards[index]));
      expect(grid().textContent).toContain("Logo chosen");
      expect(input.placeholder).toBe("Describe a change to this logo…");
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
      expect(input.value).toBe("Keep my message after a failed read"); expect(document.activeElement).toBe(button("Recheck account"));
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
      await act(async () => workspace.release()); await until(() => expect(typesQuestion().textContent).toContain("Explore six concepts"));
      expect(host.textContent).toContain("Which logo types should I explore?"); expect(grid().getAttribute("aria-busy")).not.toBe("true"); expect(cards()).toHaveLength(0);
      expect(composer()).toBe(form); expect(instruction()).toBe(input);
      // Before the first set, Embel's message asks the logo-types question instead of "Choose a logo".
      expect(host.textContent).not.toContain("Choose a logo for this project.");
      expect(composer().querySelector('[role="status"]')!.textContent).toBe("Select a logo above to get started.");
      expect(input.placeholder).toBe("Choose a concept, then describe a change…");
      expect(composer().querySelector('button[aria-label="Refine"]')!.getAttribute("aria-label")).toBe("Refine");
      expect(host.querySelector('[aria-label="Generation review"]')).toBeNull(); noWrites(f);
    } finally { await act(async () => { held.release(); workspace.release(); }); }
  });
});

describe("logo types once concepts exist", () => {
  it("lets the types change for the next concepts, then holds Continue until a current concept is chosen", async () => {
    const { f, fetcher: real, base } = await sixPreviews(), saves: { requestKey: string; brief: { logoTypes: string[] } }[] = [];
    let changed: { workspace: LogoWorkspaceV2; revision: unknown } | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/brief` && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)); saves.push(body);
        const prior = await (await real(`${base}/stages/${f.workspace.stages.brief_references!.id}`)).json();
        const revision = logoStageRevisionSchema.parse({ ...prior, id: id(4000), revision: 2, parentRevisionId: prior.id, payload: { ...prior.payload, logoTypes: body.brief.logoTypes } });
        const before = f.workspace, workspace: LogoWorkspaceV2 = { ...before,
          heads: { ...before.heads, workspaceRevision: before.heads.workspaceRevision + 1, stageRevisions: { ...before.heads.stageRevisions, brief_references: 2 } },
          stages: { ...before.stages, brief_references: { stage: "brief_references", id: revision.id, revision: 2 } },
          // The server marks the chosen logo's concepts as made with an earlier brief.
          staleStages: [{ stage: "concepts", reasons: ["input_revision_changed"] }] };
        changed = { workspace, revision };
        return Response.json(logoMutationReceiptSchema.parse({ ownerId: before.ownerId, projectId: before.projectId, requestKey: body.requestKey, workspace, revision }));
      }
      if (changed && path === base) return Response.json(changed.workspace);
      if (changed && path === `${base}/stages/${id(4000)}`) return Response.json(changed.revision);
      return real(input, init);
    };
    await mount(f.workspace.projectId, fetcher);
    await until(() => { expect(images()).toHaveLength(6); expect(grid().textContent).toContain("Logo chosen"); });
    const summary = () => host.querySelector<HTMLElement>('[role="group"][aria-label="Logo types"]');
    expect(typesQuestion()).toBeNull();
    expect(summary()!.textContent).toContain("Wordmark, Lettermark or monogram, Pictorial mark");
    // Without an onContinue handler, a ready Continue is a link to Creative direction.
    const continueLink = () => [...host.querySelectorAll("a")].find(node => node.textContent === "Continue");
    await until(() => expect(continueLink()).toBeDefined());
    await until(() => expect(button("Change logo types").disabled).toBe(false));
    await click("Change logo types");
    expect(typesQuestion().textContent).toContain("After a change, choose your logo from those new concepts");
    const mascot = [...typesQuestion().querySelectorAll("button")].find(node => node.textContent?.startsWith("Mascot"))!;
    expect(mascot.getAttribute("aria-pressed")).toBe("true");
    await act(async () => mascot.click());
    expect(mascot.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
    await until(() => expect(saves).toHaveLength(1));
    expect(saves[0]!.brief.logoTypes).toEqual(["wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem"]);
    await until(() => expect(host.textContent).toContain("Your chosen logo was made with your earlier logo choices."));
    expect(continueLink()).toBeUndefined(); expect(button("Continue").disabled).toBe(true);
    expect(button("Continue").title).toBe("Choose a concept made with your current logo types");
    await click("Done");
    expect(typesQuestion()).toBeNull();
    expect(summary()!.textContent).not.toContain("Mascot");
    expect(f.admissions).toEqual([]);
  });
});
