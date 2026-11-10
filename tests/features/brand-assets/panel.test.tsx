// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandAssetFixture, logoBytes } from "./fixtures";
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import type { AccountIdentityClient } from "../../../src/components/identity/account-identity-client";
import type { VerifiedAccount } from "../../../src/components/workspace/account-session";
import type { PreparedBrandAssets } from "../../../src/features/brand-assets/client/build-pack";
import { BrandAssetError } from "../../../src/features/brand-assets/model/snapshot";
import { brandPaletteFiles } from "../../../src/features/brand-assets/model/guides";

const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("../../../src/features/brand-assets/client/build-pack", () => ({ buildBrandAssetPack: mocks.build }));
import { BrandAssetsPanel } from "../../../src/features/brand-assets/components/brand-assets-panel";

let root: Root | null = null;
async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = null;
}
afterEach(async () => {
  await unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.build.mockReset();
});

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = brandAssetFixture(),
    downloads: string[] = [],
    urls: string[] = [],
    revoke = vi.fn();
  let current = true;
  const logoClient = createAccountLogoClient(f.account, f.projectId, () => current, vi.fn(), vi.fn());
  const identityClient = { current: () => current } as AccountIdentityClient;
  const getArchive = vi.fn(() => new Uint8Array([1, 2, 3]));
  const pack: PreparedBrandAssets = {
    files: [
      {
        name: "brand-board.png",
        label: "Brand board",
        category: "board",
        mimeType: "image/png",
        bytes: logoBytes,
        width: 1600,
        height: 2200,
      },
      { name: "logo/logo-original.png", label: "Logo", category: "logo", mimeType: "image/png", bytes: logoBytes },
      {
        name: "social/profile.png",
        label: "Profile image",
        category: "social",
        mimeType: "image/png",
        bytes: logoBytes,
        width: 1024,
        height: 1024,
      },
      {
        name: "guides/brand-guide.html",
        label: "Guide",
        category: "guide",
        mimeType: "text/html",
        bytes: new TextEncoder().encode("guide"),
      },
    ],
    getArchive,
    vectorIncluded: false,
  };
  mocks.build.mockResolvedValue(pack);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        const url = `blob:output-${urls.length + 1}`;
        urls.push(url);
        return url;
      }
      static revokeObjectURL = revoke;
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  const revalidate = vi.fn<(signal: AbortSignal) => Promise<boolean>>().mockResolvedValue(true);
  const refreshSelection = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (node) => (node.getAttribute("aria-label") ?? node.textContent)?.trim() === label,
    );
  const alert = () => container.querySelector("[role=alert]")?.textContent;
  async function render(account: VerifiedAccount = f.account, strict = false) {
    const panel = createElement(BrandAssetsPanel, {
      ...f,
      account,
      logoClient,
      identityClient,
      revalidate,
      onRefreshSelection: refreshSelection,
    });
    await act(async () => root!.render(strict ? createElement(StrictMode, null, panel) : panel));
  }
  async function download(clicks = 1) {
    const action = button("Download brand kit");
    expect(action?.disabled).toBe(false);
    await act(async () => {
      for (let i = 0; i < clicks; i++) action!.click();
    });
  }
  return {
    ...f,
    container,
    pack,
    getArchive,
    render,
    download,
    revalidate,
    refreshSelection,
    downloads,
    urls,
    revoke,
    button,
    alert,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}

describe("brand kit palette", () => {
  it("confirms a swatch only after the write succeeds and clears its feedback", async () => {
    vi.useFakeTimers();
    const write = pending<void>();
    const writeText = vi.fn(() => write.promise);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const f = setup();
    await f.render();
    const color = f.snapshot.colors[0]!;
    const swatch = f.button(`Copy ${color.name} ${color.hex}`)!;
    await act(async () => swatch.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(color.hex);
    expect(swatch.textContent).not.toContain("Copied");
    await act(async () => write.resolve());
    expect(swatch.textContent).toContain("Copied");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(swatch.textContent).toContain(color.hex);
  });

  it("offers the exported CSS for manual copying when clipboard access is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const f = setup();
    await f.render();
    await act(async () => f.button("Copy CSS palette")!.click());
    const expected = new TextDecoder().decode(brandPaletteFiles(f.snapshot).css);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(f.container.querySelector("textarea")?.value).toBe(expected);
    expect(f.button("Copy CSS palette")?.textContent).not.toContain("Copied");
  });
});

describe("one-click brand kit and selection ownership", () => {
  it("automatically prepares only after checking the saved selection, checks again before publishing previews, and waits for a download click", async () => {
    const f = setup(),
      before = pending<boolean>(),
      after = pending<boolean>();
    f.revalidate.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
    await f.render();
    expect(f.button("Create brand assets")).toBeUndefined();
    expect(f.revalidate).toHaveBeenCalledTimes(1);
    expect(mocks.build).not.toHaveBeenCalled();
    await act(async () => before.resolve(true));
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(f.urls).toHaveLength(0);
    await act(async () => after.resolve(true));
    expect(f.urls.length).toBeGreaterThan(0);
    expect(f.downloads).toEqual([]);
    expect(f.getArchive).not.toHaveBeenCalled();
    const downloadCheck = pending<boolean>();
    f.revalidate.mockReturnValueOnce(downloadCheck.promise);
    await f.download();
    expect(f.downloads).toEqual([]);
    expect(f.revalidate).toHaveBeenCalledTimes(3);
    await act(async () => downloadCheck.resolve(true));
    expect(f.getArchive).toHaveBeenCalledTimes(1);
    expect(f.downloads).toEqual(["northline-brand-assets.zip"]);
  });

  it("joins an in-flight automatic build and emits one archive for two quick clicks", async () => {
    const f = setup(),
      building = pending<PreparedBrandAssets>();
    mocks.build.mockReturnValueOnce(building.promise);
    await f.render();
    expect(mocks.build).toHaveBeenCalledTimes(1);
    await f.download(2);
    expect(f.downloads).toEqual([]);
    await act(async () => building.resolve(f.pack));
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(f.revalidate).toHaveBeenCalledTimes(3);
    expect(f.getArchive).toHaveBeenCalledTimes(1);
    expect(f.downloads).toEqual(["northline-brand-assets.zip"]);
  });

  it("prepares once across Strict Mode effect replay and a rerender with the same saved sources", async () => {
    const f = setup();
    await f.render(f.account, true);
    await f.render(f.account, true);
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(f.urls.length).toBeGreaterThan(0);
    expect(f.downloads).toEqual([]);
  });

  it("does not read sources when the selected direction is already stale", async () => {
    const f = setup();
    f.revalidate.mockResolvedValue(false);
    await f.render();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(f.alert()).toMatch(/changed|selection|direction/i);
    expect(f.urls).toHaveLength(0);
    expect(f.downloads).toEqual([]);
  });

  it("rejects the queued download if the chosen source changes before the build finishes", async () => {
    const f = setup(),
      building = pending<PreparedBrandAssets>();
    mocks.build.mockReturnValueOnce(building.promise);
    f.revalidate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await f.render();
    await f.download();
    await act(async () => building.resolve(f.pack));
    expect(f.urls).toHaveLength(0);
    expect(f.downloads).toEqual([]);
    expect(f.alert()).toMatch(/changed|selection|direction/i);
  });

  it("discards prepared previews when the final download check detects another selection", async () => {
    const f = setup();
    await f.render();
    const previews = [...f.urls];
    expect(previews.length).toBeGreaterThan(0);
    f.revalidate.mockResolvedValueOnce(false);
    await f.download();
    expect(f.downloads).toEqual([]);
    expect(f.urls).toEqual(previews);
    expect(f.getArchive).not.toHaveBeenCalled();
    for (const url of previews) expect(f.revoke).toHaveBeenCalledWith(url);
    expect(f.alert()).toMatch(/changed|selection|direction/i);
    expect(f.button("Download brand kit")).toBeUndefined();
    await act(async () => f.button("Refresh kit")!.click());
    expect(f.refreshSelection).toHaveBeenCalledOnce();
  });

  it("revalidates an individual guide download without compressing the archive", async () => {
    const f = setup(),
      check = pending<boolean>();
    await f.render();
    f.revalidate.mockReturnValueOnce(check.promise);
    await act(async () => f.button("Download guidelines")!.click());
    expect(f.downloads).toEqual([]);
    await act(async () => check.resolve(true));
    expect(f.downloads).toEqual(["brand-guide.html"]);
    expect(f.getArchive).not.toHaveBeenCalled();
    expect(mocks.build).toHaveBeenCalledTimes(1);
  });

  it("retries a failed source read with Download brand kit and delivers on that single click", async () => {
    const f = setup();
    mocks.build.mockRejectedValueOnce(new BrandAssetError("source"));
    await f.render();
    expect(f.alert()).toBeTruthy();
    expect(f.downloads).toEqual([]);
    expect(f.urls).toHaveLength(0);
    await f.download();
    expect(mocks.build).toHaveBeenCalledTimes(2);
    expect(f.downloads).toEqual(["northline-brand-assets.zip"]);
  });

  it("keeps prepared files through a transient download check failure and verifies them again on retry", async () => {
    const f = setup();
    await f.render();
    f.revalidate.mockRejectedValueOnce(Error("Temporary connection failure"));
    await f.download();
    expect(f.alert()).toBeTruthy();
    expect(f.downloads).toEqual([]);
    expect(f.revoke).not.toHaveBeenCalled();
    await f.download();
    expect(f.revalidate).toHaveBeenCalledTimes(4);
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(f.downloads).toEqual(["northline-brand-assets.zip"]);
  });

  it("times out a stalled download check, retains previews, and rejects a changed selection on retry", async () => {
    vi.useFakeTimers();
    const f = setup(),
      stalled = pending<boolean>();
    await f.render();
    const previews = [...f.urls];
    f.revalidate.mockReturnValueOnce(stalled.promise);
    await f.download();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(f.button("Download brand kit")?.disabled).toBe(false);
    expect(f.revoke).not.toHaveBeenCalled();
    expect(f.downloads).toEqual([]);
    f.revalidate.mockResolvedValueOnce(false);
    await f.download();
    await act(async () => stalled.resolve(true));
    expect(f.downloads).toEqual([]);
    for (const url of previews) expect(f.revoke).toHaveBeenCalledWith(url);
    expect(mocks.build).toHaveBeenCalledTimes(1);
  });

  it.each(["unmount", "account change"] as const)(
    "cancels a queued download and revokes its previews on %s",
    async (interruption) => {
      const f = setup(),
        building = pending<PreparedBrandAssets>(),
        lastCheck = pending<boolean>();
      mocks.build.mockReturnValueOnce(building.promise);
      f.revalidate.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockReturnValueOnce(lastCheck.promise);
      await f.render();
      await f.download();
      await act(async () => building.resolve(f.pack));
      const previews = [...f.urls],
        lastSignal = f.revalidate.mock.calls[2]?.[0];
      expect(lastSignal?.aborted).toBe(false);
      expect(previews.length).toBeGreaterThan(0);
      if (interruption === "unmount") await unmount();
      else {
        f.setCurrent(false);
        await f.render({ ...f.account, generation: f.account.generation + 1 });
      }
      expect(lastSignal?.aborted).toBe(true);
      await act(async () => lastCheck.resolve(true));
      expect(f.urls).toEqual(previews);
      for (const url of previews) expect(f.revoke).toHaveBeenCalledWith(url);
      expect(f.downloads).toEqual([]);
    },
  );

  it("never exposes a pack after its account stops being current during preparation", async () => {
    const f = setup(),
      building = pending<PreparedBrandAssets>();
    mocks.build.mockReturnValueOnce(building.promise);
    await f.render();
    await f.download();
    f.setCurrent(false);
    await act(async () => building.resolve(f.pack));
    expect(f.urls).toHaveLength(0);
    expect(f.downloads).toEqual([]);
  });
});
