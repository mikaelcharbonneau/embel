// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectsWorkspace } from "@/components/workspace/projects-workspace";
import { createAccountViewCache } from "@/components/workspace/account-view-cache";
import type { LifecycleProject } from "@/components/workspace/project-deletion-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";

// D-073: returning to Projects shows its cards at once, with no skeleton, and clearing the search sends no request.
const mock = vi.hoisted(() => {
  const state = {
    session: null as unknown as VerifiedAccount,
    viewCache: null as unknown as ReturnType<typeof createAccountViewCache>,
    isCurrent: (account: VerifiedAccount) =>
      account.userId === state.session.userId && account.generation === state.session.generation,
    expire: () => undefined,
  };
  return state;
});
vi.mock("@/components/workspace/account-session", async () => {
  const drafts = (await import("@/components/workspace/account-draft-memory")).createAccountDraftMemory();
  return {
    useAccountSession: () => ({
      session: mock.session,
      isCurrent: mock.isCurrent,
      expire: mock.expire,
      drafts,
      viewCache: mock.viewCache,
    }),
    AccountStatus: () => null,
  };
});
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project = (n: number, title: string): LifecycleProject => ({
  id: `cccccccc-cccc-4ccc-8ccc-00000000000${n}`,
  owner_id: owner,
  title,
  scope: "complete_brand",
  current_revision: 1,
  lifecycle_version: 0,
  deleted_at: null,
  deletion_requested_at: null,
  deletion_state: "active",
  created_at: `2026-10-1${n}T12:00:00Z`,
});
const kestrel = project(3, "Kestrel Analytics"),
  orchard = project(2, "Orchard Lane Cider");
let host: HTMLDivElement, root: Root, fetcher: ReturnType<typeof vi.fn>;
const reads = (prefix: string) => fetcher.mock.calls.filter(([path]) => String(path).startsWith(prefix)).length;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Every card is in view, so each mounted card reads its project once.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly notify: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.notify([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.viewCache = createAccountViewCache();
  mock.viewCache.bind(mock.session);
  fetcher = vi.fn(async (path: string) =>
    String(path).startsWith("/api/projects/page")
      ? Response.json({ ownerId: owner, items: [kestrel, orchard], nextCursor: null })
      : Response.json({ error: "not_found" }, { status: 404 }),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function typeSearch(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const shown = () =>
  [...host.querySelectorAll<HTMLElement>(".project-card")]
    .filter((card) => !card.hidden)
    .map((card) => card.dataset.projectId);

it("shows the kept list at once on return and refreshes it quietly", async () => {
  await act(async () => root.render(<ProjectsWorkspace />));
  expect(shown()).toEqual([kestrel.id, orchard.id]);
  expect(reads("/api/projects/page")).toBe(1);
  await act(async () => root.render(<p>Library</p>));

  let finish!: () => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = () => resolve(Response.json({ ownerId: owner, items: [kestrel], nextCursor: null }));
      }),
  );
  await act(async () => root.render(<ProjectsWorkspace />));
  // The kept cards are there before the refresh answers: no skeleton.
  expect(host.querySelector(".project-card-skeleton")).toBeNull();
  expect(host.querySelector(".projects-grid")?.getAttribute("aria-busy")).toBeNull();
  expect(shown()).toEqual([kestrel.id, orchard.id]);
  // Each card shows what it showed before (here, its name), not a placeholder, while it is read again.
  expect(host.querySelectorAll(".project-card .e-skeleton")).toHaveLength(0);
  expect(host.querySelector(".project-card")?.textContent).toContain("Kestrel Analytics");
  expect(reads("/api/projects/page")).toBe(2);
  await act(async () => finish());
  expect(shown()).toEqual([kestrel.id]);
});

it("drops the kept list when the session changes", async () => {
  await act(async () => root.render(<ProjectsWorkspace />));
  await act(async () => root.render(<p>Library</p>));
  mock.session = { status: "ready", userId: owner, generation: 2 };
  mock.viewCache.bind(mock.session);
  await act(async () => root.render(<ProjectsWorkspace />));
  expect(reads("/api/projects/page")).toBe(2);
  expect(shown()).toEqual([kestrel.id, orchard.id]);
});

it("filters on the client and sends no request when the search is cleared", async () => {
  await act(async () => root.render(<ProjectsWorkspace />));
  const before = fetcher.mock.calls.length;
  expect(reads(`/api/projects/${kestrel.id}`)).toBe(1);
  await typeSearch("orchard");
  expect(shown()).toEqual([orchard.id]);
  await typeSearch("zzzz-nothing");
  expect(shown()).toEqual([]);
  expect(host.querySelector(".e-empty--results")?.textContent).toContain("No projects match “zzzz-nothing”");
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Clear search")!.click(),
  );
  expect(shown()).toEqual([kestrel.id, orchard.id]);
  expect(host.querySelector('input[type="search"]')).toHaveProperty("value", "");
  // No listing read and no card read again: the cards stayed mounted.
  expect(fetcher.mock.calls.length).toBe(before);
});
