// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "../../src/components/workspace/account-session";
import { BrandBoardPage } from "../../src/components/logo-creation/brand-board-page";
import { INSPIRATION_CATALOG_VERSION, inspirationCatalog, type InspirationOverview } from "../../src/domain/inspiration";
import type { LogoRasterSource, LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { logoFixtureId as id } from "../fixtures/logo-creation";

let root: Root | null = null, host: HTMLDivElement;
const revokeUrl = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  const OriginalURL = URL;
  let nextUrl = 0;
  revokeUrl.mockReset();
  vi.stubGlobal("URL", class extends OriginalURL {
    static createObjectURL = () => `blob:synthetic-board-${++nextUrl}`;
    static revokeObjectURL = revokeUrl;
  });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function until(check: () => void) {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    try { check(); return; } catch (error) { failure = error; }
  }
  throw failure;
}
async function fixture({ selected, colors = true, staleStages = [], briefText }: { selected?: LogoRasterSource | null; colors?: boolean; staleStages?: LogoWorkspaceV2["staleStages"]; briefText?: string } = {}) {
  const f = await syntheticRefinementWorkspaceHttp(true);
  const base = `/api/projects/${f.workspace.projectId}`;
  const inspiration: InspirationOverview = {
    ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, projectTitle: "Élan & Co",
    projectScope: "complete_brand", projectRevision: 1, catalogVersion: INSPIRATION_CATALOG_VERSION,
    selectionRevision: colors ? 1 : 0,
    choices: colors ? [{
      ownerId: f.workspace.ownerId, projectId: f.workspace.projectId,
      referenceId: inspirationCatalog.find(row => row.slug === "dropbox-blue-symbol")!.id,
      revision: 1, ensemble: false, elements: ["colors"], updatedAt: "2026-10-18T00:00:00Z",
    }] : [],
  };
  const requests: { path: string; method: string }[] = [];
  const controls = { candidateAvailable: true, imageAvailable: true, inspirationAvailable: true };
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url), "http://127.0.0.1").pathname;
    const method = init?.method ?? "GET";
    requests.push({ path, method });
    // Opening the board, retrying a read and rendering a proposal must never save,
    // select, approve, generate, export or mutate either input library.
    expect(method).toBe("GET");
    if (path === `${base}/inspiration`) return Response.json(controls.inspirationAvailable ? inspiration : {}, { status: controls.inspirationAvailable ? 200 : 503 });
    if (path === `${base}/logo`) return Response.json({ ...f.workspace, staleStages });
    if (!controls.candidateAvailable && path === `${base}/logo/batches/${f.batch.id}`) return Response.json({}, { status: 404 });
    if (!controls.imageAvailable && path.endsWith("/preview")) return new Response(null, { status: 503 });
    const response = await f.fetcher(url, init);
    if (briefText !== undefined && path === `${base}/logo/stages/brief_references/revisions/${f.workspace.stages.brief_references!.id}`) {
      const revision = await response.json();
      return Response.json({ ...revision, payload: { ...revision.payload, activity: briefText, audience: briefText, personality: briefText } });
    }
    if (selected !== undefined && path === `${base}/logo/stages/concepts/revisions/${id(900)}`) {
      const revision = await response.json();
      return Response.json({ ...revision, payload: { ...revision.payload, selected } });
    }
    return response;
  };
  return { f, inspiration, requests, controls, fetcher };
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  vi.stubGlobal("fetch", f.fetcher);
  function Harness() {
    const account = useAccountSession();
    return createElement("main", null,
      createElement("button", { onClick: account.refresh }, "Recheck account"),
      createElement(BrandBoardPage, { projectId: f.f.workspace.projectId }));
  }
  root = createRoot(host);
  await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Harness))));
}
const board = () => host.querySelector("[data-brand-board-layout]");
const previews = () => host.querySelectorAll('img[alt="Selected logo in application preview"]');

describe("saved brand board presentation", () => {
  it("reads the exact saved name and selected preview, distinguishes proposals and survives reload without writes", async () => {
    const f = await fixture();
    const before = JSON.stringify({ workspace: f.f.workspace, batch: f.f.batch, inspiration: f.inspiration });
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    expect(board()?.textContent).toContain("Élan & Co · Saved selection");
    expect(board()?.textContent).toContain("Proposed paletteFrom saved inspiration");
    expect(board()?.textContent).toContain("Proposed typographyGeist Sans · Default preview");
    expect(board()?.textContent?.match(/Application preview/g)).toHaveLength(3);
    expect(board()?.textContent?.match(/Placeholder copy/g)).toHaveLength(2);
    expect(board()?.textContent).not.toContain("Tea shop");
    expect(board()?.textContent).not.toMatch(/\b(?:approved|final|exports?|download|licensed|generated)\b/i);
    expect(board()?.textContent).not.toContain("Review changed inputs");
    expect(host.querySelector('a[href$="/logo"]')?.textContent).toContain("Back to logo concepts");
    const previewPaths = f.requests.filter(row => row.path.endsWith("/preview")).map(row => row.path);
    expect(previewPaths).toHaveLength(4);
    expect(new Set(previewPaths)).toEqual(new Set([`/api/assets/${f.f.batch.slots[0]!.acceptedPreview!.reference.versionId}/preview`]));
    await act(async () => root!.unmount()); root = null;
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    expect(board()?.textContent).toContain("Élan & Co · Saved selection");
    expect(JSON.stringify({ workspace: f.f.workspace, batch: f.f.batch, inspiration: f.inspiration })).toBe(before);
    expect(f.f.selections).toEqual([]);
    expect(f.f.quotes).toEqual([]);
    expect(f.f.admissions).toEqual([]);
    expect(f.requests.every(row => row.method === "GET")).toBe(true);
  });

  it.each([
    "Fictional QA test. Create a warm identity; do not use mountains. Internal instruction token 883.",
    "Une marque fictive pour le test.\nInstructions créatives : ne pas publier ce brief.",
    "Thoughtful everyday goods for everyone.",
    "",
  ])("uses neutral placeholder copy instead of promoting saved brief text: %j", async briefText => {
    const f = await fixture({ briefText });
    const before = JSON.stringify({ workspace: f.f.workspace, batch: f.f.batch, inspiration: f.inspiration });
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    if (briefText) expect(host.textContent).not.toContain(briefText);
    expect(f.requests.some(row => row.path.includes("/stages/brief_references/"))).toBe(true);
    expect(board()?.querySelector('[data-application-mockup="website"] p')?.textContent).toBe("Your brand introduction goes here.");
    expect(board()?.querySelector('[data-application-mockup="social"] h3')?.textContent).toBe("Your announcement goes here.");
    expect(board()?.textContent).toContain("Élan & Co · Saved selection");
    expect(board()?.textContent).toContain("Proposed paletteFrom saved inspiration");
    expect(board()?.textContent).toContain("Geist Sans · Default preview");
    expect(board()?.textContent?.match(/Application preview · Placeholder copy/g)).toHaveLength(2);
    expect(board()?.textContent).not.toMatch(/\b(?:approved|final|exports?|download|licensed|generated)\b/i);
    const previewText = [...host.querySelectorAll("[data-application-mockup]")].map(node => node.textContent);
    await act(async () => root!.unmount()); root = null;
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    expect([...host.querySelectorAll("[data-application-mockup]")].map(node => node.textContent)).toEqual(previewText);
    if (briefText) expect(host.textContent).not.toContain(briefText);
    expect(JSON.stringify({ workspace: f.f.workspace, batch: f.f.batch, inspiration: f.inspiration })).toBe(before);
    expect(f.f.selections).toEqual([]);
    expect(f.f.quotes).toEqual([]);
    expect(f.f.admissions).toEqual([]);
    expect(f.requests.every(row => row.method === "GET")).toBe(true);
  });

  it("does not invent a logo or display proposal applications when no logo is selected", async () => {
    const f = await fixture({ selected: null });
    await mount(f);
    await until(() => expect(host.textContent).toContain("Select a logo to start your brand board."));
    expect(board()).toBeNull();
    expect(previews()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Select a logo");
    expect(f.requests.some(row => row.path.includes("/batches/") || row.path.endsWith("/preview"))).toBe(false);
    expect(f.f.selections).toEqual([]);
  });

  it("keeps the exact stale selection visible and scopes its review guidance to the logo tile", async () => {
    const f = await fixture({ staleStages: [{ stage: "concepts", reasons: ["input_revision_changed"] }] });
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    expect(host.querySelector('[aria-label="Selected brand logo"]')?.textContent).toContain("Saved selection · Review changed inputs");
    expect(board()?.querySelectorAll(":scope > section")).toHaveLength(6);
    expect(board()?.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(f.f.selections).toEqual([]);
    expect(f.f.workspace.approvedLogo).toBeNull();
  });

  it("shows a saved refinement and its stale-input guidance without substituting its original concept", async () => {
    const f = await fixture({ selected: { kind: "refinement", rasterRevisionId: id(503) }, staleStages: [{ stage: "refinements", reasons: ["input_revision_changed"] }] });
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    expect(board()?.textContent).toContain("Saved selection · Review changed inputs");
    expect(f.f.detailReads).toContain(id(503));
    const paths = f.requests.filter(row => row.path.endsWith("/preview")).map(row => row.path);
    expect(new Set(paths)).toEqual(new Set([`/api/assets/${f.f.raster.preview!.reference.versionId}/preview`]));
    expect(f.f.selections).toEqual([]);
  });

  it("labels the fallback palette as a neutral proposal when no color inspiration was saved", async () => {
    const f = await fixture({ colors: false });
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    expect(board()?.textContent).toContain("Proposed paletteNeutral starting point");
    expect(board()?.textContent).not.toContain("From saved inspiration");
    expect(board()?.textContent).toContain("Geist Sans · Default preview");
    expect(f.inspiration.choices).toEqual([]);
  });

  it("keeps an unreadable selection unavailable until its explicit read-only retry succeeds", async () => {
    const f = await fixture(); f.controls.candidateAvailable = false;
    await mount(f);
    await until(() => expect(host.textContent).toContain("Your selected logo could not be loaded."));
    expect(board()).toBeNull();
    expect(previews()).toHaveLength(0);
    f.controls.candidateAvailable = true;
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Try again")!.click());
    await until(() => expect(previews()).toHaveLength(4));
    expect(board()?.textContent).toContain("Saved selection");
    expect(f.f.selections).toEqual([]);
  });

  it("does not substitute fake artwork when the saved private image cannot be read", async () => {
    const f = await fixture(); f.controls.imageAvailable = false;
    const before = JSON.stringify(f.f.batch);
    await mount(f);
    await until(() => expect(board()?.textContent?.match(/Image preview unavailable\. Saved result retained\./g)).toHaveLength(4));
    expect(previews()).toHaveLength(0);
    expect(board()?.textContent).toContain("Saved selection");
    expect(board()?.textContent).toContain("Proposed palette");
    expect(JSON.stringify(f.f.batch)).toBe(before);
    expect(f.f.selections).toEqual([]);
  });

  it("does not replace unconfirmed inspiration with a claimed saved proposal", async () => {
    const f = await fixture(); f.controls.inspirationAvailable = false;
    await mount(f);
    await until(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Retry inspiration"));
    expect(board()).toBeNull();
    expect(host.textContent).not.toContain("Neutral starting point");
    expect(f.f.selections).toEqual([]);
  });

  it("removes the saved name, board and private image URLs when the verified owner changes", async () => {
    const f = await fixture();
    await mount(f);
    await until(() => expect(previews()).toHaveLength(4));
    const urls = [...previews()].map(image => image.getAttribute("src"));
    f.f.owner = id(999);
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Recheck account")!.click());
    await until(() => expect(board()).toBeNull());
    expect(host.textContent).not.toContain("Élan & Co");
    expect(previews()).toHaveLength(0);
    for (const url of urls) expect(revokeUrl).toHaveBeenCalledWith(url);
    expect(f.f.selections).toEqual([]);
  });
});
