// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandAssetFixture, logoBytes } from "./fixtures";
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import type { AccountIdentityClient } from "../../../src/components/identity/account-identity-client";
const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("../../../src/features/brand-assets/client/build-pack", () => ({ buildBrandAssetPack: mocks.build }));
import { BrandAssetsPanel } from "../../../src/features/brand-assets/components/brand-assets-panel";

let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.build.mockReset(); });
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = brandAssetFixture(), downloads: string[] = [], revoke = vi.fn(); let current = true;
  const logoClient = createAccountLogoClient(f.account, f.projectId, () => current, vi.fn(), vi.fn());
  const identityClient = { current: () => current } as AccountIdentityClient;
  const pack = { files: [
    { name: "brand-board.png", label: "Brand board", category: "board", mimeType: "image/png", bytes: logoBytes, width: 1600, height: 2200 },
    { name: "logo/logo-original.png", label: "Logo", category: "logo", mimeType: "image/png", bytes: logoBytes },
    { name: "guides/brand-guide.html", label: "Guide", category: "guide", mimeType: "text/html", bytes: new TextEncoder().encode("guide") },
  ], archive: new Uint8Array([1, 2, 3]), vectorIncluded: false };
  mocks.build.mockResolvedValue(pack);
  let number = 0; vi.stubGlobal("URL", class extends URL { static createObjectURL = () => `blob:output-${++number}`; static revokeObjectURL = revoke; });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
  const revalidate = vi.fn(async () => true), container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll("button")].find(node => node.textContent === text)!;
  async function render() { await act(async () => root!.render(createElement(BrandAssetsPanel, { ...f, logoClient, identityClient, revalidate }))); }
  await render();
  return { ...f, container, button, render, revalidate, downloads, revoke, pack, setCurrent(value: boolean) { current = value; } };
}
describe("brand assets panel ownership and selection lifecycle", () => {
  it("starts only on a deliberate click and verifies selection before/after building and before downloading", async () => {
    const f = await setup(); expect(mocks.build).not.toHaveBeenCalled(); expect(f.revalidate).not.toHaveBeenCalled();
    await act(async () => { f.button("Create brand assets").click(); f.button("Create brand assets").click(); });
    expect(mocks.build).toHaveBeenCalledTimes(1); expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(f.container.textContent).toContain("Your brand assets are ready.");
    await act(async () => f.button("Download everything").click());
    expect(f.revalidate).toHaveBeenCalledTimes(3); expect(f.downloads).toEqual(["northline-brand-assets.zip"]);
  });
  it("does not build when the chosen logo or direction changed", async () => {
    const f = await setup(); f.revalidate.mockResolvedValue(false);
    await act(async () => f.button("Create brand assets").click());
    expect(mocks.build).not.toHaveBeenCalled(); expect(f.container.querySelector("[role=alert]")?.textContent).toContain("changed");
  });
  it("discards already prepared files when a download recheck finds another selection", async () => {
    const f = await setup(); await act(async () => f.button("Create brand assets").click());
    f.revalidate.mockResolvedValue(false); await act(async () => f.button("Download everything").click());
    expect(f.downloads).toEqual([]); expect(f.revoke).toHaveBeenCalled(); expect(f.button("Download everything")).toBeUndefined();
    expect(f.container.querySelector("[role=alert]")?.textContent).toContain("changed");
  });
  it("keeps prepared files through a temporary check failure and rechecks before downloading again", async () => {
    const f = await setup(); await act(async () => f.button("Create brand assets").click());
    f.revalidate.mockRejectedValueOnce(new Error("Temporary connection failure"));
    await act(async () => f.button("Download everything").click());
    expect(f.downloads).toEqual([]); expect(f.revoke).not.toHaveBeenCalled();
    expect(f.container.querySelector("[role=alert]")?.textContent).toContain("Your files are kept");
    expect(f.button("Download everything").disabled).toBe(false);
    await act(async () => f.button("Download everything").click());
    expect(f.revalidate).toHaveBeenCalledTimes(4); expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(f.downloads).toEqual(["northline-brand-assets.zip"]);
  });
  it("keeps prepared files after a timed-out check but still rejects a changed selection on retry", async () => {
    vi.useFakeTimers();
    const f = await setup(); await act(async () => f.button("Create brand assets").click());
    f.revalidate.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    await act(async () => f.button("Download everything").click());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(f.button("Download everything").disabled).toBe(false); expect(f.revoke).not.toHaveBeenCalled();
    expect(f.downloads).toEqual([]); expect(mocks.build).toHaveBeenCalledTimes(1);
    f.revalidate.mockResolvedValueOnce(false);
    await act(async () => f.button("Download everything").click());
    expect(f.downloads).toEqual([]); expect(f.revoke).toHaveBeenCalled();
    expect(f.button("Download everything")).toBeUndefined();
    expect(f.container.querySelector("[role=alert]")?.textContent).toContain("changed");
  });
  it("never exposes a completed pack after the account changes during creation", async () => {
    const f = await setup(); let resolve!: (value: unknown) => void; mocks.build.mockReturnValue(new Promise(yes => { resolve = yes; }));
    await act(async () => f.button("Create brand assets").click()); f.setCurrent(false);
    await act(async () => resolve(f.pack)); expect(f.button("Download everything")).toBeUndefined(); expect(f.downloads).toEqual([]);
  });
  it("releases preview URLs when unmounted", async () => {
    const f = await setup(); await act(async () => f.button("Create brand assets").click());
    await act(async () => root!.unmount()); root = null; expect(f.revoke).toHaveBeenCalledWith("blob:output-1");
  });
});
