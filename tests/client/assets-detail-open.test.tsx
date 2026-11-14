// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import type { useAssetLibrary } from "@/components/assets/use-asset-library";

type Library = ReturnType<typeof useAssetLibrary>;
const fixture = vi.hoisted(() => ({ library: null as unknown as Library }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: { status: "ready", userId: "owner-a", generation: 1 } }),
  AccountStatus: () => null,
}));
vi.mock("@/components/assets/use-asset-library", () => ({ useAssetLibrary: () => fixture.library }));
vi.mock("@/components/assets/asset-preview", () => ({ AssetPreview: () => null }));

let root: Root, host: HTMLDivElement;
const dialogMethods = ["showModal", "close"] as const;
const originals = dialogMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no native dialog. Like a browser, close() reports itself with a
  // queued `close` event, so it arrives after the effect that called it.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      setTimeout(() => this.dispatchEvent(new Event("close")), 0);
    },
  });
  fixture.library = {
    client: { current: () => true, detail: () => new Promise(() => {}) },
    query: { tab: "my_selection", limit: 40 },
    page: {
      query: { tab: "my_selection", limit: 40 },
      items: [
        {
          asset: {
            id: "asset-a",
            kind: "Brand board",
            versionCount: 1,
            usage: { active: false, legacy: false },
            currentSelection: null,
            saved: true,
            liked: false,
          },
          project: { id: "project-a", title: "Fixture brand" },
          displayedVersion: null,
          selectedVersion: null,
          matchingVersions: { totalCount: 1 },
        },
      ],
      nextCursor: null,
    },
    projects: [],
    status: "ready",
    error: null,
    busy: false,
    needsCheck: false,
    refresh: vi.fn(),
    changeQuery: vi.fn(),
    loadMore: vi.fn(),
    retain: vi.fn(),
  } as unknown as Library;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  dialogMethods.forEach((name, index) => {
    const original = originals[index];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
  vi.unstubAllGlobals();
});

/** Lets queued `close` events and the focus-return animation frame run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}
async function open(selector: string) {
  const opener = host.querySelector<HTMLButtonElement>(selector)!;
  // A real press focuses the button before its click.
  opener.focus();
  await act(async () => opener.click());
  await settle();
  return opener;
}
const detail = () => host.querySelector<HTMLDialogElement>("dialog.assets-detail");

// D-034. Development runs each new effect as setup, cleanup, setup (Strict Mode, on in
// next.config.ts). The cleanup's close() must not dismiss the reopened dialog.
it.each([["file card", ".assets-open"]])(
  "opens asset details from the %s and keeps them open in Strict Mode",
  async (_name, selector) => {
    await act(async () =>
      root.render(
        <StrictMode>
          <AssetsWorkspace />
        </StrictMode>,
      ),
    );
    const opener = await open(selector);
    expect(detail()?.open).toBe(true);
    // The detail view is named by the file's name and shows its brand.
    expect(detail()?.querySelector("h2")?.textContent).toBe("Brand board");
    expect(detail()?.textContent).toContain("Fixture brand");

    // Escape arrives as a native `cancel`.
    await act(async () => {
      detail()!.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    await settle();
    expect(detail()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await open(selector);
    expect(detail()?.open).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close asset details"]')!.click());
    await settle();
    expect(detail()).toBeNull();
    expect(document.activeElement).toBe(opener);
  },
);

it("offers Like and Save as pressed toggles in the detail view and runs them through the list", async () => {
  await act(async () => root.render(<AssetsWorkspace />));
  await open(".assets-open");
  const like = host.querySelector<HTMLButtonElement>('[aria-label="Like Brand board"]')!;
  const save = host.querySelector<HTMLButtonElement>('[aria-label="Save Brand board to your library"]')!;
  expect(like.className).toContain("e-icon-button");
  expect(like.querySelector('[data-icon="heart"]')).not.toBeNull();
  expect(like.getAttribute("aria-pressed")).toBe("false");
  expect(save.getAttribute("aria-pressed")).toBe("true");
  await act(async () => like.click());
  expect(fixture.library.retain).toHaveBeenCalledWith(fixture.library.page!.items[0], "liked");
  // No refresh control: the list updates itself.
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Refresh")).toBe(false);
});
