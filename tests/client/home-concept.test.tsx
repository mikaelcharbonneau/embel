// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeRecentBrands } from "@/components/workspace/home-recent-brands";
import { relativeTime } from "@/components/workspace/project-card";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as
    VerifiedAccount | { status: "checking" | "signed_out"; generation: number },
  current: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", async () => {
  const drafts = (await import("@/components/workspace/account-draft-memory")).createAccountDraftMemory();
  return { useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire, drafts }) };
});
vi.mock("@/components/workspace/local-drafts", async (original) => ({
  ...(await original<object>()),
  useLocalDrafts: () => ({ loaded: true, drafts: [], storage: "available" }),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.session = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
  mock.current.mockImplementation(
    (account: VerifiedAccount) =>
      mock.session.status === "ready" &&
      mock.session.userId === account.userId &&
      mock.session.generation === account.generation,
  );
  mock.expire.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const projectId = (index: number) => `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`;
function project(ownerId: string, title: string, index = 0) {
  return {
    id: projectId(index),
    owner_id: ownerId,
    title,
    scope: "complete_brand",
    current_revision: 1,
    lifecycle_version: 0,
    deleted_at: null,
    deletion_requested_at: null,
    deletion_state: "active",
    // Newest first, as the server pages them.
    created_at: new Date(Date.UTC(2026, 9, 20 - index, 12)).toISOString(),
  };
}
function page(ownerId: string, ...titles: string[]) {
  return { ownerId, items: titles.map((title, index) => project(ownerId, title, index)), nextCursor: null };
}
/** Answers each private read by its path; anything else is an unexpected request. */
function stubReads(projects: () => unknown, balance = 30) {
  const fetch = vi.fn(async (path: string) => {
    if (path.startsWith("/api/projects/page")) return Response.json(projects());
    if (path === "/api/billing")
      return Response.json({
        billing: { planId: "free", balance, periodEnd: "2026-12-01T00:00:00Z", subscription: null, plans: [] },
      });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const calls = (fetch: ReturnType<typeof vi.fn>, prefix: string) =>
  fetch.mock.calls.filter(([path]) => String(path).startsWith(prefix));
const headings = () => [...host.querySelectorAll("h2")].map((heading) => heading.textContent);

describe("home account cards", () => {
  it("keeps saved projects hidden until the account is verified, showing only a neutral loading frame", async () => {
    mock.session = { status: "checking", generation: 2 };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem("fluid.local-drafts.v1", "legacy recovery data");
    await act(async () => root.render(createElement(HomeRecentBrands)));
    const section = host.querySelector("section")!;
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.querySelector('[role="status"]')?.textContent).toBe("Loading your projects…");
    expect(host.textContent).toBe("Loading your projects…");
    expect(section.querySelectorAll(".home-project-grid .project-card-skeleton")).toHaveLength(3);
    expect(host.querySelector("a, h2, h3, img, button")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem("fluid.local-drafts.v1")).toBe("legacy recovery data");
    localStorage.removeItem("fluid.local-drafts.v1");
  });
  it("shows neutral placeholder cards, not invented project content, while projects load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(headings()).toEqual(["Recent projects"]);
    const grid = host.querySelector(".home-project-grid")!;
    expect(grid.getAttribute("aria-busy")).toBe("true");
    expect(grid.querySelectorAll(".project-card-skeleton")).toHaveLength(3);
    expect(grid.querySelector('[role="status"]')?.textContent).toBe("Loading your projects…");
    expect([...grid.querySelectorAll(".project-card-skeleton")].map((card) => card.textContent)).toEqual(["", "", ""]);
    expect(host.textContent).not.toMatch(/Untitled brand|Open project|Saved project/);
  });
  it("shows account projects under Recent projects without a separate storage mode", async () => {
    const owner = (mock.session as VerifiedAccount).userId;
    stubReads(() => page(owner, "Saved brand"));
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(headings()).toEqual(["Recent projects"]);
    expect(host.querySelector('a[href="/brands"]')?.textContent).toBe("All projects");
    const grid = host.querySelector(".home-project-grid")!;
    expect(grid.hasAttribute("aria-busy")).toBe(false);
    expect(grid.querySelector(`a[href="/brands/account/${projectId(0)}"]`)?.textContent).toContain("Saved brand");
    expect(host.textContent).not.toMatch(/browser|account cop|account project/i);
    expect(host.textContent).not.toContain("What you will get");
  });
  it("shows at most the three newest projects", async () => {
    const owner = (mock.session as VerifiedAccount).userId;
    stubReads(() => page(owner, "Newest", "Second", "Third", "Fourth", "Fifth"));
    await act(async () => root.render(createElement(HomeRecentBrands)));
    const cards = [...host.querySelectorAll(".home-project-grid article")];
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual(["Newest", "Second", "Third"]);
    expect(host.textContent).not.toMatch(/Fourth|Fifth/);
  });
  it("shows a new account its credits and what it will get instead of an empty project list", async () => {
    const owner = (mock.session as VerifiedAccount).userId;
    const fetch = stubReads(() => page(owner), 30);
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(host.querySelector(".home-credits")?.textContent).toBe("You have 30 credits to start.");
    expect(headings()).toEqual(["What you will get"]);
    expect(host.querySelectorAll(".home-example-grid img")).toHaveLength(3);
    expect(host.querySelector(".home-project-grid")).toBeNull();
    expect(host.textContent).not.toContain("Recent projects");
    expect(calls(fetch, "/api/billing")).toHaveLength(1);
  });
  it("shows a signed-out visitor the free start and brands made with Embel, without reading anything private", async () => {
    mock.session = { status: "signed_out", generation: 2 };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(host.querySelector(".home-credits")?.textContent).toBe("Free to start with 30 credits.See plans");
    expect(host.querySelector('.home-credits a[href="/plans"]')).not.toBeNull();
    expect(headings()).toEqual(["Made with Embel"]);
    expect([...host.querySelectorAll(".home-example-grid figcaption")].map((caption) => caption.textContent)).toEqual([
      "Kestrel Analytics",
      "Orchard Lane Cider",
      "Tidewild Hot Sauce",
    ]);
    expect(host.querySelector(".home-project-grid")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a page from another owner", async () => {
    stubReads(() => page("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Private other account"));
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(mock.expire).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("Private other account");
  });
  it("fences delayed reads and immediately hides cards during account reverification", async () => {
    const requests: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve))),
    );
    const firstOwner = mock.session.status === "ready" ? mock.session.userId : "";
    await act(async () => root.render(createElement(HomeRecentBrands)));
    mock.session = { status: "ready", userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", generation: 2 };
    await act(async () => root.render(createElement(HomeRecentBrands)));
    await act(async () => requests[0]!(Response.json(page(firstOwner, "Old account private brand"))));
    expect(host.textContent).not.toContain("Old account private brand");
    await act(async () =>
      requests[1]!(Response.json(page("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Current account brand"))),
    );
    expect(host.textContent).toContain("Current account brand");
    mock.session = { status: "checking", generation: 3 };
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(host.textContent).not.toContain("Current account brand");
    expect(host.textContent).toBe("Loading your projects…");
  });
});

describe("recent card dates", () => {
  it("says how long ago in minutes, hours and days, then a short date with the year only when it differs", () => {
    const now = new Date(2026, 10, 6, 9, 30);
    expect(relativeTime(new Date(2026, 10, 6, 9, 29, 40).toISOString(), now)).toBe("just now");
    expect(relativeTime(new Date(2026, 10, 6, 9, 29).toISOString(), now)).toBe("1 minute ago");
    expect(relativeTime(new Date(2026, 10, 6, 8, 50).toISOString(), now)).toBe("40 minutes ago");
    expect(relativeTime(new Date(2026, 10, 6, 0, 5).toISOString(), now)).toBe("9 hours ago");
    expect(relativeTime(new Date(2026, 10, 5, 8, 55).toISOString(), now)).toBe("yesterday");
    expect(relativeTime(new Date(2026, 10, 2, 12).toISOString(), now)).toBe("4 days ago");
    expect(relativeTime(new Date(2026, 9, 20, 12).toISOString(), now)).toBe("Oct 20");
    expect(relativeTime(new Date(2025, 11, 24, 12).toISOString(), now)).toBe("Dec 24, 2025");
    expect(relativeTime("not a date", now)).toBeNull();
  });
});
