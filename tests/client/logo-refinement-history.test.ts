import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoRefinementHistory } from "../../src/components/logo-creation/refinement-history";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoRasterRefinement } from "../../src/domain/logo-jobs";

const saved = syntheticLogoWorkspace(),
  one = syntheticRasterRefinement();
const two = syntheticRasterRefinement({
  id: id(520),
  requestKey: id(521),
  jobId: id(522),
  createdAt: "2026-10-06T13:00:00Z",
});
function fixture() {
  let current = true;
  const requests: { path: string; method: string; signal?: AbortSignal | null }[] = [];
  const state = {
    items: [one],
    nextCursor: null as string | null,
    older: [one],
    olderCursor: null as string | null,
    fail: false,
    records: new Map<string, LogoRasterRefinement | null>([
      [one.id, one],
      [two.id, two],
    ]),
    hold: null as null | ((path: string) => Promise<Response>),
    scope: { ownerId: saved.ownerId, projectId: saved.projectId },
  };
  const client = createAccountLogoClient(
    { status: "ready", userId: saved.ownerId, generation: 1 },
    saved.projectId,
    () => current,
    () => {
      current = false;
    },
    async (path, options) => {
      requests.push({ path: String(path), method: options?.method ?? "GET", signal: options?.signal });
      if (state.hold) return state.hold(String(path));
      if (state.fail) return new Response(null, { status: 503 });
      const url = new URL(String(path), "http://fixture.test");
      if (url.pathname.endsWith("/raster-refinements"))
        return Response.json({
          ...state.scope,
          items: url.searchParams.has("cursor") ? state.older : state.items,
          nextCursor: url.searchParams.has("cursor") ? state.olderCursor : state.nextCursor,
        });
      const record = state.records.get(url.pathname.split("/").at(-1)!);
      return record ? Response.json(record) : new Response(null, { status: 503 });
    },
  );
  const history = () =>
    createLogoRefinementHistory({
      client,
      ownerId: saved.ownerId,
      projectId: saved.projectId,
      isCurrent: () => current,
    });
  return {
    state,
    requests,
    history,
    foreign() {
      current = false;
    },
  };
}
describe("durable raster refinement discovery", () => {
  it("advances a live queued zero-cost observation to its paid committed result", async () => {
    const f = fixture();
    const queued = syntheticRasterRefinement({
      state: "queued",
      preview: null,
      providerResponseReceiptId: null,
      billing: { status: "recorded", confirmedMicrousd: 0 },
    });
    f.state.items = [queued];
    f.state.records.set(queued.id, queued);
    const history = f.history();
    await history.refresh();
    expect(history.getSnapshot().items[0]?.record.state).toBe("queued");
    f.state.items = [one];
    f.state.records.set(one.id, one);
    await history.refresh();
    expect(history.getSnapshot().error).toBeNull();
    expect(history.getSnapshot().items).toEqual([{ record: one, verified: true, error: null }]);
    history.dispose();
  });
  it("never changes recorded billing after the provider receipt has been retained", async () => {
    const f = fixture(),
      history = f.history();
    await history.refresh();
    const changed = { ...one, billing: { status: "recorded" as const, confirmedMicrousd: 1 } };
    f.state.items = [changed];
    f.state.records.set(one.id, changed);
    await history.refresh();
    expect(history.getSnapshot().error).not.toBeNull();
    expect(history.getSnapshot().items[0]?.record).toEqual(one);
    history.dispose();
  });
  it("reload discovers and verifies exact detail without a volatile request or selection", async () => {
    const f = fixture(),
      first = f.history();
    await first.refresh();
    first.dispose();
    const reloaded = f.history();
    await reloaded.refresh();
    expect(reloaded.getSnapshot().items).toEqual([{ record: one, verified: true, error: null }]);
    expect(
      f.requests.map((row) => row.path).filter((path) => path.endsWith(`/raster-refinements/${one.id}`)),
    ).toHaveLength(2);
    expect(f.requests.every((row) => row.method === "GET")).toBe(true);
    expect(f.requests[0]?.path).toContain("limit=20");
  });
  it("pages are explicit, deduplicated and retain earlier input history", async () => {
    const f = fixture();
    f.state.items = [two];
    f.state.nextCursor = "older";
    f.state.older = [two, one];
    const history = f.history();
    await history.refresh();
    expect(history.getSnapshot().items).toHaveLength(1);
    await history.loadMore();
    expect(history.getSnapshot().items.map((row) => row.record.id)).toEqual([two.id, one.id]);
    expect(history.getSnapshot().nextCursor).toBeNull();
    expect(history.getSnapshot().items[1]?.record.inputRevisions).toEqual(one.inputRevisions);
    const count = f.requests.length;
    await history.loadMore();
    expect(f.requests).toHaveLength(count);
  });
  it("rejects a repeated pagination cursor without discarding verified results", async () => {
    const f = fixture();
    f.state.nextCursor = "older";
    const history = f.history();
    await history.refresh();
    f.state.olderCursor = "older";
    await history.loadMore();
    expect(history.getSnapshot().error).not.toBeNull();
    expect(history.getSnapshot().items[0]?.verified).toBe(true);
  });
  it("rejects a cursor cycle across more than one page", async () => {
    const f = fixture();
    f.state.nextCursor = "a";
    const history = f.history();
    await history.refresh();
    f.state.olderCursor = "b";
    await history.loadMore();
    f.state.olderCursor = "a";
    await history.loadMore();
    expect(history.getSnapshot().error).not.toBeNull();
    expect(history.getSnapshot().items).toHaveLength(1);
  });
  it("unavailable details keep discovered metadata but cannot become a verified selection", async () => {
    const f = fixture();
    f.state.records.set(one.id, null);
    const history = f.history();
    await history.refresh();
    expect(history.getSnapshot().items[0]).toMatchObject({ record: one, verified: false });
    expect(history.getSnapshot().items[0]?.error).not.toBeNull();
  });
  it("refresh failure retains the last verified metadata and preview", async () => {
    const f = fixture(),
      history = f.history();
    await history.refresh();
    f.state.fail = true;
    await history.refresh();
    expect(history.getSnapshot().items[0]).toEqual({ record: one, verified: true, error: null });
    expect(history.getSnapshot().error).not.toBeNull();
  });
  it.each(["ownerId", "projectId"] as const)("foreign %s list results never appear", async (field) => {
    const f = fixture();
    f.state.scope[field] = id(999);
    const history = f.history();
    await history.refresh();
    expect(history.getSnapshot().items).toEqual([]);
    expect(history.getSnapshot().error).not.toBeNull();
  });
  it("detail identity drift cannot replace the listed immutable source", async () => {
    const f = fixture();
    f.state.records.set(one.id, { ...one, source: { kind: "refinement", rasterRevisionId: id(999) } });
    const history = f.history();
    await history.refresh();
    expect(history.getSnapshot().items[0]?.verified).toBe(false);
    expect(history.getSnapshot().items[0]?.record.source).toEqual(one.source);
  });
  it("duplicate IDs with changed immutable provenance cannot replace retained work", async () => {
    const f = fixture();
    f.state.nextCursor = "older";
    const history = f.history();
    await history.refresh();
    f.state.older = [{ ...one, requestKey: id(999) }];
    await history.loadMore();
    expect(history.getSnapshot().items[0]?.record.requestKey).toBe(one.requestKey);
    expect(history.getSnapshot().error).not.toBeNull();
  });
  it("changed committed hashes are rejected on refresh", async () => {
    const f = fixture(),
      history = f.history();
    await history.refresh();
    const changed = syntheticRasterRefinement({
      preview: {
        ...one.preview!,
        reference: { ...one.preview!.reference, contentHash: "b".repeat(64) },
        verification: { ...one.preview!.verification, contentHash: "b".repeat(64) },
      },
    });
    f.state.items = [changed];
    f.state.records.set(one.id, changed);
    await history.refresh();
    expect(history.getSnapshot().items[0]?.record.preview).toEqual(one.preview);
    expect(history.getSnapshot().error).not.toBeNull();
  });
  it("one in-flight list prevents repeated refresh and load-more calls", async () => {
    const f = fixture(),
      history = f.history();
    let resolve!: (value: Response) => void;
    f.state.hold = () =>
      new Promise((yes) => {
        resolve = yes;
      });
    const loading = history.refresh();
    await history.refresh();
    await history.loadMore();
    expect(f.requests).toHaveLength(1);
    f.state.hold = null;
    resolve(Response.json({ ...f.state.scope, items: [one], nextCursor: null }));
    await loading;
    expect(history.getSnapshot().items[0]?.verified).toBe(true);
  });
  it.each(["account", "dispose"] as const)("%s change aborts and fences a late detail", async (change) => {
    const f = fixture(),
      history = f.history();
    let resolve!: (value: Response) => void;
    f.state.hold = (path) =>
      path.includes("?")
        ? Promise.resolve(Response.json({ ...f.state.scope, items: [one], nextCursor: null }))
        : new Promise((yes) => {
            resolve = yes;
          });
    const loading = history.refresh();
    await new Promise((yes) => setTimeout(yes, 0));
    if (change === "account") f.foreign();
    else history.dispose();
    resolve(Response.json(one));
    await loading;
    expect(history.getSnapshot().items).toEqual([]);
    expect(history.getSnapshot().loaded).toBe(false);
    if (change === "dispose") expect(f.requests.at(-1)?.signal?.aborted).toBe(true);
  });
});
