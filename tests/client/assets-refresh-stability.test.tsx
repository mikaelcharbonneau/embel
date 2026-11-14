// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import type { useAssetLibrary } from "@/components/assets/use-asset-library";

const fixture = vi.hoisted(() => ({
  library: null as unknown as ReturnType<typeof useAssetLibrary>,
  account: { status: "ready", userId: "fixture-owner", generation: 1 },
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: fixture.account }),
  AccountStatus: () => null,
}));
vi.mock("@/components/assets/use-asset-library", () => ({ useAssetLibrary: () => fixture.library }));
vi.mock("@/components/assets/asset-preview", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- synthetic private preview, no image request.
  AssetPreview: () => <img src="blob:verified-fixture" alt="Fixture preview" />,
}));
vi.mock("@/components/assets/asset-detail", () => ({ AssetDetailDialog: () => null }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.library = {
    query: { tab: "my_selection" },
    page: {
      items: [
        {
          asset: {
            id: "asset",
            kind: "Logo",
            versionCount: 1,
            usage: { active: false, legacy: false },
            currentSelection: null,
            saved: true,
            liked: false,
          },
          displayedVersion: null,
          selectedVersion: null,
          project: { id: "project", title: "Saved project" },
        },
      ],
      nextCursor: null,
    },
    projects: [],
    status: "ready",
    busy: false,
    error: null,
    refresh: vi.fn(),
    changeQuery: vi.fn(),
  } as unknown as ReturnType<typeof useAssetLibrary>;
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<AssetsWorkspace />));
}

it("reserves one status slot and retains loaded grid/image nodes through background refresh", async () => {
  await render();
  const status = host.querySelector(".assets-loading"),
    grid = host.querySelector(".assets-grid"),
    image = grid?.querySelector("img");
  expect(status).not.toBeNull();
  expect(status?.textContent).toBe("");
  const siblings = [...host.querySelector("#assets-results")!.children];
  fixture.library = { ...fixture.library, status: "loading" };
  await render();
  expect(host.querySelector(".assets-loading")).toBe(status);
  expect(status?.textContent).toBe("Refreshing…");
  expect([...host.querySelector("#assets-results")!.children]).toEqual(siblings);
  expect(host.querySelector(".assets-grid")).toBe(grid);
  expect(grid?.querySelector("img")).toBe(image);
  fixture.library = { ...fixture.library, status: "ready" };
  await render();
  expect(host.querySelector(".assets-loading")).toBe(status);
  expect(status?.textContent).toBe("");
  expect(host.querySelector(".assets-grid")).toBe(grid);
});

it("groups files by brand in the journey's words, marks chosen ones and has no Refresh button", async () => {
  const [item] = fixture.library.page!.items as unknown as Record<string, unknown>[];
  const asset = item!.asset as Record<string, unknown>;
  const row = (
    id: string,
    kind: string,
    createdAt: string,
    project: { id: string; title: string },
    active = false,
  ) => ({
    ...item,
    asset: { ...asset, id, kind, createdAt, usage: { active, legacy: false } },
    project,
  });
  const launchpad = { id: "launchpad", title: "Launchpad" },
    orchard = { id: "orchard", title: "Orchard" };
  fixture.library = {
    ...fixture.library,
    query: { tab: "all_generations" },
    page: {
      ...fixture.library.page!,
      items: [
        row("b2", "logo_identity_system", "2026-11-12T02:00:00Z", launchpad),
        row("l2", "logo_concept", "2026-11-12T01:00:00Z", launchpad, true),
        row("l1", "logo_concept", "2026-11-12T00:00:00Z", launchpad),
        row("o1", "logo_concept", "2026-11-11T00:00:00Z", orchard),
      ],
    },
  } as unknown as typeof fixture.library;
  await render();
  const brands = [...host.querySelectorAll<HTMLElement>(".library-brand")];
  expect(brands.map((brand) => brand.querySelector("h2")?.textContent)).toEqual(["Launchpad3", "Orchard1"]);
  expect([...brands[0]!.querySelectorAll("h3.library-section__title")].map((node) => node.textContent)).toEqual([
    "Logo concepts",
    "Direction boards",
  ]);
  // Numbered by their place among the brand's files of that kind, oldest first.
  expect([...brands[0]!.querySelectorAll("article")].map((card) => card.getAttribute("aria-label"))).toEqual([
    "Logo concept 2 · Launchpad",
    "Logo concept 1 · Launchpad",
    "Direction board 1 · Launchpad",
  ]);
  const chosen = [...host.querySelectorAll("article")].filter((card) => card.textContent?.includes("Chosen"));
  expect(chosen.map((card) => card.getAttribute("aria-label"))).toEqual(["Logo concept 2 · Launchpad"]);
  expect(brands[0]!.querySelector('a[href="/brands/account/launchpad"]')?.textContent).toBe("Open project");
  expect(host.textContent).not.toMatch(/logo_identity_system|logo_concept/);
  expect([...host.querySelectorAll("button")].find((button) => button.textContent === "Refresh")).toBeUndefined();
});

it("names a file without a number when other files of its brand may not be loaded", async () => {
  const [item] = fixture.library.page!.items as unknown as Record<string, unknown>[];
  fixture.library = {
    ...fixture.library,
    page: {
      ...fixture.library.page!,
      items: [
        {
          ...item,
          asset: { ...(item!.asset as object), kind: "logo_identity_system" },
          project: { id: "project", title: "Launchpad" },
        },
      ],
    },
  } as unknown as typeof fixture.library;
  await render();
  const card = host.querySelector("article")!;
  expect(card.getAttribute("aria-label")).toBe("Direction board · Launchpad");
  expect(card.querySelector("h3")?.textContent).toBe("Direction board");
  expect(host.querySelector(".library-brand h2")?.textContent).toBe("Launchpad1");
  expect(host.querySelectorAll(".assets-filter select")).toHaveLength(2);
});
