// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { accountProjectPageSchema } from "@/domain/project-pages";

const mocks = vi.hoisted(() => ({ session: null as VerifiedAccount | { status: "checking"; generation: number } | null, current: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mocks.session, isCurrent: mocks.current, expire: mocks.expire }), AccountStatus: () => <p>Verify account</p> }));
import { NamesAssistant } from "@/features/names-assistant/names-assistant";

const owner = "aaaaaaaa-1111-4111-8111-111111111111", other = "dddddddd-1111-4111-8111-111111111111";
const id = (n: number) => `bbbbbbbb-1111-4111-8111-${String(n).padStart(12, "0")}`;
const row = (n: number, ownerId = owner) => ({ id: id(n), owner_id: ownerId, scope: "naming_only" as const, title: `Synthetic project ${n}`, current_revision: 1, deleted_at: null, deletion_requested_at: null, deletion_state: "active" as const, lifecycle_version: 0, created_at: "2026-10-05T12:00:00.000002Z" });
const page = (ids: number[], next: number | null = null, ownerId = owner) => accountProjectPageSchema.parse({ ownerId, items: ids.map(n => row(n, ownerId)), nextCursor: next ? { id: id(next), createdAt: row(next).created_at } : null });
const deferred = () => { let resolve!: (value: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; };
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === text)!;
const search = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
const selection = () => host.querySelector<HTMLSelectElement>("select")!;
const projectLink = () => host.querySelector<HTMLAnchorElement>('a[href*="/naming"]');
async function render() { await act(async () => root.render(<NamesAssistant />)); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function click(text: string) { await act(async () => button(text).click()); }
async function choose(value: string) { await act(async () => { selection().value = value; selection().dispatchEvent(new Event("change", { bubbles: true })); }); }
async function input(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value); search().dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.session = { status: "ready", userId: owner, generation: 1 };
  mocks.current.mockReset().mockImplementation((account: VerifiedAccount) => mocks.session?.status === "ready" && mocks.session.userId === account.userId && mocks.session.generation === account.generation);
  mocks.expire.mockReset();
  fetcher = vi.fn(async () => Response.json(page([3, 2], 2))); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it("retains chooser nodes, focus, query and eligible selection during a delayed first-page refresh", async () => {
  await render(); await input("Synthetic"); await choose(id(3));
  const field = search(), select = selection(), refresh = button("Refresh project list"), held = deferred();
  fetcher.mockImplementationOnce(() => held.promise);
  await click("Refresh project list"); field.focus();
  expect(search()).toBe(field); expect(selection()).toBe(select); expect(select.value).toBe(id(3));
  expect(projectLink()?.getAttribute("href")).toBe(`/brands/account/${id(3)}/naming`);
  expect(host.textContent).not.toContain("Loading your account projects"); expect(host.textContent).toContain("Refreshing your account projects");
  await act(async () => held.resolve(Response.json(page([3, 1]))));
  expect(search()).toBe(field); expect(selection()).toBe(select); expect(button("Refresh project list")).toBe(refresh);
  expect(document.activeElement).toBe(field); expect(field.value).toBe("Synthetic"); expect(select.value).toBe(id(3));
  expect(select.options).toHaveLength(3); expect(host.querySelector('.names-assistant-projects')?.getAttribute("aria-busy")).toBe("false");
  expect(fetcher.mock.calls[1]![0]).toBe("/api/projects/page?limit=50");
});

it("retains a failed refresh and retries page one rather than consuming its retained pagination cursor", async () => {
  await render(); await choose(id(3));
  const field = search(), select = selection();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 })); await click("Refresh project list");
  expect(search()).toBe(field); expect(selection()).toBe(select); expect(select.value).toBe(id(3));
  expect(host.textContent).toContain("Your loaded projects remain available"); expect(projectLink()).not.toBeNull();
  fetcher.mockResolvedValueOnce(Response.json(page([3, 1]))); await click("Try loading projects again");
  expect(fetcher.mock.calls.slice(1).map(([path]) => path)).toEqual(["/api/projects/page?limit=50", "/api/projects/page?limit=50"]);
  expect(search()).toBe(field); expect(select.value).toBe(id(3)); expect(host.querySelector('[role="alert"]')).toBeNull();
});

it.each(["missing", "identity only"] as const)("clears a refreshed selection that is %s without replacing the chooser", async condition => {
  await render(); await choose(id(3)); const field = search(), select = selection();
  const next = condition === "missing" ? page([2, 1]) : page([3, 1]);
  if (condition === "identity only") next.items[0]!.scope = "visual_identity_only";
  fetcher.mockResolvedValueOnce(Response.json(next)); await click("Refresh project list");
  expect(search()).toBe(field); expect(selection()).toBe(select); expect(select.value).toBe(""); expect(projectLink()).toBeNull();
});

it("hides retained choices during verification and rejects a late refresh even when its transport ignores abort", async () => {
  await render(); await choose(id(3)); const held = deferred(); fetcher.mockImplementationOnce(() => held.promise);
  await click("Refresh project list"); const signal = fetcher.mock.calls[1]![1].signal as AbortSignal;
  mocks.session = { status: "checking", generation: 2 }; await render();
  expect(signal.aborted).toBe(true); expect(search()).toBeNull(); expect(projectLink()).toBeNull();
  await act(async () => held.resolve(Response.json(page([3, 2]))));
  expect(host.textContent).not.toContain("Synthetic project"); expect(projectLink()).toBeNull();
});

it("does not reuse retained choices or a late refresh after switching owners", async () => {
  await render(); await choose(id(3)); const held = deferred(); fetcher.mockImplementationOnce(() => held.promise);
  await click("Refresh project list");
  fetcher.mockResolvedValueOnce(Response.json({ ...page([1], null, other), items: [{ ...row(1, other), title: "Other account brief" }] }));
  mocks.session = { status: "ready", userId: other, generation: 2 }; await render();
  expect(selection().value).toBe(""); expect(selection().options).toHaveLength(2);
  await act(async () => held.resolve(Response.json(page([3, 2]))));
  expect(host.textContent).toContain("Other account brief"); expect(host.textContent).not.toContain("Synthetic project 3");
  expect(projectLink()).toBeNull(); expect(mocks.expire).not.toHaveBeenCalled();
});
