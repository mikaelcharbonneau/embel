// @vitest-environment jsdom
/** Mounted UI with local transport fixtures, no paid generation or live Storage. */
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogoDownloadControls } from "../../src/components/logo-creation/logo-download-controls";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createVectorHttpFixture, ownerId, projectId } from "../features/logo-vector/http-fixture";

const account = { status: "ready" as const, userId: ownerId, generation: 1 };
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(options: { unsavedChanges?: boolean; vector?: boolean } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  const fixture = createVectorHttpFixture(),
    calls: string[] = [],
    downloads: { href: string; download: string; target: string }[] = [];
  let current = true,
    fail = false,
    unsavedChanges = options.unsavedChanges ?? false,
    vectorRevisionId = options.vector === false ? null : fixture.initial.revision.id;
  let gate: Promise<void> | null = null;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, download: this.download, target: this.target });
  });
  const client = createAccountLogoClient(
    account,
    projectId,
    () => current,
    vi.fn(),
    async (path, init) => {
      calls.push(String(path));
      if (!String(path).endsWith("/download")) return fixture.fetcher(path, init);
      if (gate) await gate;
      if (fail) return new Response(null, { status: 503 });
      const vector = String(path).includes(fixture.initial.revision.svgAsset.versionId),
        reference = vector ? fixture.initial.revision.svgAsset : fixture.preview.reference;
      return Response.json({
        url: `https://private-storage.example/${reference.versionId}?download=logo`,
        versionId: reference.versionId,
        contentHash: reference.contentHash,
        mimeType: vector ? "image/svg+xml" : "image/png",
        expiresInSeconds: 60,
      });
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  async function render() {
    await act(async () =>
      root!.render(
        createElement(LogoDownloadControls, {
          client,
          account,
          projectId,
          vectorRevisionId,
          original: fixture.preview,
          unsavedChanges,
        }),
      ),
    );
  }
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
  await render();
  return {
    fixture,
    calls,
    downloads,
    container,
    render,
    button,
    client,
    setCurrent(value: boolean) {
      current = value;
    },
    setFail(value: boolean) {
      fail = value;
    },
    setUnsaved(value: boolean) {
      unsavedChanges = value;
    },
    setVector(value: string | null) {
      vectorRevisionId = value;
    },
    holdDownload() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
async function until(check: () => void) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 99) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("saved logo download controls", () => {
  it("offers original PNG immediately, with no request until clicked and no acceptance gate", async () => {
    const f = await mount({ vector: false });
    expect(f.calls).toEqual([]);
    expect(f.container.textContent).toContain("Saved original image.");
    expect(f.button("Download PNG").disabled).toBe(false);
    expect(f.button("Download SVG")).toBeUndefined();
    await act(async () => f.button("Download PNG").click());
    await until(() => expect(f.downloads).toHaveLength(1));
    expect(f.calls).toEqual([`/api/assets/${f.fixture.preview.reference.versionId}/download`]);
    expect(f.downloads[0]).toMatchObject({ download: "embel-logo.png", target: "" });
    expect(f.container.querySelector("[role=status]")?.textContent).toContain("PNG download started");
  });

  it("requests the saved SVG once and explains the separate original image", async () => {
    const f = await mount(),
      release = f.holdDownload();
    expect(f.container.textContent).toContain("Original image, before vector edits.");
    await act(async () => {
      f.button("Download SVG").click();
      f.button("Download SVG").click();
    });
    await until(() => expect(f.calls.filter((path) => path.endsWith("/download"))).toHaveLength(1));
    expect(f.button("Preparing SVG…").disabled).toBe(true);
    expect(f.button("Download PNG").disabled).toBe(true);
    await act(async () => release());
    await until(() => expect(f.downloads).toHaveLength(1));
    expect(f.downloads[0]).toMatchObject({ download: "embel-logo.svg", target: "" });
    expect(f.calls.every((path) => !path.includes("/directions") && !path.includes("/exports"))).toBe(true);
  });

  it("blocks exporting unsaved vector changes but keeps the saved original available", async () => {
    const f = await mount({ unsavedChanges: true });
    expect(f.button("Download SVG").disabled).toBe(true);
    expect(f.button("Download PNG").disabled).toBe(false);
    expect(f.container.textContent).toContain("Save or discard your changes before downloading the SVG.");
    await act(async () => f.button("Download SVG").click());
    expect(f.calls).toEqual([]);
    f.setUnsaved(false);
    await f.render();
    expect(f.button("Download SVG").disabled).toBe(false);
  });

  it("keeps the control available to retry a failed download without generating anything", async () => {
    const f = await mount();
    f.setFail(true);
    await act(async () => f.button("Download PNG").click());
    await until(() =>
      expect(f.container.querySelector("[role=alert]")?.textContent).toContain("could not be downloaded"),
    );
    expect(f.downloads).toEqual([]);
    expect(f.button("Download PNG").disabled).toBe(false);
    f.setFail(false);
    await act(async () => f.button("Download PNG").click());
    await until(() => expect(f.downloads).toHaveLength(1));
    expect(f.calls).toHaveLength(2);
    expect(f.container.querySelector("[role=alert]")).toBeNull();
  });

  it.each(["account", "selection", "unsaved", "unmount"])(
    "does not start a delayed download after %s changes",
    async (change) => {
      const f = await mount(),
        release = f.holdDownload();
      await act(async () => f.button("Download SVG").click());
      await until(() => expect(f.calls.filter((path) => path.endsWith("/download"))).toHaveLength(1));
      if (change === "account") f.setCurrent(false);
      else if (change === "selection") {
        f.setVector(null);
        await f.render();
      } else if (change === "unsaved") {
        f.setUnsaved(true);
        await f.render();
      } else {
        await act(async () => root!.unmount());
        root = null;
      }
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(f.downloads).toEqual([]);
    },
  );
});
