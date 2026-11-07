// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import type { useAssetLibrary } from "@/components/assets/use-asset-library";

const fixture = vi.hoisted(() => ({ library: null as unknown as ReturnType<typeof useAssetLibrary>, account: { status: "ready", userId: "fixture-owner", generation: 1 } }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: fixture.account }), AccountStatus: () => null }));
vi.mock("@/components/assets/use-asset-library", () => ({ useAssetLibrary: () => fixture.library }));
// eslint-disable-next-line @next/next/no-img-element -- synthetic private preview, no image request.
vi.mock("@/components/assets/asset-preview", () => ({ AssetPreview: () => <img src="blob:verified-fixture" alt="Fixture preview" /> }));
vi.mock("@/components/assets/asset-detail", () => ({ AssetDetailDialog: () => null }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fixture.library = { query: { tab: "my_selection" }, page: { items: [{ asset: { id: "asset", kind: "Logo", versionCount: 1, usage: { active: false, legacy: false }, currentSelection: null, saved: true, liked: false },
    displayedVersion: null, selectedVersion: null, project: { id: "project", title: "Saved project" } }], nextCursor: null }, projects: [], status: "ready", busy: false, error: null, refresh: vi.fn(), changeQuery: vi.fn() } as unknown as ReturnType<typeof useAssetLibrary>;
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<AssetsWorkspace />)); }

it("reserves one status slot and retains loaded grid/image nodes through background refresh", async () => {
  await render();
  const status = host.querySelector(".assets-loading"), grid = host.querySelector(".assets-grid"), image = grid?.querySelector("img");
  expect(status).not.toBeNull(); expect(status?.textContent).toBe("");
  const siblings = [...host.querySelector("#assets-results")!.children];
  fixture.library = { ...fixture.library, status: "loading" }; await render();
  expect(host.querySelector(".assets-loading")).toBe(status); expect(status?.textContent).toBe("Refreshing…");
  expect([...host.querySelector("#assets-results")!.children]).toEqual(siblings);
  expect(host.querySelector(".assets-grid")).toBe(grid); expect(grid?.querySelector("img")).toBe(image);
  fixture.library = { ...fixture.library, status: "ready" }; await render();
  expect(host.querySelector(".assets-loading")).toBe(status); expect(status?.textContent).toBe("");
  expect(host.querySelector(".assets-grid")).toBe(grid);
  const css = readFileSync("src/styles/assets.css", "utf8");
  expect(css).toMatch(/\.assets-loading\s*\{[^}]*min-height:\s*1\.65em/);
});

it("dismisses the asset actions when clicking outside without stealing focus or writing", async () => {
  await render();
  const menu = host.querySelector<HTMLDetailsElement>(".assets-card-options")!;
  menu.open = true;
  const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => search.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(menu.open).toBe(false);
  await act(async () => search.focus()); expect(document.activeElement).toBe(search);
  expect(fixture.library.refresh).not.toHaveBeenCalled(); expect(fixture.library.changeQuery).not.toHaveBeenCalled();
});


it("keeps inside actions open and dismisses on keyboard focus leaving the menu", async () => {
  await render(); const menu = host.querySelector<HTMLDetailsElement>(".assets-card-options")!;
  menu.open = true; const inside = menu.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { inside.focus(); inside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  expect(menu.open).toBe(true);
  const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => search.focus()); expect(menu.open).toBe(false); expect(document.activeElement).toBe(search);
});

it("retains Escape focus return and removes its dismissal listeners on unmount", async () => {
  const remove = vi.spyOn(document, "removeEventListener");
  await render(); const menu = host.querySelector<HTMLDetailsElement>(".assets-card-options")!;
  menu.open = true; const inside = menu.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { inside.focus(); inside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(menu.open).toBe(false); expect(document.activeElement).toBe(menu.querySelector("summary"));
  await act(async () => root.render(null));
  for (const event of ["keydown", "pointerdown", "focusin"]) expect(remove.mock.calls.some(([name]) => name === event)).toBe(true);
  remove.mockRestore();
});

it("titles cards in plain words with the project's name and uses menu-style filters", async () => {
  const [item] = (fixture.library.page!.items as unknown as Record<string, unknown>[]);
  fixture.library = { ...fixture.library, page: { ...fixture.library.page!, items: [{ ...item, asset: { ...(item!.asset as object), kind: "logo_identity_system" }, project: { id: "project", title: "Launchpad" } }] } } as unknown as typeof fixture.library;
  await render();
  const card = host.querySelector("article")!;
  expect(card.getAttribute("aria-label")).toBe("Brand board · Launchpad"); expect(card.querySelector("h2")?.textContent).toBe("Brand board");
  expect(card.querySelector(".assets-brand")?.textContent).toBe("Launchpad");
  expect(host.textContent).not.toMatch(/logo_identity_system|File checked/);
  expect(host.querySelectorAll(".assets-filter svg.assets-filter-chevron")).toHaveLength(2); expect(host.querySelector('.assets-filter img[src$="filter.svg"]')).toBeNull();
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "Refresh")).toBeDefined();
});
