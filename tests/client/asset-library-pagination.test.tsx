// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetLibraryPageSchema, assetRevisionFreshness, type AssetLibraryItem, type AssetLibraryPage, type AssetLibraryQuery } from "@/domain/asset-library";
import { useAssetLibrary } from "@/components/assets/use-asset-library";
import { appendAssetLibraryPage, AssetLibraryWindowChangedError, readAssetLibraryWindow } from "@/components/assets/asset-library-window";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const session = vi.hoisted(() => ({ current: null as VerifiedAccount | null, expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    isCurrent: (account: VerifiedAccount) => session.current?.userId === account.userId && session.current.generation === account.generation,
    expire: session.expire,
  }),
}));
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1), projectId = id(2), otherProject = id(3);
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
const baseQuery: AssetLibraryQuery = { tab: "my_selection", limit: 40 };
function item(n: number, overrides: Partial<AssetLibraryItem["asset"]> = {}): AssetLibraryItem {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
  const asset = { id: id(1000 + n), ownerId: owner, projectId, kind: `Asset ${n}`, purpose: "brand_asset" as const, createdAt,
    versionCount: 1, retentionRevision: 0, liked: false, saved: true, usage: { active: false, legacy: false }, selectionRevision: 0, currentSelection: null, ...overrides };
  const version = { ownerId: asset.ownerId, projectId: asset.projectId, assetId: asset.id, versionId: id(2000 + n),
    contentHash: "a".repeat(64), inputHash: "b".repeat(64), inputRevision: 1, versionNumber: 1, createdAt,
    mimeType: "image/png", format: "png" as const, provenance: { status: "legacy_unverified" as const },
    vectorStatus: "unverified" as const, licenseStatus: "unverified" as const, fileState: "unverified" as const,
    fileVerification: null, freshness: assetRevisionFreshness(1, 1) };
  return { asset, project: { id: asset.projectId, owner_id: asset.ownerId, title: asset.projectId === projectId ? "First project" : "Other project",
    scope: "complete_brand", current_revision: 1, created_at: createdAt },
  selectedVersion: null, displayedVersion: version, matchingVersions: { ownerId: asset.ownerId, projectId: asset.projectId, assetId: asset.id, format: null, items: [version], totalCount: 1, nextCursor: null } };
}
const cursorFor = (row: AssetLibraryItem, query: AssetLibraryQuery) => ({ createdAt: row.asset.createdAt, assetId: row.asset.id, tab: query.tab, projectId: query.projectId ?? null, format: query.format ?? null });
function pageFor(rows: AssetLibraryItem[], query: AssetLibraryQuery): AssetLibraryPage {
  const matching = rows.filter(row => (query.tab !== "my_selection" || row.asset.saved || row.asset.liked || row.asset.usage.active || row.asset.usage.legacy)
    && (!query.projectId || query.projectId === row.asset.projectId)
    && (!query.format || query.format === row.displayedVersion?.format)
    && (!query.cursor || row.asset.createdAt < query.cursor.createdAt || (row.asset.createdAt === query.cursor.createdAt && row.asset.id < query.cursor.assetId)))
    .sort((a, b) => b.asset.createdAt.localeCompare(a.asset.createdAt) || b.asset.id.localeCompare(a.asset.id));
  const items = matching.slice(0, query.limit).map(row => ({ ...row, matchingVersions: { ...row.matchingVersions, format: query.format ?? null } }));
  return assetLibraryPageSchema.parse({ ownerId: items[0]?.asset.ownerId ?? session.current?.userId ?? owner, query, items,
    nextCursor: matching.length > query.limit ? cursorFor(items.at(-1)!, query) : null });
}
type PendingRead = { query: AssetLibraryQuery; signal: AbortSignal; resolve: (response: Response) => void };
type PendingWrite = { assetId: string; input: { liked: boolean; saved: boolean; expectedRetentionRevision: number }; resolve: (response: Response) => void };
let root: Root, host: HTMLDivElement, library: ReturnType<typeof useAssetLibrary>;
let rows: AssetLibraryItem[], pendingReads: PendingRead[], pendingWrites: PendingWrite[], reads: AssetLibraryQuery[];
let holdReads: boolean, holdWrites: boolean, writeStatus: number, nextReadStatus: number;
function Probe({ account }: { account: VerifiedAccount }) {
  const value = useAssetLibrary(account);
  useLayoutEffect(() => { library = value; });
  return <div>{value.page?.items.map(row => <article key={row.asset.id} data-id={row.asset.id}>{row.asset.kind}</article>)}</div>;
}
async function render(next = account) {
  session.current = next;
  await act(async () => root.render(<Probe key={`${next.userId}:${next.generation}`} account={next} />));
}
async function resolveRead(index: number, response?: Response) {
  await act(async () => {
    const pending = pendingReads[index]!;
    pending.resolve(response ?? Response.json(pageFor(rows, pending.query)));
  });
}
function applyWrite(pending: Omit<PendingWrite, "resolve">): Response {
  if (writeStatus !== 200) return new Response(null, { status: writeStatus });
  const row = rows.find(row => row.asset.id === pending.assetId)!;
  const updated = { ...row, asset: { ...row.asset, liked: pending.input.liked, saved: pending.input.saved, retentionRevision: pending.input.expectedRetentionRevision + 1 } };
  rows = rows.map(row => row.asset.id === pending.assetId ? updated : row);
  return Response.json({ asset: updated.asset, project: updated.project });
}
async function loadTwoPages() {
  await render();
  expect(library.page?.items).toHaveLength(40);
  await act(async () => library.loadMore());
  expect(library.page?.items).toHaveLength(80);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  session.current = account; session.expire.mockReset();
  rows = Array.from({ length: 125 }, (_, n) => item(n + 1));
  pendingReads = []; pendingWrites = []; reads = []; holdReads = false; holdWrites = false; writeStatus = 200; nextReadStatus = 200;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
    if (path === "/api/projects") return Promise.resolve(Response.json({ projects: [] }));
    if (path.includes("/retention")) {
      const pending = { assetId: path.split("/")[4]!, input: JSON.parse(options.body as string) as PendingWrite["input"] };
      if (holdWrites) return new Promise<Response>(resolve => pendingWrites.push({ ...pending, resolve }));
      return Promise.resolve(applyWrite(pending));
    }
    const url = new URL(path, "https://fixture.invalid");
    expect(url.pathname).toBe("/api/assets");
    const query = { ...Object.fromEntries(url.searchParams), limit: Number(url.searchParams.get("limit")), ...(url.searchParams.has("cursor") ? { cursor: JSON.parse(url.searchParams.get("cursor")!) } : {}) } as AssetLibraryQuery;
    reads.push(query);
    if (holdReads) return new Promise<Response>(resolve => pendingReads.push({ query, signal: options.signal!, resolve }));
    if (nextReadStatus !== 200) { const status = nextReadStatus; nextReadStatus = 200; return Promise.resolve(new Response(null, { status })); }
    return Promise.resolve(Response.json(pageFor(rows, query)));
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("loaded asset window reconciliation", () => {
  it.each(["liked", "saved"] as const)("retains two loaded pages and card nodes after an acknowledged %s change", async field => {
    await loadTwoPages();
    const original = library.page!, row = original.items[70]!, card = host.querySelector(`[data-id="${row.asset.id}"]`);
    if (field === "saved") {
      // Keep it in My selection when the save flag is removed.
      rows = rows.map(value => value.asset.id === row.asset.id ? { ...value, asset: { ...value.asset, liked: true } } : value);
      await act(async () => library.refresh());
    }
    const currentRow = library.page!.items[70]!;
    await act(async () => library.retain(currentRow, field));
    expect(library.page?.items.map(row => row.asset.id)).toEqual(original.items.map(row => row.asset.id));
    expect(library.page?.items[70]?.asset[field]).toBe(!currentRow.asset[field]);
    expect(library.page?.nextCursor).toEqual(original.nextCursor);
    expect(host.querySelector(`[data-id="${row.asset.id}"]`)).toBe(card);
    expect(library.status).toBe("ready");
    await act(async () => library.loadMore());
    expect(library.page?.items).toHaveLength(120);
    expect(new Set(library.page?.items.map(row => row.asset.id)).size).toBe(120);
  });

  it("holds all verified cards until the whole refresh succeeds, then reconciles deletions and metadata", async () => {
    await loadTwoPages();
    const original = library.page!, removed = original.items[55]!, boundary = original.items.at(-1)!;
    rows = rows.filter(row => row.asset.id !== removed.asset.id && row.asset.id !== boundary.asset.id)
      .map(row => row.asset.id === original.items[60]!.asset.id ? { ...row, asset: { ...row.asset, kind: "Changed kind" } } : row);
    holdReads = true;
    await act(async () => library.refresh());
    expect(library.page).toBe(original);
    await resolveRead(0);
    expect(library.page).toBe(original);
    expect(library.status).toBe("loading");
    await resolveRead(1);
    expect(library.page?.items).toHaveLength(80);
    expect(library.page?.items.some(row => row.asset.id === removed.asset.id || row.asset.id === boundary.asset.id)).toBe(false);
    expect(library.page?.items.find(row => row.asset.id === original.items[60]!.asset.id)?.asset.kind).toBe("Changed kind");
    expect(library.page?.nextCursor?.assetId).toBe(library.page?.items.at(-1)?.asset.id);
  });

  it("includes new head rows without dropping the previous oldest loaded page", async () => {
    await loadTwoPages();
    const original = library.page!;
    rows.push(...Array.from({ length: 7 }, (_, n) => item(126 + n)));
    await act(async () => library.refresh());
    expect(library.page?.items).toHaveLength(120);
    expect(original.items.every(previous => library.page!.items.some(row => row.asset.id === previous.asset.id))).toBe(true);
    expect(reads.slice(2)).toHaveLength(3);
    expect(library.page?.nextCursor?.assetId).toBe(library.page?.items.at(-1)?.asset.id);
  });

  it("removes an unretained boundary card only after acknowledgment and refreshes through its old position", async () => {
    await loadTwoPages();
    const boundary = library.page!.items.at(-1)!;
    holdWrites = true;
    let write!: Promise<void>;
    await act(async () => { write = library.retain(boundary, "saved"); });
    expect(library.page?.items.at(-1)?.asset.id).toBe(boundary.asset.id);
    await act(async () => { pendingWrites[0]!.resolve(applyWrite(pendingWrites[0]!)); await write; });
    expect(library.page?.items).toHaveLength(80);
    expect(library.page?.items.some(row => row.asset.id === boundary.asset.id)).toBe(false);
    expect(library.page!.items.at(-1)!.asset.createdAt < boundary.asset.createdAt).toBe(true);
  });

  it("reaches the real end cursor when removals shrink the loaded window", async () => {
    await loadTwoPages();
    rows = rows.slice(-45);
    await act(async () => library.refresh());
    expect(library.page?.items).toHaveLength(45);
    expect(library.page?.nextCursor).toBeNull();
    const count = reads.length;
    await act(async () => library.loadMore());
    expect(reads).toHaveLength(count);
  });

  it("preserves the complete loaded view on a later-page refresh failure and retries all pages", async () => {
    await loadTwoPages();
    const original = library.page!;
    holdReads = true;
    await act(async () => library.refresh());
    await resolveRead(0);
    await resolveRead(1, new Response(null, { status: 503 }));
    expect(library.page).toBe(original);
    expect(library.status).toBe("error");
    expect(library.error).toMatch(/unavailable/);
    holdReads = false;
    await act(async () => library.refresh());
    expect(library.page?.items).toHaveLength(80);
    expect(library.status).toBe("ready");
  });

  it("never invents saved state after a failed retention request and checks before retrying writes", async () => {
    await loadTwoPages();
    const original = library.page!;
    writeStatus = 409;
    await act(async () => library.retain(original.items[60]!, "saved"));
    expect(library.page).toBe(original);
    expect(library.needsCheck).toBe(true);
    expect(reads).toHaveLength(2);
    writeStatus = 200;
    await act(async () => library.retain(original.items[60]!, "saved"));
    expect(library.page).toBe(original);
    await act(async () => library.refresh());
    expect(library.page?.items).toHaveLength(80);
    expect(library.needsCheck).toBe(false);
  });

  it("keeps the acknowledged flag and all other pages when post-save reconciliation fails", async () => {
    await loadTwoPages();
    const row = library.page!.items[60]!;
    holdReads = true;
    await act(async () => library.retain(row, "liked"));
    expect(library.page?.items).toHaveLength(80);
    expect(library.page?.items[60]?.asset).toMatchObject({ liked: true, retentionRevision: 1 });
    await resolveRead(0); await resolveRead(1, new Response(null, { status: 503 }));
    expect(library.page?.items).toHaveLength(80);
    expect(library.page?.items[60]?.asset).toMatchObject({ liked: true, retentionRevision: 1 });
    expect(library.status).toBe("error");
  });
});

describe("private query and request fencing", () => {
  it.each([
    { tab: "all_generations" as const },
    { tab: "my_selection" as const, projectId: otherProject },
    { tab: "my_selection" as const, format: "png" as const },
  ])("discards a delayed old window after switching filters to %j", async query => {
    await loadTwoPages();
    holdReads = true;
    await act(async () => library.refresh());
    await resolveRead(0);
    expect(pendingReads).toHaveLength(2);
    await act(async () => library.changeQuery(query));
    expect(library.page).toBeNull();
    expect(pendingReads[1]!.signal.aborted).toBe(true);
    await resolveRead(2);
    const current = library.page;
    await resolveRead(1);
    expect(library.page).toBe(current);
    expect(library.query).toMatchObject(query);
    expect(library.page?.items.length).toBeLessThanOrEqual(40);
  });

  it.each([account.userId, id(99)])("discards late prior-generation responses after remount for %s", async userId => {
    await loadTwoPages();
    holdReads = true;
    await act(async () => library.refresh());
    await resolveRead(0);
    const staleReply = pageFor(rows, pendingReads[1]!.query);
    await render({ status: "ready", userId, generation: 2 });
    expect(library.page).toBeNull();
    expect(pendingReads[1]!.signal.aborted).toBe(true);
    rows = [item(1, { ownerId: userId })];
    await resolveRead(2);
    const current = library.page;
    await resolveRead(1, Response.json(staleReply));
    expect(library.page).toBe(current);
    expect(library.page?.ownerId).toBe(userId);
    expect(library.page?.items).toHaveLength(1);
    expect(session.expire).not.toHaveBeenCalled();
  });

  it("cannot apply a late acknowledged write to a replacement account generation", async () => {
    await loadTwoPages();
    holdWrites = true;
    let write!: Promise<void>;
    await act(async () => { write = library.retain(library.page!.items[60]!, "liked"); });
    const reply = applyWrite(pendingWrites[0]!);
    rows = [item(1, { ownerId: id(99) })];
    await render({ status: "ready", userId: id(99), generation: 2 });
    const current = library.page;
    await act(async () => { pendingWrites[0]!.resolve(reply); await write; });
    expect(library.page).toBe(current);
    expect(library.page?.ownerId).toBe(id(99));
    expect(library.page?.items).toHaveLength(1);
    expect(library.busy).toBe(false);
  });

  it("does not accept a stale card action between a query reset and its replacement read", async () => {
    await loadTwoPages();
    const oldRetain = library.retain, row = library.page!.items[60]!;
    holdReads = true; holdWrites = true;
    await act(async () => {
      library.changeQuery({ tab: "my_selection", projectId: otherProject });
      await oldRetain(row, "saved");
    });
    expect(pendingWrites).toHaveLength(0);
    expect(library.page).toBeNull();
  });

  it("lets a new refresh supersede pagination without a stale finally unlocking a later write", async () => {
    await loadTwoPages();
    holdReads = true;
    let more!: Promise<void>;
    await act(async () => { more = library.loadMore(); });
    await act(async () => library.refresh());
    expect(pendingReads[0]!.signal.aborted).toBe(true);
    await resolveRead(1); await resolveRead(2);
    expect(library.page?.items).toHaveLength(80);
    holdWrites = true;
    let write!: Promise<void>;
    await act(async () => { write = library.retain(library.page!.items[60]!, "liked"); });
    await resolveRead(0); await more;
    expect(library.busy).toBe(true);
    expect(library.page?.items).toHaveLength(80);
    await act(async () => library.retain(library.page!.items[61]!, "saved"));
    expect(pendingWrites).toHaveLength(1);
    holdReads = false;
    await act(async () => { pendingWrites[0]!.resolve(applyWrite(pendingWrites[0]!)); await write; });
    expect(library.busy).toBe(false);
  });

  it("ignores an older refresh arriving after its successful replacement", async () => {
    await loadTwoPages();
    holdReads = true;
    await act(async () => library.refresh());
    await act(async () => library.refresh());
    await resolveRead(1); await resolveRead(2);
    const current = library.page;
    await resolveRead(0);
    expect(library.page).toBe(current);
    expect(library.status).toBe("ready");
  });

  it("serializes rapid like/save attempts and does not refresh during an unresolved write", async () => {
    await loadTwoPages();
    holdWrites = true;
    let first!: Promise<void>;
    await act(async () => {
      first = library.retain(library.page!.items[50]!, "liked");
      void library.retain(library.page!.items[50]!, "saved");
      library.refresh();
    });
    expect(pendingWrites).toHaveLength(1);
    expect(reads).toHaveLength(2);
    await act(async () => { pendingWrites[0]!.resolve(applyWrite(pendingWrites[0]!)); await first; });
    holdWrites = false;
    await act(async () => library.retain(library.page!.items[50]!, "saved"));
    expect(library.page?.items[50]?.asset).toMatchObject({ liked: true, saved: false, retentionRevision: 2 });
    expect(library.page?.items).toHaveLength(80);
  });
});

describe("window traversal contracts", () => {
  it("deduplicates overlapping pages without replacing the last server cursor", () => {
    const first = pageFor(rows, baseQuery), second = pageFor(rows, { ...baseQuery, cursor: first.nextCursor! });
    const repeated = { ...second, items: [first.items[5]!, ...second.items] };
    const combined = appendAssetLibraryPage(first, repeated);
    expect(combined.items).toHaveLength(80);
    expect(combined.nextCursor).toEqual(second.nextCursor);
  });

  it("rejects owner/filter contamination and non-advancing cursors", () => {
    const first = pageFor(rows, baseQuery);
    expect(() => appendAssetLibraryPage(first, { ...first, ownerId: id(99) })).toThrow();
    expect(() => appendAssetLibraryPage(first, { ...first, query: { ...baseQuery, projectId: otherProject } })).toThrow();
    expect(() => appendAssetLibraryPage(first, { ...first, query: { ...baseQuery, cursor: first.nextCursor! } })).toThrow();
  });

  it("compares cursor positions at full timestamp precision, including timezone offsets", async () => {
    const old = item(1, { createdAt: "2026-10-01T00:00:00.000001Z" });
    const newer = item(2, { createdAt: "2026-10-01T01:00:00.000002+01:00" });
    const query = { ...baseQuery, limit: 1 };
    const previous = { ownerId: owner, query, items: [old], nextCursor: null };
    const list = vi.fn().mockResolvedValueOnce({ ownerId: owner, query, items: [newer], nextCursor: cursorFor(newer, query) })
      .mockResolvedValueOnce({ ownerId: owner, query: { ...query, cursor: cursorFor(newer, query) }, items: [old], nextCursor: null });
    const reply = await readAssetLibraryWindow({ current: () => true, list }, query, previous, new AbortController().signal);
    expect(list).toHaveBeenCalledTimes(2);
    expect(reply?.items).toEqual([newer, old]);
  });

  it("bounds head churn and does not publish a truncated replacement", async () => {
    const query = { ...baseQuery, limit: 1 }, previous = pageFor(rows.slice(0, 1), query);
    const list = vi.fn(async (request: Partial<AssetLibraryQuery>) => pageFor(rows, request as AssetLibraryQuery));
    await expect(readAssetLibraryWindow({ current: () => true, list }, query, previous, new AbortController().signal)).rejects.toBeInstanceOf(AssetLibraryWindowChangedError);
    expect(list).toHaveBeenCalledTimes(11);
    expect(previous.items).toHaveLength(1);
  });
});
