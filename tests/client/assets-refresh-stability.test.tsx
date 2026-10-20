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
  expect(host.querySelector(".assets-loading")).toBe(status); expect(status?.textContent).toBe("Checking assets…");
  expect([...host.querySelector("#assets-results")!.children]).toEqual(siblings);
  expect(host.querySelector(".assets-grid")).toBe(grid); expect(grid?.querySelector("img")).toBe(image);
  fixture.library = { ...fixture.library, status: "ready" }; await render();
  expect(host.querySelector(".assets-loading")).toBe(status); expect(status?.textContent).toBe("");
  expect(host.querySelector(".assets-grid")).toBe(grid);
  const css = readFileSync("src/styles/assets.css", "utf8");
  expect(css).toMatch(/\.assets-loading\s*\{[^}]*min-height:\s*1\.65em/);
});
