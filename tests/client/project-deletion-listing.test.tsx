// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountProjectListing } from "@/components/workspace/account-projects";
import { HomeRecentBrands } from "@/components/workspace/home-recent-brands";
import { ProjectsWorkspace } from "@/components/workspace/projects-workspace";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | { status: "checking"; generation: number } | null, current: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }) }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const a = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", owner_id: owner, title: "Synthetic recent project", scope: "complete_brand", current_revision: 3, lifecycle_version: 0, deleted_at: null as string | null, created_at: "2026-10-15T12:00:00Z" };
const b = { ...a, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Synthetic older project", created_at: "2026-10-14T12:00:00Z" };
const c = { ...a, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", title: "Synthetic oldest project", created_at: "2026-10-13T12:00:00Z" };
const cursor = (row: typeof a) => ({ id: row.id, createdAt: row.created_at });
const page = (items: typeof a[], more = false, ownerId = owner) => Response.json({ ownerId, items, nextCursor: more ? cursor(items.at(-1)!) : null });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let host: HTMLDivElement, root: Root, fetcher: ReturnType<typeof vi.fn>;
function Listing({ account, state }: { account: VerifiedAccount; state: "active" | "deleted" }) {
  const { listing, load, reload, remove, error, pending } = useAccountProjectListing(account, state);
  return <><ul>{listing?.items.map(row => <li key={row.id}>{row.title}</li>)}</ul>{error && <p role="alert">Listing failed</p>}{pending && <p role="status">Pending</p>}<button type="button" onClick={() => void load()}>Load</button><button type="button" onClick={() => void reload()}>Refresh</button><button type="button" onClick={() => remove(b.id)}>Remove older</button></>;
}
async function render(state: "active" | "deleted" = "active") { await act(async () => root.render(mock.session?.status === "ready" ? <Listing key={`${mock.session.userId}:${mock.session.generation}:${state}`} account={mock.session} state={state} /> : <p>Checking account</p>)); }
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) => mock.session?.status === "ready" && account.userId === mock.session.userId && account.generation === mock.session.generation);
  mock.expire.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  fetcher = vi.fn(async () => page([a, b])); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("active and deleted account collection reads", () => {
  it("remounts a direct deleted view and never combines its rows with active projects", async () => {
    await render(); expect(fetcher.mock.calls[0]![0]).toBe("/api/projects/page?limit=50"); expect(host.textContent).toContain(a.title);
    fetcher.mockResolvedValue(page([{ ...c, deleted_at: "2026-10-15T15:00:00Z", lifecycle_version: 1 }]));
    await render("deleted"); expect(fetcher.mock.lastCall![0]).toBe("/api/projects/page?limit=50&state=deleted");
    expect(host.textContent).toContain(c.title); expect(host.textContent).not.toContain(a.title);
  });
  it.each(["wrong collection", "missing lifecycle"])("fails closed on %s metadata", async mode => {
    const row = { ...a } as Record<string, unknown>;
    if (mode === "wrong collection") row.deleted_at = "2026-10-15T15:00:00Z";
    else delete row.lifecycle_version;
    fetcher.mockResolvedValue(Response.json({ ownerId: owner, items: [row], nextCursor: null }));
    await render(); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.textContent).not.toContain(a.title);
  });
  it("retains the server cursor after removing the loaded cursor row", async () => {
    fetcher.mockResolvedValueOnce(page([a, b], true)).mockResolvedValueOnce(page([c]));
    await render(); await click("Remove older"); await click("Load");
    const url = new URL(fetcher.mock.lastCall![0], "https://example.invalid");
    expect(url.searchParams.get("cursorCreatedAt")).toBe(b.created_at); expect(url.searchParams.get("cursorId")).toBe(b.id);
    expect(host.textContent).toContain(a.title); expect(host.textContent).toContain(c.title); expect(host.textContent).not.toContain(b.title);
  });
  it("preserves loaded projects through a later-page error and retries that continuation", async () => {
    fetcher.mockResolvedValueOnce(page([a, b], true)).mockRejectedValueOnce(new Error("Synthetic offline")).mockResolvedValueOnce(page([c]));
    await render(); await click("Load"); expect(host.textContent).toContain(a.title); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click("Load"); expect(fetcher.mock.calls[2]![0]).toBe(fetcher.mock.calls[1]![0]); expect(host.textContent).toContain(c.title);
  });
  it("retries a failed first-page refresh even after an exhausted listing", async () => {
    fetcher.mockResolvedValueOnce(page([a, b])).mockRejectedValueOnce(new Error("Synthetic offline")).mockResolvedValueOnce(page([a]));
    await render(); await click("Refresh"); expect(host.textContent).toContain(b.title); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click("Load"); expect(fetcher).toHaveBeenCalledTimes(3); expect(fetcher.mock.lastCall![0]).toBe("/api/projects/page?limit=50"); expect(host.textContent).not.toContain(b.title);
  });
  it("ignores a continuation that started before an acknowledged removal", async () => {
    const wait = deferred<Response>(); fetcher.mockResolvedValueOnce(page([a, b], true)).mockReturnValueOnce(wait.promise).mockResolvedValueOnce(page([c]));
    await render(); await click("Load"); await click("Remove older"); expect(fetcher.mock.calls[1]![1].signal.aborted).toBe(true);
    await act(async () => wait.resolve(page([c]))); expect(host.textContent).not.toContain(b.title); expect(host.textContent).not.toContain(c.title);
    await click("Load"); expect(host.textContent).toContain(c.title);
  });
  it("times out even when fetch ignores abort, and a fresh read fences the late reply", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValueOnce(wait.promise).mockResolvedValueOnce(page([b]));
    await render(); await act(async () => vi.advanceTimersByTimeAsync(15_000)); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.querySelector('[role="status"]')).toBeNull();
    await click("Load"); await act(async () => wait.resolve(page([a]))); expect(host.textContent).toContain(b.title); expect(host.textContent).not.toContain(a.title);
  });
  it("hides and aborts old-owner reads during session reverification", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValueOnce(wait.promise).mockResolvedValueOnce(page([{ ...b, owner_id: other }], false, other));
    await render(); mock.session = { status: "checking", generation: 2 }; await render();
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    mock.session = { status: "ready", userId: other, generation: 3 }; await render(); await act(async () => wait.resolve(page([a])));
    expect(host.textContent).toContain(b.title); expect(host.textContent).not.toContain(a.title);
  });
});

it("refills Home after deleting its last loaded card and never claims older projects do not exist", async () => {
  const refill = deferred<Response>();
  fetcher.mockResolvedValueOnce(page([a], true)).mockResolvedValueOnce(Response.json({ project: { ...a, lifecycle_version: 1, deleted_at: "2026-10-15T15:00:00Z" } })).mockReturnValueOnce(refill.promise);
  await act(async () => root.render(<HomeRecentBrands />));
  await click(`Project options for ${a.title}`); await click("Delete"); await click("Delete project");
  expect(fetcher).toHaveBeenCalledTimes(3); expect(fetcher.mock.lastCall![0]).toBe("/api/projects/page?limit=6");
  expect(host.textContent).not.toContain("Your first brand"); expect(host.textContent).toContain("Loading your projects");
  await act(async () => refill.resolve(page([b])));
  expect(host.textContent).toContain(b.title); expect(host.textContent).not.toContain("Your first brand"); expect(host.querySelector(".home-brand-card a button")).toBeNull();
});

it("moves an acknowledged card into the direct recovery view and restores it with focus and notices", async () => {
  let saved = { ...a };
  fetcher.mockImplementation(async (path: string, options: RequestInit) => {
    if (path.startsWith("/api/projects/page")) {
      const state = new URL(path, "https://example.invalid").searchParams.get("state");
      return page(Boolean(saved.deleted_at) === (state === "deleted") ? [saved] : []);
    }
    expect(path).toBe(`/api/projects/${a.id}/deletion`);
    expect(JSON.parse(String(options.body))).toEqual({ expectedRevision: saved.current_revision, expectedLifecycleVersion: saved.lifecycle_version });
    saved = { ...saved, lifecycle_version: saved.lifecycle_version + 1, deleted_at: options.method === "POST" ? "2026-10-15T15:00:00Z" : null };
    return Response.json({ project: saved });
  });
  await act(async () => root.render(<ProjectsWorkspace />));
  expect(host.querySelector(".project-card a button")).toBeNull();
  await click(`Project options for ${a.title}`); await click("Delete"); await click("Delete project");
  expect(host.querySelector(".project-card")).toBeNull(); expect(host.querySelector('[role="status"]')?.textContent).toContain("moved to Deleted projects");
  expect(host.querySelector('a[href="/brands?state=deleted"]')).not.toBeNull(); expect(document.activeElement).toBe(host.querySelector(".projects-heading h1"));
  await act(async () => root.render(<ProjectsWorkspace state="deleted" />));
  expect(host.querySelector(".project-card")?.textContent).toContain(a.title); expect(host.querySelector(".project-card a")).toBeNull();
  await click("Restore");
  expect(host.querySelector(".project-card")).toBeNull(); expect(host.querySelector('[role="status"]')?.textContent).toContain("restored"); expect(document.activeElement).toBe(host.querySelector(".projects-heading h1"));
  expect(saved.current_revision).toBe(a.current_revision); expect(saved.lifecycle_version).toBe(2); expect(saved.deleted_at).toBeNull();
  expect(fetcher.mock.calls.filter(([, options]) => options.method !== "GET").map(([, options]) => options.method)).toEqual(["POST", "DELETE"]);
});
