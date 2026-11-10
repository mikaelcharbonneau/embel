// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import type { useAssetLibrary } from "@/components/assets/use-asset-library";
import type { AssetLibraryPage, AssetLibraryQuery } from "@/domain/asset-library";

type Library = ReturnType<typeof useAssetLibrary>;
const fixture = vi.hoisted(() => ({
  library: null as unknown as Library,
  account: { status: "ready", userId: "owner-a", generation: 1 },
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: fixture.account }),
  AccountStatus: () => <p>Account unavailable</p>,
}));
vi.mock("@/components/assets/use-asset-library", () => ({ useAssetLibrary: () => fixture.library }));
vi.mock("@/components/assets/asset-preview", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- synthetic preview, never requests a private file.
  AssetPreview: () => <img src="blob:fixture-only" alt="Private preview" />,
}));
vi.mock("@/components/assets/asset-detail", () => ({
  AssetDetailDialog: () => (
    <div role="dialog">
      <input aria-label="Pending detail intention" defaultValue="Keep this choice" />
    </div>
  ),
}));

let root: Root, host: HTMLDivElement;
let measuredHeight = 1234;
function page(count: number, prefix = "Old", nextCursor: string | null = "old-cursor"): AssetLibraryPage {
  return {
    query: fixture.library?.query ?? { tab: "my_selection", limit: 40 },
    items: Array.from({ length: count }, (_, index) => ({
      asset: {
        id: `${prefix}-${index}`,
        kind: `${prefix} logo ${index}`,
        versionCount: 1,
        usage: { active: false, legacy: false },
        currentSelection: null,
        saved: true,
        liked: false,
      },
      project: { id: "project-a", title: `${prefix} private project` },
      displayedVersion: null,
      selectedVersion: null,
      matchingVersions: { totalCount: 1 },
    })),
    nextCursor,
  } as unknown as AssetLibraryPage;
}
function client() {
  return { current: vi.fn(() => true) } as unknown as Library["client"];
}
async function render() {
  await act(async () => root.render(<AssetsWorkspace />));
}
async function update(patch: Partial<Library>) {
  fixture.library = { ...fixture.library, ...patch };
  await render();
}
function find<T extends HTMLElement>(selector: string): T {
  return host.querySelector<T>(selector)!;
}
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
    root.render(<AssetsWorkspace />);
  });
}
async function select(label: string, value: string) {
  await act(async () => {
    const node = find<HTMLSelectElement>(`select[aria-label="${label}"]`);
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    root.render(<AssetsWorkspace />);
  });
}
async function search(value: string) {
  await act(async () => {
    const node = find<HTMLInputElement>('input[type="search"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function expectReservation(slots = 13, height = 1234) {
  expect(find<HTMLElement>(".assets-results-body").style.minHeight).toBe(`${height}px`);
  expect(host.querySelectorAll(".assets-query-placeholder")).toHaveLength(slots);
  const island = find<HTMLElement>(".assets-query-placeholders");
  expect(island.getAttribute("aria-hidden")).toBe("true");
  expect(island.hasAttribute("inert")).toBe(true);
  expect(island.querySelector("article, img, a, button, input, select, summary, [tabindex]")).toBeNull();
  expect(island.textContent).toBe("");
  expect(host.querySelector("#assets-results")!.textContent).not.toContain("Old private");
  expect(host.querySelector("#assets-results")!.textContent).not.toContain("Old logo");
  expect(host.querySelectorAll("article, .assets-card, .assets-retain")).toHaveLength(0);
  expect(button("Load more assets")).toBeUndefined();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  measuredHeight = 1234;
  fixture.account = { status: "ready", userId: "owner-a", generation: 1 };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.library = {
    client: client(),
    query: { tab: "my_selection", limit: 40 },
    page: null,
    projects: [
      {
        id: "project-a",
        owner_id: "owner-a",
        title: "Old private project",
        scope: "complete_brand",
        current_revision: 1,
        created_at: "2026-10-20T00:00:00Z",
      },
    ],
    status: "ready",
    busy: false,
    needsCheck: false,
    error: null,
    changeQuery: vi.fn((next: Omit<AssetLibraryQuery, "cursor" | "limit">) => {
      const current = fixture.library.query;
      if (
        fixture.library.busy ||
        (current.tab === next.tab && current.projectId === next.projectId && current.format === next.format)
      )
        return;
      fixture.library = {
        ...fixture.library,
        query: { ...next, limit: 40 },
        page: null,
        status: "loading",
        error: null,
      };
    }),
    refresh: vi.fn(() => {
      fixture.library = { ...fixture.library, status: "loading", error: null };
    }),
    retain: vi.fn(),
    loadMore: vi.fn(),
  };
  fixture.library.page = page(13);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains("assets-results-body") ? measuredHeight : 44;
    return { x: 0, y: 0, top: 0, left: 0, width: 1008, height, right: 1008, bottom: height, toJSON: () => ({}) };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("holds only anonymous geometry across a real SVG filter, keeping controls, count and focus truthful", async () => {
  await render();
  // The loaded count is announced to screen readers, not shown.
  expect(find(".assets-pagination > span").className).toBe("sr-only");
  const toolbar = find(".assets-toolbar"),
    body = find(".assets-results-body"),
    footer = find(".assets-pagination"),
    filter = find<HTMLSelectElement>('select[aria-label="File type"]');
  filter.focus();
  await select("File type", "svg");
  expectReservation();
  expect(find(".assets-toolbar")).toBe(toolbar);
  expect(find(".assets-results-body")).toBe(body);
  expect(find(".assets-pagination")).toBe(footer);
  expect(document.activeElement).toBe(filter);
  expect(host.textContent).toContain("Matching asset count pending.");
  expect(host.textContent).not.toContain("13 assets loaded");
  expect(host.textContent).not.toContain("0 assets loaded");
  await update({ page: page(2, "New", "new-cursor"), status: "ready" });
  expect(host.querySelectorAll("article")).toHaveLength(2);
  expect(host.textContent).toContain("2 assets loaded");
  expect(host.textContent).not.toContain("Matching asset count pending.");
  expect(find<HTMLElement>(".assets-results-body").style.minHeight).toBe("");
  expect(host.querySelector(".assets-query-placeholder")).toBeNull();
  await click(button("Load more assets"));
  expect(fixture.library.loadMore).toHaveBeenCalledOnce();
});

it.each(["tab click", "tab keyboard", "project", "file type"] as const)(
  "captures current geometry for %s",
  async (entry) => {
    await render();
    if (entry === "tab click") await click(find("#assets-tab-all_generations"));
    else if (entry === "tab keyboard")
      await act(async () => {
        find("#assets-tab-my_selection").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        root.render(<AssetsWorkspace />);
      });
    else await select(entry === "project" ? "Project" : "File type", entry === "project" ? "project-a" : "svg");
    expectReservation();
    expect(fixture.library.changeQuery).toHaveBeenCalledOnce();
  },
);

it("captures an empty view for Browse all generations without inventing previous cards", async () => {
  fixture.library.page = page(0, "Old", null);
  measuredHeight = 420;
  await render();
  await click(button("Browse all generations"));
  expectReservation(0, 420);
  expect(host.textContent).toContain("Matching asset count pending.");
});

it("keeps local search immediate and client-only, then captures only its visible geometry", async () => {
  await render();
  await search("Old logo 12");
  expect(host.querySelectorAll("article")).toHaveLength(1);
  expect(host.textContent).toContain("1 matches in 13 loaded assets");
  expect(fixture.library.changeQuery).not.toHaveBeenCalled();
  expect(fixture.library.refresh).not.toHaveBeenCalled();
  expect(host.querySelector(".assets-query-placeholder")).toBeNull();
  expect(host.textContent).not.toContain("count pending");
  measuredHeight = 280;
  await select("File type", "svg");
  expectReservation(1, 280);
  await search("new local text");
  expectReservation(1, 280);
  expect(fixture.library.changeQuery).toHaveBeenCalledOnce();
});

it("does not manufacture a pending transition for a same-query no-op or replace cards on Refresh", async () => {
  await render();
  const grid = find(".assets-grid"),
    image = grid.querySelector("img");
  await click(find("#assets-tab-my_selection"));
  await select("File type", "");
  expect(fixture.library.page?.items).toHaveLength(13);
  expect(find(".assets-grid")).toBe(grid);
  expect(host.querySelector(".assets-query-placeholder")).toBeNull();
  await click(button("Refresh"));
  expect(find(".assets-grid")).toBe(grid);
  expect(grid.querySelector("img")).toBe(image);
  expect(host.textContent).toContain("Refreshing…");
  expect(host.textContent).toContain("13 assets loaded");
  expect(find<HTMLElement>(".assets-results-body").style.minHeight).toBe("");
});

it("holds anonymous geometry through a same-client query failure and explicit current-query retry", async () => {
  await render();
  await select("File type", "svg");
  await update({ status: "error", error: "The assets could not be checked." });
  expectReservation();
  expect(host.textContent).toContain("Matching asset count unavailable.");
  await click(button("Try again"));
  expectReservation();
  expect(fixture.library.query.format).toBe("svg");
  expect(fixture.library.refresh).toHaveBeenCalledOnce();
  expect(fixture.library.retain).not.toHaveBeenCalled();
  expect(fixture.library.loadMore).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Matching asset count pending.");
  await update({ page: page(0, "New", null), status: "ready" });
  expect(host.textContent).toContain("No assets match these filters");
  expect(host.textContent).toContain("0 assets loaded");
  expect(find<HTMLElement>(".assets-results-body").style.minHeight).toBe("");
  expect(host.querySelector(".assets-query-placeholder")).toBeNull();
});

it("preserves the numeric reservation through A to B to C and back to A before a result", async () => {
  await render();
  await select("File type", "svg");
  measuredHeight = 99;
  await select("File type", "pdf");
  expectReservation();
  await select("File type", "");
  expectReservation();
  expect(fixture.library.query.format).toBeUndefined();
});

it.each(["checking", "signed_out", "new owner", "new generation"] as const)(
  "discards owner-derived geometry at %s",
  async (boundary) => {
    await render();
    await select("File type", "svg");
    expectReservation();
    fixture.account =
      boundary === "new owner"
        ? { status: "ready", userId: "owner-b", generation: 2 }
        : boundary === "new generation"
          ? { status: "ready", userId: "owner-a", generation: 2 }
          : { status: boundary, userId: "owner-a", generation: 2 };
    fixture.library = { ...fixture.library, client: client(), page: null, status: "loading" };
    await render();
    expect(host.innerHTML).not.toContain("1234px");
    expect(host.querySelectorAll(".assets-query-placeholder").length).not.toBe(13);
    if (boundary === "checking" || boundary === "signed_out") expect(host.querySelector("#assets-results")).toBeNull();
    else expect(host.querySelectorAll(".assets-query-placeholder")).toHaveLength(3);
  },
);

it.each(["replacement", "disposed"] as const)("does not reuse numeric geometry for a %s client", async (boundary) => {
  await render();
  await select("File type", "svg");
  expectReservation();
  if (boundary === "replacement") await update({ client: client() });
  else {
    vi.mocked(fixture.library.client.current).mockReturnValue(false);
    await render();
  }
  expect(find<HTMLElement>(".assets-results-body").style.minHeight).toBe("");
  expect(host.querySelectorAll(".assets-query-placeholder")).toHaveLength(3);
});

it("uses only generic geometry without a previous page, including an initial failed read", async () => {
  fixture.library.page = null;
  fixture.library.status = "loading";
  await render();
  expect(host.querySelectorAll(".assets-query-placeholder")).toHaveLength(3);
  expect(find<HTMLElement>(".assets-results-body").style.minHeight).toBe("");
  expect(host.textContent).toContain("count pending");
  await update({ status: "error", error: "Unavailable" });
  expect(host.querySelectorAll(".assets-query-placeholder")).toHaveLength(3);
  expect(host.textContent).toContain("count unavailable");
  expect(host.textContent).not.toContain("0 assets loaded");
});

it("does not alter pending-operation or unknown-outcome gates", async () => {
  fixture.library.busy = true;
  fixture.library.needsCheck = true;
  await render();
  await click(find("#assets-tab-all_generations"));
  expect(fixture.library.changeQuery).not.toHaveBeenCalled();
  expect(host.querySelectorAll("article")).toHaveLength(13);
  expect(host.querySelector(".assets-query-placeholder")).toBeNull();
  expect([...host.querySelectorAll<HTMLButtonElement>(".assets-retain")].every((node) => node.disabled)).toBe(true);
});

it("keeps explicit detail intent outside the inert results while changing filters", async () => {
  await render();
  await click(find(".assets-open"));
  const detail = find('[role="dialog"]'),
    intention = find<HTMLInputElement>('[aria-label="Pending detail intention"]');
  intention.value = "Unsubmitted current choice";
  await select("File type", "svg");
  expectReservation();
  expect(find('[role="dialog"]')).toBe(detail);
  expect(intention.value).toBe("Unsubmitted current choice");
  expect(detail.closest("[inert]")).toBeNull();
});

it("uses the approved responsive grid, static card shells and no new scrolling container", () => {
  const css = readFileSync("src/styles/assets-guided.css", "utf8");
  expect(css).toMatch(/\.assets-query-placeholder\s*\{[^}]*aspect-ratio:/);
  expect(css).toMatch(/\.assets-query-placeholders\s*\{[^}]*pointer-events:\s*none/);
  expect(css).not.toMatch(
    /\.assets-(?:results-body|query-placeholders|query-placeholder)\s*\{[^}]*(?:animation|overflow(?:-y)?):/,
  );
  expect(readFileSync("src/styles/assets.css", "utf8")).toContain("repeat(3, minmax(0, 1fr))");
  expect(css).toContain("repeat(2, minmax(0, 1fr))");
  expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
});
