// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "../../src/components/workspace/account-session";
import { LogoCreationWorkspace } from "../../src/components/logo-creation/logo-creation-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { logoFixtureId as id, syntheticLogoReferences, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import type { LogoDraftMemory } from "../../src/components/identity/logo-draft-memory";

let root: Root | null = null, host: HTMLDivElement, memory: LogoDraftMemory | null = null;
const createUrl = vi.fn(), revokeUrl = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
  const OriginalURL = URL;
  let nextUrl = 0;
  createUrl.mockReset().mockImplementation(() => `blob:synthetic-logo-${++nextUrl}`); revokeUrl.mockReset();
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; };
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host.remove(); memory = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); try { check(); return; } catch (e) { error = e; } } throw error; }
const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label);
const selection = () => host.querySelector<HTMLButtonElement>(`button[aria-label="Select image refinement ${id(503)}"]`);
async function click(label: string) { await until(() => expect(button(label)?.disabled).toBe(false)); await act(async () => button(label)!.click()); }
async function mount(f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>, fetcher: typeof fetch = f.fetcher, mode: "setup" | "refine" = "setup") {
  vi.stubGlobal("fetch", fetcher);
  function Harness() {
    const account = useAccountSession(); useLayoutEffect(() => { memory = account.logoDrafts; });
    return createElement("main", null, createElement("p", null, "Synthetic fixture. No live provider, storage or charges."), createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoCreationWorkspace, { projectId: f.workspace.projectId, mode }));
  }
  root = createRoot(host); await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Harness))));
  await until(() => expect(host.querySelector<HTMLInputElement>('input[aria-label="Brand name"]')?.value).toBe("Élan & Co"));
}
async function fillInstruction() {
  await until(() => expect(host.querySelector('textarea[aria-label="Describe logo changes"]')).not.toBeNull());
  const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe logo changes"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Simplify the silhouette"); field.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("refinement history through actual workspace, account client and memory", () => {
  it("explains an over-limit historical refinement before quoting and keeps all saved references", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true), source = structuredClone(syntheticResolvedLogoConcept()), sample = syntheticLogoReferences()[0]!;
    source.referenceSnapshot.references = Array.from({ length: 4 }, (_, index) => ({ referenceId: id(700 + index), sourceKind: sample.sourceKind,
      rightsEvidenceId: sample.rightsEvidenceId, aspects: sample.aspects, asset: { ...sample.asset, assetId: id(720 + index), versionId: id(740 + index) } }));
    const before = structuredClone(source.referenceSnapshot);
    const fetcher: typeof fetch = (path, init) => String(path).endsWith(`/reference-snapshots/${source.referenceSnapshot.id}`)
      ? Promise.resolve(Response.json(source.referenceSnapshot)) : f.fetcher(path, init);
    await mount(f, fetcher, "refine"); await fillInstruction();
    await until(() => expect(host.querySelector<HTMLButtonElement>('button[aria-label="Refine selected logo"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine selected logo"]')!.click());
    await until(() => expect(host.textContent).toContain("Refinement allows at most 3 references plus the original logo image"));
    expect(host.querySelector('[aria-label="Reference image limits"]')?.textContent).toContain("4 selected reference images");
    expect(memory?.get(f.workspace.projectId)?.references).toHaveLength(4);
    expect(source.referenceSnapshot).toEqual(before); expect(f.quotes).toEqual([]); expect(f.admissions).toEqual([]); expect(f.selections).toEqual([]);
    expect(host.querySelector('img[alt="Selected logo"]')).not.toBeNull();
  });
  it("compares a refinement with its exact original without changing selection or making a quote", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); await mount(f);
    await click("Compare with source");
    const comparison = () => host.querySelector('[aria-label="Compare saved logos"]');
    await until(() => expect(comparison()?.querySelectorAll("img")).toHaveLength(2));
    expect(comparison()?.querySelectorAll('img')[0]?.getAttribute("src")).not.toBe(comparison()?.querySelectorAll('img')[1]?.getAttribute("src"));
    expect(f.selections).toEqual([]); expect(f.quotes).toEqual([]); expect(f.admissions).toEqual([]);
    expect(memory?.get(f.workspace.projectId)?.workspace?.approvedLogo).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Compare concept 2"]')?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Use comparison version 2"]')!.click());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toHaveLength(1); expect(f.selections[0]?.source).toEqual({ kind: "refinement", rasterRevisionId: id(503) });
    expect(f.quotes).toEqual([]); expect(f.admissions).toEqual([]); expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove comparison version 1"]')!.click());
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Compare concept 2"]')?.disabled).toBe(false);
  });

  it("opens the selected concept from an older batch while the newest exploration remains visible", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true), recent = structuredClone(f.batch);
    recent.id = id(980); recent.requestKey = id(981); recent.createdAt = "2026-10-07T12:00:00Z";
    const base = `/api/projects/${f.workspace.projectId}/logo`;
    const fetcher: typeof fetch = async (path, init) => {
      const target = new URL(String(path), "http://127.0.0.1").pathname;
      if (target === `${base}/batches`) return Response.json({ ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, items: [recent, f.batch].map(({ id, requestKey, createdAt }) => ({ id, requestKey, createdAt })), nextCursor: null });
      if (target === `${base}/batches/${recent.id}`) return Response.json(recent);
      return f.fetcher(path, init);
    };
    await mount(f, fetcher, "refine");
    await until(() => expect(host.querySelector('img[alt="Selected logo"]')).not.toBeNull());
    expect(host.querySelector('[aria-label="Logo concepts"] [data-concept-slot]')).not.toBeNull();
    expect([...host.querySelectorAll("select")].find(node => node.value === recent.id)).toBeDefined();
    await fillInstruction();
    await until(() => expect(host.querySelector<HTMLButtonElement>('button[aria-label="Refine selected logo"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine selected logo"]')!.click());
    await until(() => expect(f.admissions).toHaveLength(1));
    expect(f.quotes[0]).toMatchObject({ operation: "refine_preview", source: f.source, instruction: "Simplify the silhouette" });
    expect(f.admissions[0]?.quoteId).toBe(f.lastQuote?.id);
  });

  it("keeps an unverifiable comparison unavailable with explicit read-only retry", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); let rejectSource = false;
    const fetcher: typeof fetch = async (path, init) => rejectSource && String(path).endsWith(`/batches/${f.batch.id}`)
      ? Response.json({}, { status: 404 }) : f.fetcher(path, init);
    await mount(f, fetcher); await until(() => expect(selection()?.disabled).toBe(false)); rejectSource = true;
    await click("Compare with source");
    await until(() => expect(button("Retry reading version 1")).toBeDefined());
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Use comparison version 1"]')?.disabled).toBe(true);
    rejectSource = false; await click("Retry reading version 1");
    await until(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="Use comparison version 1"]')?.disabled).toBe(false));
    expect(f.quotes).toEqual([]); expect(f.admissions).toEqual([]); expect(f.selections).toEqual([]);
  });

  it("removes comparison metadata and private image URLs when the verified account changes", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); await mount(f); await click("Compare with source");
    await until(() => expect(host.querySelectorAll('[aria-label="Compare saved logos"] img')).toHaveLength(2));
    const urls = [...host.querySelectorAll<HTMLImageElement>('[aria-label="Compare saved logos"] img')].map(node => node.src);
    f.owner = id(999); await click("Recheck account");
    await until(() => expect(host.querySelector('[aria-label="Compare saved logos"]')).toBeNull());
    for (const url of urls) expect(revokeUrl).toHaveBeenCalledWith(url);
    expect(f.selections).toEqual([]); expect(f.quotes).toEqual([]); expect(f.admissions).toEqual([]);
  });

  it("completed refinement survives cleared feature memory, exact selection and separate zero-image vector quote", async () => {
    const f = await syntheticRefinementWorkspaceHttp(); await mount(f); await fillInstruction();
    await until(() => expect(host.querySelector<HTMLButtonElement>('button[aria-label="Refine selected logo"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine selected logo"]')!.click());
    await until(() => expect(f.admissions).toHaveLength(1));
    await until(() => expect(f.selections).toHaveLength(1));
    const oldMemory = memory; await act(async () => root!.unmount()); root = null; await mount(f);
    expect(memory).not.toBe(oldMemory); await until(() => expect(selection()?.disabled).toBe(false));
    expect(f.detailReads).toContain(id(503)); await until(() => expect(host.querySelector('img[alt="Image preview of saved logo refinement"]')).not.toBeNull());
    expect(f.workspace.stages.refinements).not.toBeNull(); expect(f.workspace.approvedLogo).toBeNull();
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(host.querySelectorAll('[aria-label="Logo concepts"] ol > li')).toHaveLength(6);
    expect(host.querySelector('select[aria-label="Versions for concept 1"]')?.querySelectorAll("option")).toHaveLength(2);
    expect(f.selections).toHaveLength(1); expect(f.selections[0]?.source).toEqual({ kind: "refinement", rasterRevisionId: id(503) });
    await click("Review conversion"); await until(() => expect(f.quotes.at(-1)?.operation).toBe("vectorize"));
    expect(f.quotes.at(-1)).toMatchObject({ source: { kind: "refinement", rasterRevisionId: id(503) }, expected: f.workspace.heads });
    expect(f.admissions).toHaveLength(1); expect(JSON.stringify(f.batch)).toBe(f.originalBatch); expect(f.workspace.approvedLogo).toBeNull();
    expect(host.querySelector("dialog")?.textContent).toContain(id(503));
    expect(f.raster.preview!.reference.contentHash).not.toBe(f.batch.slots[0]!.acceptedPreview!.reference.contentHash);
    await click("Cancel"); await act(async () => root!.unmount()); root = null; await mount(f);
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true")); expect(f.admissions).toHaveLength(1);
  });
  it("lost selection keeps its exact body/key for explicit check and retry", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); f.loseSelection = true; await mount(f); await until(() => expect(selection()?.disabled).toBe(false));
    await act(async () => selection()!.click()); await until(() => expect(button("Check original selection")).toBeDefined());
    const original = structuredClone(f.selections[0]); expect(memory?.get(f.workspace.projectId)?.pendingMutation?.command).toMatchObject({ method: "selectLogoRaster", body: original });
    await click("Check original selection"); expect(f.selections).toHaveLength(1);
    await click("Retry original selection"); await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toEqual([original, original]); expect(f.admissions).toEqual([]); expect(f.quotes).toEqual([]); expect(memory?.get(f.workspace.projectId)?.pendingMutation).toBeNull();
  });
  it("retains and selects successful history when image generation is unavailable", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); f.imageAvailable = false; await mount(f); await until(() => expect(selection()?.disabled).toBe(false));
    expect(host.textContent).toContain("Confirmed charge: $0.10"); await act(async () => selection()!.click());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(button("Refine selected image refinement")?.disabled).toBe(true); expect(f.admissions).toEqual([]);
  });
  it("history refresh preserves dirty draft values and unresolved request gates", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); await mount(f); await until(() => expect(selection()?.disabled).toBe(false));
    await act(async () => { const draft = memory!.get(f.workspace.projectId)!; memory!.set(f.workspace.projectId, { ...draft, dirty: true, brief: { ...draft.brief, activity: "Keep my local draft" } }); });
    expect(selection()?.disabled).toBe(true); await click("Refresh saved image refinements");
    await until(() => expect(button("Refresh saved image refinements")?.disabled).toBe(false));
    expect(memory!.get(f.workspace.projectId)?.brief.activity).toBe("Keep my local draft"); expect(f.selections).toEqual([]); expect(f.admissions).toEqual([]);
  });
  it("account change fences a delayed detail and releases verified preview URLs", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); let resolve!: (response: Response) => void; let detailSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (path, init) => String(path).endsWith(`/raster-refinements/${id(503)}`)
      ? (detailSignal = init?.signal, new Promise<Response>(yes => { resolve = yes; })) : f.fetcher(path, init);
    await mount(f, fetcher); await until(() => expect(resolve).toBeTypeOf("function")); await until(() => expect(createUrl.mock.results.length).toBeGreaterThan(0));
    const shown = createUrl.mock.results.map(result => result.value); f.owner = id(999); await click("Recheck account");
    await until(() => expect(selection()).toBeNull()); expect(detailSignal?.aborted).toBe(true);
    await act(async () => resolve(Response.json(f.raster))); expect(selection()).toBeNull(); expect(f.selections).toEqual([]);
    for (const url of shown) expect(revokeUrl).toHaveBeenCalledWith(url);
  });
});


it("combined controls quote the exact saved refinement and disclose immutable customized settings in the actual dialog", async () => {
  const f = await syntheticRefinementWorkspaceHttp(true); await mount(f);
  await until(() => expect(selection()?.disabled).toBe(false));
  const mode = host.querySelector<HTMLSelectElement>('select[aria-label="Conversion color mode"]');
  expect(mode, "live conversion color-mode control").not.toBeNull();
  // Merely inspecting a refinement must not replace the saved concept source.
  await click("Review conversion"); await until(() => expect(f.quotes).toHaveLength(1));
  expect(f.quotes[0]).toMatchObject({ operation: "vectorize", source: f.source });
  expect(host.querySelector('dialog [aria-label="Conversion settings"]')?.textContent).toBe("Black and white · Maximum colors 2 · Simplification 0 · Speckle filtering 0");
  await click("Cancel"); await act(async () => selection()!.click());
  await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(mode, "poster"); mode!.dispatchEvent(new Event("change", { bubbles: true })); });
  for (const [label, value] of [["Maximum colors", "6"], ["Simplification", "1.75"], ["Speckle filtering", "3"]]) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  expect(f.quotes).toHaveLength(1); expect(f.admissions).toEqual([]);
  await click("Review conversion"); await until(() => expect(f.quotes).toHaveLength(2));
  expect(f.quotes[1]).toEqual({ operation: "vectorize", expected: f.workspace.heads, source: { kind: "refinement", rasterRevisionId: id(503) }, settings: { preset: "poster", maxColors: 6, simplify: 1.75, filterSpeckle: 3 } });
  expect(host.querySelector('dialog [aria-label="Conversion settings"]')?.textContent).toBe("Poster color · Maximum colors 6 · Simplification 1.75 · Speckle filtering 3");
  expect(host.querySelector("dialog")?.textContent).toContain(id(503)); expect(mode!.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Simplification"]')?.disabled).toBe(true);
  expect(f.admissions).toEqual([]); expect(f.workspace.approvedLogo).toBeNull(); expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
});
