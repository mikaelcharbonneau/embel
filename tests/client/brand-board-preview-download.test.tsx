// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandBoardPreviewDownload } from "../../src/components/logo-creation/brand-board-preview-download";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import type { VerifiedAccount } from "../../src/components/workspace/account-session";
import { BoardPreviewError } from "../../src/components/logo-creation/brand-board-preview-export";

const mocks = vi.hoisted(() => ({ current: true, prepare: vi.fn(), recheck: vi.fn() }));
vi.mock("../../src/components/workspace/account-session", () => ({ useAccountSession: () => ({ isCurrent: () => mocks.current }) }));
vi.mock("../../src/components/logo-creation/brand-board-preview-export", async original => ({ ...await original<typeof import("../../src/components/logo-creation/brand-board-preview-export")>(), prepareBoardPreview: mocks.prepare, recheckBoardPreviewLogo: mocks.recheck }));
let host: HTMLDivElement, root: Root, props: Parameters<typeof BrandBoardPreviewDownload>[0];
const click = vi.fn(), createUrl = vi.fn(), revoke = vi.fn();
const blob = new Blob(["synthetic verified PNG"], { type: "image/png" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function render(next = props) { props = next; await act(async () => root.render(createElement(BrandBoardPreviewDownload, props))); }
const download = () => [...host.querySelectorAll("button")][0]!;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.current = true; mocks.prepare.mockReset(); mocks.recheck.mockReset();
  mocks.prepare.mockResolvedValue(blob); mocks.recheck.mockResolvedValue(undefined); click.mockReset(); createUrl.mockReset(); revoke.mockReset(); createUrl.mockReturnValue("blob:download");
  const OriginalURL = URL; vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = createUrl; static revokeObjectURL = revoke; });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { click({ href: this.href, download: this.download }); });
  const f = await syntheticRefinementWorkspaceHttp(true), account: VerifiedAccount = { status: "ready", userId: f.workspace.ownerId, generation: 1 };
  const client = createAccountLogoClient(account, f.workspace.projectId, () => mocks.current, vi.fn(), f.fetcher);
  props = { client, account, projectId: f.workspace.projectId, name: "Élan & Co", logoType: "wordmark", choices: [], receipt: f.batch.slots[0]!.acceptedPreview!, logoNeedsReview: false };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); props.client.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("board preview download lifetime", () => {
  it("enables download only after verification/rendering and keeps production-file claims separate", async () => {
    const pending = deferred<Blob>(); mocks.prepare.mockReturnValue(pending.promise);
    await render(); expect(download().disabled).toBe(true); expect(host.textContent).toContain("Preparing preview…");
    expect(host.textContent).toContain("One PNG"); expect(host.textContent).toContain("not vector masters or an approved brand package");
    await act(async () => pending.resolve(blob));
    expect(download().disabled).toBe(false); expect(download().textContent).toBe("Download board preview (PNG)");
    expect(createUrl).toHaveBeenCalledTimes(1); expect(click).not.toHaveBeenCalled();
  });
  it("contains duplicate clicks, rechecks access, and starts only the prepared snapshot PNG", async () => {
    const pending = deferred<void>(); mocks.recheck.mockReturnValue(pending.promise);
    await render();
    await act(async () => { download().click(); download().click(); });
    expect(mocks.recheck).toHaveBeenCalledTimes(1); expect(click).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(createUrl).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledExactlyOnceWith({ href: "blob:download", download: "elan-co-board-preview.png" });
    expect(host.textContent).toContain("Preview download started");
    expect(document.querySelector('a[download]')).toBeNull();
    await act(async () => root.unmount()); root = createRoot(host);
    expect(revoke).toHaveBeenCalledWith("blob:download");
  });
  it("does not download a cached preview after access is revoked", async () => {
    mocks.recheck.mockRejectedValue(new BoardPreviewError("unavailable")); await render();
    await act(async () => download().click());
    expect(click).not.toHaveBeenCalled(); expect(createUrl).toHaveBeenCalledTimes(1); expect(host.querySelector("figure img")).toBeNull(); expect(download().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("selected image could not be verified");
  });
  it("discards a late download after the verified owner changes", async () => {
    const pending = deferred<void>(); mocks.recheck.mockReturnValue(pending.promise); await render();
    await act(async () => download().click()); mocks.current = false;
    await act(async () => pending.resolve());
    expect(createUrl).toHaveBeenCalledTimes(1); expect(click).not.toHaveBeenCalled();
  });
  it("cancels a late download on metadata/selection change without mixing new text and old artwork", async () => {
    const pending = deferred<void>(); mocks.recheck.mockReturnValue(pending.promise); await render();
    await act(async () => download().click());
    const original = mocks.recheck.mock.calls[0]![1];
    await render({ ...props, name: "Another saved brand", receipt: { ...props.receipt, id: "00000000-0000-4000-8000-000000000099" } });
    expect(mocks.recheck.mock.calls[0]![2].aborted).toBe(true);
    await act(async () => pending.resolve());
    expect(click).not.toHaveBeenCalled(); expect(original.name).toBe("Élan & Co");
    expect(mocks.prepare.mock.calls.at(-1)![1].name).toBe("Another saved brand");
  });
  it("does not publish a late prepared artifact after unmount", async () => {
    const pending = deferred<Blob>(); mocks.prepare.mockReturnValue(pending.promise); await render();
    await act(async () => root.unmount()); root = createRoot(host);
    expect(mocks.prepare.mock.calls[0]![2].aborted).toBe(true);
    await act(async () => pending.resolve(blob));
    expect(host.textContent).toBe(""); expect(click).not.toHaveBeenCalled(); expect(createUrl).not.toHaveBeenCalled();
  });
  it("offers an explicit retry after preparation fails without mutating saved state", async () => {
    mocks.prepare.mockRejectedValueOnce(new BoardPreviewError("font")); await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("board font could not be loaded"); expect(download().disabled).toBe(true);
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry preview")!.click());
    expect(mocks.prepare).toHaveBeenCalledTimes(2); expect(download().disabled).toBe(false); expect(click).not.toHaveBeenCalled();
  });
});
