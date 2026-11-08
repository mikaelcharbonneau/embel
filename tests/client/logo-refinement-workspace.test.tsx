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
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); try { check(); return; } catch (e) { error = e; } } throw error; }
const refinementQuotes = (f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>) => f.quotes.filter(quote => quote.operation === "refine_preview");
const lastRefinementQuote = (f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>) => [...f.issuedQuotes.values()].filter(quote => quote.request.operation === "refine_preview").at(-1)!;
const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label);
/** Concept 1 shows its saved refinement; choosing that card's image selects it. */
const selection = () => host.querySelector<HTMLElement>('[aria-label="Logo concepts"] [role="button"][aria-label="Select concept 1"]');
async function click(label: string) { await until(() => expect(button(label)?.disabled).toBe(false)); await act(async () => button(label)!.click()); }
async function mount(f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>, fetcher: typeof fetch = f.fetcher, mode: "setup" | "refine" = "setup") {
  vi.stubGlobal("fetch", fetcher);
  function Harness() {
    const account = useAccountSession(); useLayoutEffect(() => { memory = account.logoDrafts; });
    return createElement("main", null, createElement("p", null, "Synthetic fixture. No live provider, storage or charges."), createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoCreationWorkspace, { projectId: f.workspace.projectId, mode }));
  }
  root = createRoot(host); await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Harness))));
  // The Logo message names the saved brand once the workspace has loaded.
  await until(() => expect(host.querySelector(".logo-conversation-message")?.textContent).toContain("Élan & Co"));
}
async function fillInstruction() {
  await until(() => expect(host.querySelector('textarea[aria-label="Describe a change to this logo"]')).not.toBeNull());
  const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')!;
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
    await until(() => expect(host.textContent).toContain("Refinement allows at most 3 references plus the original logo image"));
    expect(memory?.get(f.workspace.projectId)?.references).toHaveLength(4);
    expect(source.referenceSnapshot).toEqual(before); expect(refinementQuotes(f)).toEqual([]); expect(f.admissions).toEqual([]); expect(f.selections).toEqual([]);
    expect(host.querySelector('img[alt="Selected logo"]')).not.toBeNull();
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
    await fillInstruction();
    await until(() => expect(host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!.click());
    await until(() => expect(f.admissions).toHaveLength(1));
    expect(refinementQuotes(f)[0]).toMatchObject({ operation: "refine_preview", source: f.source, instruction: "Simplify the silhouette" });
    expect(f.admissions[0]?.quoteId).toBe(lastRefinementQuote(f).id);
  });

  it("completed refinement survives cleared feature memory and keeps its exact selection", async () => {
    const f = await syntheticRefinementWorkspaceHttp(); await mount(f); await fillInstruction();
    await until(() => expect(host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!.click());
    await until(() => expect(f.admissions).toHaveLength(1));
    await until(() => expect(f.selections).toHaveLength(1));
    const oldMemory = memory; await act(async () => root!.unmount()); root = null; await mount(f);
    expect(memory).not.toBe(oldMemory); await until(() => expect(selection()).not.toBeNull());
    expect(f.detailReads).toContain(id(503)); await until(() => expect(host.querySelector('img[alt="Selected logo"]')).not.toBeNull());
    expect(f.workspace.stages.refinements).not.toBeNull(); expect(f.workspace.approvedLogo).toBeNull();
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(host.querySelectorAll('[aria-label="Logo concepts"] ol > li')).toHaveLength(6);
    expect(host.querySelector('select[aria-label="Versions for concept 1"]')?.querySelectorAll("option")).toHaveLength(2);
    expect(f.selections).toHaveLength(1); expect(f.selections[0]?.source).toEqual({ kind: "refinement", rasterRevisionId: id(503) });
    expect(f.admissions).toHaveLength(1); expect(JSON.stringify(f.batch)).toBe(f.originalBatch); expect(f.workspace.approvedLogo).toBeNull();
    expect(host.querySelector('dialog[aria-label="Review generation cost"]')).toBeNull();
    expect(f.raster.preview!.reference.contentHash).not.toBe(f.batch.slots[0]!.acceptedPreview!.reference.contentHash);
    await act(async () => root!.unmount()); root = null; await mount(f);
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true")); expect(f.admissions).toHaveLength(1);
  });
  it("lost selection keeps its exact body/key for explicit check and retry", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); f.loseSelection = true; await mount(f); await until(() => expect(selection()).not.toBeNull());
    await act(async () => selection()!.click()); await until(() => expect(button("Check my choice")).toBeDefined());
    const original = structuredClone(f.selections[0]); expect(memory?.get(f.workspace.projectId)?.pendingMutation?.command).toMatchObject({ method: "selectLogoRaster", body: original });
    await click("Check my choice"); expect(f.selections).toHaveLength(1);
    await click("Save my choice again"); await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toEqual([original, original]); expect(f.admissions).toEqual([]); expect(refinementQuotes(f)).toEqual([]); expect(memory?.get(f.workspace.projectId)?.pendingMutation).toBeNull();
  });
  it("waits for acknowledged refinement heads before automatic selection", async () => {
    const f = await syntheticRefinementWorkspaceHttp(); let finish!: () => void;
    const fetcher: typeof fetch = async (path, init) => {
      if (String(path) === `/api/projects/${f.workspace.projectId}/logo` && f.admissions.length && !f.selections.length) {
        await new Promise<void>(resolve => { finish = resolve; });
      }
      return f.fetcher(path, init);
    };
    await mount(f, fetcher); await fillInstruction();
    await until(() => expect(host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!.click());
    await until(() => expect(finish).toBeTypeOf("function"));
    const completedHeads = structuredClone(f.workspace.heads);
    expect(f.selections).toEqual([]); expect(memory?.get(f.workspace.projectId)?.pendingMutation).toBeNull();
    await act(async () => finish());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toHaveLength(1); expect(f.selections[0]?.expected).toEqual(completedHeads);
    expect(f.admissions).toHaveLength(1); expect(refinementQuotes(f)).toHaveLength(1);
  });
  it("does not overwrite a different saved selection observed by the refinement refresh", async () => {
    const f = await syntheticRefinementWorkspaceHttp(); let changedSelection = false;
    const fetcher: typeof fetch = async (path, init) => {
      if (f.admissions.length && !changedSelection && String(path) === `/api/projects/${f.workspace.projectId}/logo`) {
        // A second tab selects a saved version before this tab receives its
        // refreshed baseline. Use the same strict fixture mutation path.
        changedSelection = true;
        await f.fetcher(`/api/projects/${f.workspace.projectId}/logo/rasters/selection`, { method: "POST", body: JSON.stringify({
          requestKey: id(990), expected: f.workspace.heads, source: { kind: "refinement", rasterRevisionId: f.raster.id },
        }) });
      }
      return f.fetcher(path, init);
    };
    await mount(f, fetcher); await fillInstruction();
    await until(() => expect(host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!.click());
    await until(() => expect(changedSelection).toBe(true));
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toHaveLength(1); expect(f.selections[0]?.requestKey).toBe(id(990)); expect(f.admissions).toHaveLength(1);
  });
  it("recovers an absent stale selection without resubmitting, then explicitly selects from fresh heads", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); await mount(f); await until(() => expect(selection()).not.toBeNull());
    // Another committed stage update advances the authoritative workspace after
    // this tab loaded. The strict synthetic server rejects its old CAS body.
    f.publish();
    await act(async () => selection()!.click()); await until(() => expect(button("Check my choice")).toBeDefined());
    const original = structuredClone(f.selections[0]), latestHeads = structuredClone(f.workspace.heads);
    expect(host.textContent).toContain("Your logo changed elsewhere. Check your choice");
    await click("Check my choice");
    await until(() => expect(button("Check my choice")).toBeUndefined());
    expect(host.textContent).toContain("Choose your logo again.");
    expect(f.selections).toEqual([original]); expect(memory?.get(f.workspace.projectId)?.base).toEqual(latestHeads);
    await until(() => expect(selection()).not.toBeNull()); await act(async () => selection()!.click());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toHaveLength(2); expect(f.selections[1]?.expected).toEqual(latestHeads);
    expect(f.selections[1]?.requestKey).not.toBe(original?.requestKey); expect(f.selections[1]?.source).toEqual(original?.source);
    expect(f.admissions).toEqual([]); expect(refinementQuotes(f)).toEqual([]); expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
  });
  it("retains and selects successful history when image generation is unavailable", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); f.imageAvailable = false; await mount(f); await until(() => expect(selection()).not.toBeNull());
    expect(host.textContent).not.toContain("Confirmed charge"); await act(async () => selection()!.click());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.admissions).toEqual([]);
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


const generateButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]');
async function waitForRefinementEstimate() { await until(() => expect(generateButton()?.disabled).toBe(false)); }

describe("one-click refinement", () => {
  it("shows no cost beside Refine and keeps inputs and versions without admission", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); await mount(f); await fillInstruction();
    const originalHeads = structuredClone(f.workspace.heads), originalRecords = structuredClone(f.records);
    await waitForRefinementEstimate();
    const action = generateButton()!.closest('[role="group"]');
    expect(action?.textContent).not.toMatch(/\$|cost|estimat/i);
    expect(refinementQuotes(f)).toHaveLength(1); expect(f.admissions).toEqual([]);
    expect(host.querySelector('dialog[aria-label="Review generation cost"]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')?.value).toBe("Simplify the silhouette");
    expect(f.admissions).toEqual([]); expect(f.selections).toEqual([]); expect(f.workspace.heads).toEqual(originalHeads);
    expect(f.records).toEqual(originalRecords); expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
  });
  it("starts exactly one immutable request on a rapid double click", async () => {
    const f = await syntheticRefinementWorkspaceHttp(); await mount(f); await fillInstruction(); await waitForRefinementEstimate();
    const quote = structuredClone(lastRefinementQuote(f));
    await act(async () => { generateButton()!.click(); generateButton()!.click(); });
    await until(() => expect(f.admissions).toHaveLength(1));
    expect(f.admissions[0]).toMatchObject({ quoteId: quote.id, expected: quote.expected });
    expect(refinementQuotes(f)).toHaveLength(1); expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
  });
  it("Ctrl+Enter deliberately starts the quoted saved refinement; plain Enter does not", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true); await mount(f);
    await until(() => expect(selection()).not.toBeNull()); await act(async () => selection()!.click());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true")); await fillInstruction(); await waitForRefinementEstimate();
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')!;
    await act(async () => { field.focus(); field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(f.admissions).toEqual([]);
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    await until(() => expect(f.admissions).toHaveLength(1));
    expect(refinementQuotes(f)[0]).toMatchObject({ operation: "refine_preview", source: { kind: "refinement", rasterRevisionId: id(503) }, instruction: "Simplify the silhouette" });
    expect(host.querySelector('dialog[aria-label="Review generation cost"]')).toBeNull();
  });
  it("keeps an unknown admission and checks its original intent without generating again", async () => {
    const f = await syntheticRefinementWorkspaceHttp();
    const fetcher: typeof fetch = async (path, init) => {
      if (String(path).endsWith("/requests") && init?.method === "POST") { f.admissions.push(JSON.parse(String(init.body))); throw new Error("Synthetic unknown admission outcome"); }
      return f.fetcher(path, init);
    };
    await mount(f, fetcher); await fillInstruction(); await click("Refine");
    await until(() => expect(button("Check original generation request")).toBeDefined());
    const original = structuredClone(memory?.get(f.workspace.projectId)?.pendingIntent);
    expect(original).toEqual(f.admissions[0]); expect(generateButton()?.disabled).toBe(true);
    await click("Check original generation request");
    expect(memory?.get(f.workspace.projectId)?.pendingIntent).toEqual(original);
    expect(f.admissions).toEqual([original]); expect(refinementQuotes(f)).toHaveLength(1); expect(f.selections).toEqual([]);
    expect(button("Retry original request")).toBeDefined(); expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
  });
  it("quietly prepares a new request when the old one expired, without replacing the instruction or admitting work", async () => {
    const actualNow = Date.now; let time: number | null = null;
    vi.spyOn(Date, "now").mockImplementation(() => time ?? actualNow());
    const f = await syntheticRefinementWorkspaceHttp();
    const fetcher: typeof fetch = async (path, init) => {
      const response = await f.fetcher(path, init);
      if (!String(path).endsWith("/quotes")) return response;
      const quote = await response.json(); quote.expiresAt = new Date(Date.now() + 10_000).toISOString();
      f.issuedQuotes.set(quote.id, quote); return Response.json(quote);
    };
    await mount(f, fetcher); await fillInstruction(); await waitForRefinementEstimate();
    time = Date.parse(lastRefinementQuote(f).expiresAt);
    await act(async () => generateButton()!.click());
    expect(f.admissions).toEqual([]); expect(refinementQuotes(f)).toHaveLength(1); expect(memory?.get(f.workspace.projectId)?.pendingIntent).toBeNull();
    await until(() => expect(refinementQuotes(f)).toHaveLength(2)); expect(f.admissions).toEqual([]); expect(host.textContent).not.toMatch(/estimat/i);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')?.value).toBe("Simplify the silhouette");
  });
});
