import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRequestError } from "@/components/workspace/account-api";
import { accountProjectPageSchema } from "@/domain/project-pages";
import { namesAssistantProjectHref, namesAssistantProjects, readNamesAssistantProjects } from "@/features/names-assistant/projects";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const other = "dddddddd-1111-4111-8111-111111111111";
const id = (n: number) => `bbbbbbbb-1111-4111-8111-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: owner, generation: 1 };
const row = (n: number) => ({ id: id(n), owner_id: owner, scope: "complete_brand" as const, title: `Synthetic project ${n}`, current_revision: 1, deleted_at: null, deletion_requested_at: null, deletion_state: "active" as const, lifecycle_version: 0, created_at: "2026-10-05T12:00:00.000002Z" });
const page = (ids: number[], next: number | null = null) => accountProjectPageSchema.parse({ ownerId: owner, items: ids.map(row), nextCursor: next ? { id: id(next), createdAt: row(next).created_at } : null });
const options = () => ({ account, isCurrent: vi.fn(() => true), expire: vi.fn(), previous: null, signal: new AbortController().signal });
afterEach(() => vi.unstubAllGlobals());

describe("Names Assistant saved-project bridge", () => {
  it("loads only same-origin project reads without owner input, generation or storage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(page([3, 2])));
    vi.stubGlobal("fetch", fetch);
    const result = await readNamesAssistantProjects(options());
    expect(result?.items).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(fetch).toHaveBeenCalledWith("/api/projects/page?limit=50", expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin", mode: "same-origin" }));
  });
  it("appends projects using the exact microsecond/UUID cursor, including past 100 rows", async () => {
    const first = page(Array.from({ length: 100 }, (_, i) => 150 - i), 51);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(page(Array.from({ length: 50 }, (_, i) => 50 - i))));
    vi.stubGlobal("fetch", fetch);
    const next = await readNamesAssistantProjects({ ...options(), previous: first });
    expect(next?.items).toHaveLength(150);
    expect(next?.nextCursor).toBeNull();
    expect(fetch.mock.calls[0]?.[0]).toContain("cursorCreatedAt=2026-10-05T12%3A00%3A00.000002Z");
    await readNamesAssistantProjects({ ...options(), previous: next! });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("discards delayed replies after account generation changes", async () => {
    let finish!: (reply: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const args = options();
    const pending = readNamesAssistantProjects(args);
    args.isCurrent.mockReturnValue(false);
    finish(Response.json(page([1])));
    await expect(pending).resolves.toBeNull();
    expect(args.expire).not.toHaveBeenCalled();
  });
  it("discards aborted replies even when transport ignores cancellation", async () => {
    let finish!: (reply: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const controller = new AbortController();
    const pending = readNamesAssistantProjects({ ...options(), signal: controller.signal });
    controller.abort(); finish(Response.json(page([1])));
    await expect(pending).resolves.toBeNull();
  });
  it("does not begin reads for an obsolete or aborted account", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const args = options(); args.isCurrent.mockReturnValue(false);
    await expect(readNamesAssistantProjects(args)).resolves.toBeNull();
    const controller = new AbortController(); controller.abort();
    await expect(readNamesAssistantProjects({ ...options(), signal: controller.signal })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("hides and expires foreign-owner replies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page([1]), ownerId: other, items: [{ ...row(1), owner_id: other }] })));
    const args = options();
    await expect(readNamesAssistantProjects(args)).resolves.toBeNull();
    expect(args.expire).toHaveBeenCalledWith(account);
  });
  it("expires a current 401, but ignores an obsolete 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const args = options();
    await expect(readNamesAssistantProjects(args)).resolves.toBeNull();
    expect(args.expire).toHaveBeenCalledWith(account);
    let reject!: (reason: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, fail) => { reject = fail; })));
    const stale = options(); const pending = readNamesAssistantProjects(stale);
    stale.isCurrent.mockReturnValue(false); reject(new AccountRequestError(401));
    await expect(pending).resolves.toBeNull(); expect(stale.expire).not.toHaveBeenCalled();
  });
  it("rejects malformed and overlapping continuations without changing the prior list", async () => {
    const previous = page([3, 2], 2), before = JSON.stringify(previous);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(page([2, 1]))));
    await expect(readNamesAssistantProjects({ ...options(), previous })).rejects.toThrow();
    expect(JSON.stringify(previous)).toBe(before);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ projects: [row(1)] })));
    await expect(readNamesAssistantProjects(options())).rejects.toMatchObject({ status: 502 });
  });
  it("preserves errors for explicit retry without inventing projects", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(Response.json(page([1])));
    vi.stubGlobal("fetch", fetch);
    await expect(readNamesAssistantProjects(options())).rejects.toMatchObject({ status: 503 });
    await expect(readNamesAssistantProjects(options())).resolves.toEqual(page([1]));
  });
  it("will not reuse another account's listing", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(readNamesAssistantProjects({ ...options(), previous: { ...page([1]), ownerId: other } })).rejects.toMatchObject({ status: 502 });
    expect(fetch).not.toHaveBeenCalled();
    expect(namesAssistantProjects(page([1]), { ...account, userId: other }, "")).toEqual([]);
  });
  it("links each owned project to its existing Naming route", () => {
    expect(namesAssistantProjectHref(row(1), account)).toBe(`/brands/account/${id(1)}/naming`);
    expect(namesAssistantProjectHref(row(2), account)).toBe(`/brands/account/${id(2)}/naming`);
    expect(namesAssistantProjectHref({ ...row(1), scope: "complete_brand" }, account)).toContain("/naming");
    expect(namesAssistantProjectHref({ ...row(1), owner_id: other }, account)).toBeNull();
    expect(namesAssistantProjectHref({ ...row(1), id: "../../settings" }, account)).toBeNull();
  });
  it("filters copied presentation rows without changing pagination order or selection facts", () => {
    const listing = page([3, 2, 1]); const before = JSON.stringify(listing);
    listing.items[0]!.owner_id = other;
    const withOther = JSON.stringify(listing);
    expect(namesAssistantProjects(listing, account, "  PROJECT 2  ").map(project => project.id)).toEqual([id(2)]);
    expect(namesAssistantProjects(listing, account, "").map(project => project.id)).toEqual([id(2), id(1)]);
    expect(JSON.stringify(listing)).toBe(withOther); expect(before).not.toBe(withOther);
  });
});
