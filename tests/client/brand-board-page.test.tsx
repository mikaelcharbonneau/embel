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

const rendered = vi.hoisted(() => ({ snapshots: [] as { name: string; paletteSource: string; logoNeedsReview: boolean }[] }));
// Page lifecycle tests keep the real private preview client. Pixel rendering is
// covered separately by the verified PNG export suite and browser screenshots.
vi.mock("../../src/components/logo-creation/brand-board-preview-export", async original => {
  const actual = await original<typeof import("../../src/components/logo-creation/brand-board-preview-export")>();
  return { ...actual, prepareBoardPreview: async (client: { previewAsset: (receipt: unknown, signal: AbortSignal) => Promise<{ release(): void } | null> }, snapshot: Parameters<typeof actual.prepareBoardPreview>[1], signal: AbortSignal) => {
    const image = await client.previewAsset(snapshot.receipt, signal);
    if (!image) throw new actual.BoardPreviewError("unavailable");
    image.release(); rendered.snapshots.push(snapshot);
    return new Blob(["synthetic page-only raster"], { type: "image/png" });
  } };
});

let root: Root | null = null, host: HTMLDivElement;
const revokeUrl = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  const OriginalURL = URL;
  let nextUrl = 0;
  revokeUrl.mockReset(); rendered.snapshots.length = 0;
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
const previews = () => host.querySelectorAll('[data-brand-board-layout] img');

describe("unified raster Brand Board", () => {
  it("shows one complete image and preserves selected inputs on reload without writes", async () => {
    const f = await fixture(); const before = JSON.stringify(f.f.workspace);
    await mount(f); await until(() => expect(previews()).toHaveLength(1));
    expect(previews()[0]?.getAttribute("alt")).toContain("Élan & Co Brand Board");
    expect(previews()[0]?.getAttribute("alt")).toContain("social post and X header in one image");
    expect(board()?.querySelector("[data-application-mockup]")).toBeNull();
    expect(rendered.snapshots.at(-1)).toMatchObject({ name: "Élan & Co", paletteSource: "saved_inspiration", logoNeedsReview: false });
    expect(f.requests.filter(row => row.path.endsWith("/preview"))).toHaveLength(1);
    await act(async () => root!.unmount()); root = null; await mount(f);
    await until(() => expect(previews()).toHaveLength(1));
    expect(JSON.stringify(f.f.workspace)).toBe(before);
    expect(f.f.selections).toEqual([]); expect(f.f.quotes).toEqual([]); expect(f.f.admissions).toEqual([]);
    expect(f.requests.every(row => row.method === "GET")).toBe(true);
  });
  it.each(["Private creative instructions: do not publish this brief", "Une marque fictive pour le test", ""])("never promotes private brief text into artwork copy: %j", async briefText => {
    const f = await fixture({ briefText }); await mount(f); await until(() => expect(previews()).toHaveLength(1));
    if (briefText) { expect(host.textContent).not.toContain(briefText); expect(JSON.stringify(rendered.snapshots)).not.toContain(briefText); }
    expect(f.f.admissions).toEqual([]);
  });
  it("does not invent artwork when no logo is selected", async () => {
    const f = await fixture({ selected: null }); await mount(f);
    await until(() => expect(host.textContent).toContain("Select a logo to start your brand board."));
    expect(board()).toBeNull(); expect(previews()).toHaveLength(0); expect(rendered.snapshots).toHaveLength(0);
  });
  it("keeps stale selected artwork but clearly flags changed inputs", async () => {
    const f = await fixture({ staleStages: [{ stage: "concepts", reasons: ["input_revision_changed"] }] });
    await mount(f); await until(() => expect(previews()).toHaveLength(1));
    expect(board()?.textContent).toContain("Review changed logo inputs"); expect(rendered.snapshots.at(-1)?.logoNeedsReview).toBe(true);
    expect(f.f.selections).toEqual([]); expect(f.f.workspace.approvedLogo).toBeNull();
  });
  it("uses the exact selected refinement instead of substituting its original", async () => {
    const f = await fixture({ selected: { kind: "refinement", rasterRevisionId: id(503) }, staleStages: [{ stage: "refinements", reasons: ["input_revision_changed"] }] });
    await mount(f); await until(() => expect(previews()).toHaveLength(1));
    expect(f.f.detailReads).toContain(id(503));
    expect(new Set(f.requests.filter(row => row.path.endsWith("/preview")).map(row => row.path))).toEqual(new Set([`/api/assets/${f.f.raster.preview!.reference.versionId}/preview`]));
  });
  it("retains an honest neutral palette when inspiration contains no colors", async () => {
    const f = await fixture({ colors: false }); await mount(f); await until(() => expect(previews()).toHaveLength(1));
    expect(rendered.snapshots.at(-1)?.paletteSource).toBe("neutral_default"); expect(f.inspiration.choices).toEqual([]);
  });
  it("recovers an unreadable selected candidate only through read-only retry", async () => {
    const f = await fixture(); f.controls.candidateAvailable = false; await mount(f);
    await until(() => expect(host.textContent).toContain("Your selected logo could not be loaded."));
    expect(board()).toBeNull(); f.controls.candidateAvailable = true;
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Try again")!.click());
    await until(() => expect(previews()).toHaveLength(1)); expect(f.f.selections).toEqual([]);
  });
  it("does not substitute fake artwork when the private source cannot be read", async () => {
    const f = await fixture(); f.controls.imageAvailable = false; await mount(f);
    await until(() => expect(board()?.textContent).toContain("Brand Board preview unavailable"));
    expect(previews()).toHaveLength(0); expect(f.f.selections).toEqual([]);
  });
  it("does not replace unconfirmed inspiration with a claimed saved proposal", async () => {
    const f = await fixture(); f.controls.inspirationAvailable = false; await mount(f);
    await until(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(board()).toBeNull(); expect(rendered.snapshots).toHaveLength(0);
  });
  it("removes the private raster and revokes its URL when the owner changes", async () => {
    const f = await fixture(); await mount(f); await until(() => expect(previews()).toHaveLength(1));
    const url = previews()[0]!.getAttribute("src"); f.f.owner = id(999);
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Recheck account")!.click());
    await until(() => expect(previews()).toHaveLength(0));
    expect(host.textContent).not.toContain("Élan & Co"); expect(revokeUrl).toHaveBeenCalledWith(url);
  });
});
