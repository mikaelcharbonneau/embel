// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "../../../src/components/workspace/account-session";
import { LogoEditorWorkspace } from "../../../src/features/logo-vector/components/logo-editor-workspace";
import type { LogoVectorHistoryPage } from "../../../src/features/logo-vector/model/history";
import { createVectorHttpFixture, source, ownerId, projectId, base } from "./http-fixture";
import { dispatchLogoComparisonLoads } from "./preview-events";

/** Synthetic mounted DOM with the real account session, bound client and editor.
 * No browser, hosted service, provider, image quality or mobile claim. */
describe("retained vector discovery and explicit review", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
    URL.createObjectURL = vi.fn(() => `blob:synthetic-history-${Math.random()}`); URL.revokeObjectURL = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function until(test: () => boolean) { for (let i = 0; i < 80 && !test(); i++) await act(async () => { dispatchLogoComparisonLoads(host); await new Promise(resolve => setTimeout(resolve, 10)); }); expect(test(), host.textContent ?? "DOM state").toBe(true); }
  const button = (name: string) => [...host.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === name || node.textContent === name) as HTMLButtonElement | undefined;
  async function click(name: string) { await until(() => button(name)?.disabled === false); await act(async () => button(name)!.click()); }
  async function mount(change?: (fixture: ReturnType<typeof createVectorHttpFixture>, page: LogoVectorHistoryPage) => { fetcher?: typeof fetch } | void) {
    const f = createVectorHttpFixture(), candidate = structuredClone(f.initial);
    candidate.revision.id = "00000000-0000-4000-8000-000000000998";
    candidate.revision.createdAt = "2026-10-07T00:00:02Z"; f.details.set(candidate.revision.id, candidate);
    const page: LogoVectorHistoryPage = { ownerId, projectId, workspaceRevision: 2, items: [{ vectorRevisionId: candidate.revision.id, parentRevisionId: null, createdAt: candidate.revision.createdAt,
      source: candidate.revision.source, lockCount: 0, selection: "retained", acceptance: "unaccepted", earlierInputs: false, cancellation: "cancelled", stageRevision: null }], nextCursor: null };
    const override = change?.(f, page);
    const historyReads: string[] = [];
    const fetcher: typeof fetch = async (input, options) => {
      const path = String(input); if (path.startsWith(`${base}/vector/history?`)) { historyReads.push(path); return override?.fetcher ? override.fetcher(input, options) : Response.json({ ...page, workspaceRevision: f.state.workspace.heads.workspaceRevision }); }
      return f.fetcher(input, options);
    };
    vi.stubGlobal("fetch", fetcher);
    function App() { const account = useAccountSession(); return createElement("div", null, createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoEditorWorkspace, { projectId: source.input.projectId })); }
    await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
    await until(() => !!host.querySelector('svg[aria-label="Vector candidate"]'));
    return { f, candidate, page, historyReads };
  }
  it("discovers a cancelled off-head vector, opens it read-only, and accepts only on an explicit click", async () => {
    const { f, candidate } = await mount();
    await click(`Open saved vector ${candidate.revision.id}`);
    await until(() => host.textContent!.includes("Saved vector for review") && button("Accept this vector")?.disabled === false);
    expect(host.textContent).toContain("Cancelled conversion"); expect(host.textContent).toContain("Not accepted");
    expect(f.state.posts).toHaveLength(0); expect(f.state.currentVectorId).toBe(f.initial.revision.id);
    expect(button("Save edit")?.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Component rotation"]')!.closest("fieldset")!.disabled).toBe(true);
    await click("Back to current vector"); await until(() => !host.textContent!.includes("Saved vector for review")); expect(f.state.posts).toHaveLength(0);
    await click(`Open saved vector ${candidate.revision.id}`); await click("Accept this vector");
    await until(() => f.state.posts.length === 1 && f.state.currentVectorId === candidate.revision.id);
    expect(f.state.posts[0]!.body).toMatchObject({ vectorRevisionId: candidate.revision.id, acceptEarlierBasis: false });
  });
  it("requires the existing earlier-basis acknowledgement before accepting a retained candidate", async () => {
    const { f, candidate } = await mount((fixture, page) => {
      const detail = fixture.details.get(page.items[0]!.vectorRevisionId)!; detail.revision.inputRevisions[0]!.id = "00000000-0000-4000-8000-000000000999";
      page.items[0]!.earlierInputs = true;
    });
    await click(`Open saved vector ${candidate.revision.id}`); await until(() => !!host.querySelector('input[type="checkbox"]'));
    expect(button("Accept this vector")!.disabled).toBe(true); expect(f.state.posts).toHaveLength(0);
    await act(async () => (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click()); await click("Accept this vector");
    await until(() => f.state.posts.length === 1); expect(f.state.posts[0]!.body).toMatchObject({ acceptEarlierBasis: true });
  });
  it("paginates without writes and rejects a different workspace projection", async () => {
    let reads = 0;
    const { f } = await mount((_fixture, page) => ({ fetcher: async () => {
      reads++; return Response.json(reads === 1 ? { ...page, nextCursor: "e30=" } : { ...page, workspaceRevision: 3, nextCursor: null });
    } }));
    await click("Earlier vector candidates"); await until(() => host.textContent!.includes("Choose Refresh to see your saved vectors"));
    expect(button("Earlier vector candidates")).toBeUndefined(); expect(f.state.posts).toHaveLength(0);
  });
  it("can return to latest while an earlier page is pending and ignores the abandoned response", async () => {
    let reads = 0, release!: (response: Response) => void;
    const { page, f } = await mount((_fixture, value) => ({ fetcher: async () => {
      reads++;
      if (reads === 2) return new Promise(resolve => { release = resolve; });
      return Response.json({ ...value, nextCursor: "e30=" });
    } }));
    await click("Earlier vector candidates"); await until(() => reads === 2);
    await click("Latest vector candidates"); await until(() => reads === 3);
    await act(async () => release(Response.json({ ...page, workspaceRevision: 99 })));
    expect(host.textContent).not.toContain("Your workspace changed."); expect(button("Latest vector candidates")).toBeUndefined(); expect(f.state.posts).toHaveLength(0);
  });
  it("never displays a late former-account history result", async () => {
    let release!: (response: Response) => void;
    const { f, page, candidate } = await mount(() => ({ fetcher: () => new Promise(resolve => { release = resolve; }) }));
    f.state.owner = "99999999-9999-4999-8999-999999999999"; await click("Recheck account");
    await until(() => !host.querySelector('svg[aria-label="Vector candidate"]'));
    await act(async () => release(Response.json(page)));
    expect(button(`Open saved vector ${candidate.revision.id}`)).toBeUndefined(); expect(host.textContent).not.toContain("Cancelled conversion");
  });
  it("reloads off-head discovery even when no workspace head changed", async () => {
    let reads = 0;
    const { candidate } = await mount((_fixture, page) => ({ fetcher: async () => {
      reads++; return Response.json(reads === 1 ? { ...page, items: [] } : page);
    } }));
    await until(() => host.textContent!.includes("No saved vector candidates."));
    await click("Refresh"); await until(() => !!button(`Open saved vector ${candidate.revision.id}`));
    expect(reads).toBe(2);
  });
  it("checks a stage-backed vector pointer before exposing restoration", async () => {
    const { f, candidate } = await mount((_fixture, page) => { page.items[0]!.stageRevision = { stage: "vector", id: "00000000-0000-4000-8000-000000000610", revision: 1 }; });
    await click(`Open saved vector ${candidate.revision.id}`); await until(() => host.textContent!.includes("saved vector could not be verified"));
    expect(host.querySelector('svg[aria-label="Vector candidate"]')).toBeNull(); expect(button("Restore this version")?.disabled ?? true).toBe(true); expect(f.state.posts).toHaveLength(0);
    await click("Back to current vector"); await until(() => !!host.querySelector('svg[aria-label="Vector candidate"]'));
  });
});
