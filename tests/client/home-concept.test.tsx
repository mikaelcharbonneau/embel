// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeScopePicker } from "@/components/workspace/home-scope-picker";
import { HomeRecentBrands, shortDate } from "@/components/workspace/home-recent-brands";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking"; generation: number }, current: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", async () => { const drafts = (await import("@/components/workspace/account-draft-memory")).createAccountDraftMemory(); return { useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire, drafts }) }; });
vi.mock("@/components/workspace/local-drafts", async original => ({ ...await original<object>(), useLocalDrafts: () => ({ loaded: true, drafts: [], storage: "available" }) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.session = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
  mock.current.mockImplementation((account: VerifiedAccount) => mock.session.status === "ready" && mock.session.userId === account.userId && mock.session.generation === account.generation);
  mock.expire.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("Home scope switch", () => {
  it("offers exactly the three supported scopes as one radio group and reports a change", async () => {
    const change = vi.fn();
    await act(async () => root.render(createElement(HomeScopePicker, { value: "complete_brand", onChange: change })));
    expect(host.querySelector("fieldset > legend")?.textContent).toBe("What to create");
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map(radio => radio.parentElement!.textContent)).toEqual(["Complete brand", "Name only", "Visual identity"]);
    expect(radios.map(radio => radio.value)).toEqual(["complete_brand", "naming_only", "visual_identity_only"]);
    expect(new Set(radios.map(radio => radio.name)).size).toBe(1);
    expect(radios[0]!.checked).toBe(true); expect(radios[0]!.parentElement!.dataset.checked).toBe("true");
    await act(async () => radios[1]!.parentElement!.click());
    expect(change).toHaveBeenCalledExactlyOnceWith("naming_only");
  });
  it("does not allow a frozen brief to change scope", async () => {
    const change = vi.fn();
    await act(async () => root.render(createElement(HomeScopePicker, { value: "complete_brand", onChange: change, disabled: true })));
    expect(host.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () => host.querySelectorAll<HTMLLabelElement>("label")[2]!.click());
    expect(change).not.toHaveBeenCalled();
  });
});

function page(ownerId: string, title: string) {
  return { ownerId, items: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", owner_id: ownerId, title, scope: "complete_brand", current_revision: 1, lifecycle_version: 0, deleted_at: null, deletion_requested_at: null, deletion_state: "active", created_at: "2026-10-08T12:00:00Z" }], nextCursor: null };
}
describe("home account cards", () => {
  it("keeps saved projects hidden until the account is verified", async () => {
    mock.session = { status: "checking", generation: 2 };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    localStorage.setItem("fluid.local-drafts.v1", "legacy recovery data");
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(host.textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem("fluid.local-drafts.v1")).toBe("legacy recovery data");
    localStorage.removeItem("fluid.local-drafts.v1");
  });
  it("shows neutral placeholder cards, not invented project content, while projects load", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    await act(async () => root.render(createElement(HomeRecentBrands)));
    const grid = host.querySelector(".home-brand-grid")!;
    expect(grid.getAttribute("aria-busy")).toBe("true"); expect(grid.querySelectorAll(".project-card-skeleton")).toHaveLength(4);
    expect(grid.querySelector(".sr-only")?.textContent).toBe("Loading your projects…");
    expect([...grid.querySelectorAll(".project-card-skeleton")].map(card => card.textContent)).toEqual(["", "", "", ""]);
    expect(host.textContent).not.toMatch(/Untitled brand|Open project|Saved project/);
  });
  it("shows account projects without a separate storage mode", async () => {
    const owner = (mock.session as VerifiedAccount).userId;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page(owner, "Saved brand"))));
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(host.querySelector('a[href="/brands/account/cccccccc-cccc-4ccc-8ccc-cccccccccccc"]')?.textContent).toContain("Saved brand");
    expect(host.textContent).not.toMatch(/browser|account cop|account project/i);
  });
  it("rejects a page from another owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Private other account"))));
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(mock.expire).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain("Private other account");
  });
  it("fences delayed reads and immediately hides cards during account reverification", async () => {
    const requests: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => requests.push(resolve))));
    const firstOwner = mock.session.status === "ready" ? mock.session.userId : "";
    await act(async () => root.render(createElement(HomeRecentBrands)));
    mock.session = { status: "ready", userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", generation: 2 };
    await act(async () => root.render(createElement(HomeRecentBrands)));
    await act(async () => requests[0]!(Response.json(page(firstOwner, "Old account private brand"))));
    expect(host.textContent).not.toContain("Old account private brand");
    await act(async () => requests[1]!(Response.json(page("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Current account brand"))));
    expect(host.textContent).toContain("Current account brand");
    mock.session = { status: "checking", generation: 3 };
    await act(async () => root.render(createElement(HomeRecentBrands)));
    expect(host.textContent).not.toContain("Current account brand");
  });
});

describe("recent card dates", () => {
  it("says Today and Yesterday, then a short date with the year only when it differs", () => {
    const now = new Date(2026, 10, 6, 9, 30);
    expect(shortDate(new Date(2026, 10, 6, 0, 5).toISOString(), now)).toBe("Today");
    expect(shortDate(new Date(2026, 10, 5, 23, 55).toISOString(), now)).toBe("Yesterday");
    expect(shortDate(new Date(2026, 9, 31, 12).toISOString(), now)).toBe("Oct 31");
    expect(shortDate(new Date(2025, 11, 24, 12).toISOString(), now)).toBe("Dec 24, 2025");
    expect(shortDate("not a date", now)).toBe("Date unavailable");
  });
});
