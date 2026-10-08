import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoBatchHistory, logoBatchRecoveryRequestKeys, checkLogoBatchRequests } from "../../src/components/logo-creation/batch-history";
import { syntheticLogoBatch, syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoConceptBatch, LogoRequestState } from "../../src/domain/logo-jobs";

const saved = syntheticLogoWorkspace(), account = { status: "ready" as const, userId: saved.ownerId, generation: 1 };
const one = { id: id(60), requestKey: id(61), createdAt: "2026-10-06T12:00:00Z" };
const two = { id: id(62), requestKey: id(63), createdAt: "2026-10-06T13:00:00Z" };
const envelope = (items: typeof one[], nextCursor: string | null = null) => ({ ownerId: saved.ownerId, projectId: saved.projectId, items, nextCursor });
function fixture() {
  let current = true, summaries = [one], nextCursor: string | null = null, unavailable = false, hold: (() => Promise<Response>) | null = null;
  const requests: { path: string; method: string }[] = [];
  const client = createAccountLogoClient(account, saved.projectId, () => current, () => undefined, async (path, options) => {
    requests.push({ path: String(path), method: options?.method ?? "GET" });
    if (hold) return hold();
    if (unavailable) return new Response(null, { status: 503 });
    const url = new URL(String(path), "http://fixture.test");
    return Response.json(url.searchParams.has("cursor") ? envelope([one]) : envelope(summaries, nextCursor));
  });
  const history = () => createLogoBatchHistory({ client, ownerId: saved.ownerId, projectId: saved.projectId, isCurrent: () => current });
  return { history, requests, client, more() { summaries = [two]; }, pages() { summaries = [two]; nextCursor = two.id; }, fail() { unavailable = true; }, foreign() { current = false; }, hold(fn: () => Promise<Response>) { hold = fn; } };
}

describe("durable logo batch discovery", () => {
  it("a first admitted batch is discoverable after reload with no selection stage or volatile receipt", async () => {
    const f = fixture(), first = f.history(); await first.refresh();
    expect(saved.stages.concepts).toBeNull(); expect(first.getSnapshot().items).toEqual([one]); first.dispose();
    const reloaded = f.history(); await reloaded.refresh(); expect(reloaded.getSnapshot().items).toEqual([one]);
    expect(f.requests.every(request => request.method === "GET")).toBe(true);
  });
  it("a More batch is discovered after a fresh reload and older pages remain explicitly reachable", async () => {
    const f = fixture(); f.pages(); const reloaded = f.history(); await reloaded.refresh();
    expect(reloaded.getSnapshot().items[0]).toEqual(two); expect(reloaded.getSnapshot().nextCursor).toBe(two.id);
    await reloaded.loadMore(); expect(reloaded.getSnapshot().items.map(item => item.id)).toEqual([two.id, one.id]);
    expect(f.requests[1]?.path).toContain(`cursor=${two.id}`); expect(f.requests.every(request => request.method === "GET")).toBe(true);
  });
  it("failed refresh preserves already discovered work instead of inventing an empty history", async () => {
    const f = fixture(), history = f.history(); await history.refresh(); f.fail(); await history.refresh();
    expect(history.getSnapshot().items).toEqual([one]); expect(history.getSnapshot().error).not.toBeNull();
  });
  it("account change fences a late list and drops visible private history", async () => {
    const f = fixture(), history = f.history(); await history.refresh();
    let resolve!: (response: Response) => void; f.hold(() => new Promise(yes => { resolve = yes; }));
    const loading = history.refresh(); f.foreign(); resolve(Response.json(envelope([two]))); await loading;
    expect(history.getSnapshot().items).toEqual([]); expect(history.getSnapshot().loaded).toBe(false);
  });
  it("one in-flight list serves repeated load clicks without extra requests", async () => {
    const f = fixture(), history = f.history();
    let resolve!: (response: Response) => void; f.hold(() => new Promise(yes => { resolve = yes; }));
    const loading = history.refresh(); await history.refresh(); expect(f.requests).toHaveLength(1);
    resolve(Response.json(envelope([one]))); await loading; expect(history.getSnapshot().items).toEqual([one]);
  });
});

function retryBatch(): LogoConceptBatch {
  const original = syntheticLogoBatch(), slot = original.slots[5]!, attempt = slot.attempts[0]!;
  return { ...original, slots: original.slots.map(row => row.id === slot.id ? { ...row, attempts: [attempt,
    { ...attempt, id: id(911), jobId: id(912), requestKey: id(913), previousAttemptId: attempt.id, attemptNumber: 2 },
    { ...attempt, id: id(914), jobId: id(915), requestKey: id(916), previousAttemptId: id(911), attemptNumber: 3, state: "needs_reconciliation", reason: "outcome_unknown", billing: { status: "unknown", confirmedMicrousd: null } },
  ] } : row) };
}
describe("reconciliation follows immutable attempt request keys", () => {
  it("reload of retry R3 checks R3 rather than original batch R1 or confirmed failed R2", () => {
    const batch = retryBatch(); expect(batch.requestKey).toBe(id(61)); expect(logoBatchRecoveryRequestKeys(batch)).toEqual([id(916)]);
  });
  it("all uncertain retry keys are checked once without losing five saved successes", async () => {
    const batch = retryBatch(), failed = batch.slots[5]!;
    const withTwo = { ...batch, slots: batch.slots.map(slot => slot.id === failed.id ? { ...slot, attempts: slot.attempts.map(attempt => attempt.id === id(911) ? { ...attempt, state: "needs_reconciliation" as const, reason: "outcome_unknown", billing: { status: "unknown" as const, confirmedMicrousd: null } } : attempt) } : slot) };
    const before = JSON.stringify(withTwo), paths: string[] = [];
    const client = createAccountLogoClient(account, saved.projectId, () => true, () => undefined, async (path, init) => {
      paths.push(`${init?.method} ${path}`);
      const key = String(path).replace(/\/reconcile$/, "").split("/").at(-1)!;
      const state: LogoRequestState = { status: "needs_reconciliation", requestKey: key, receipt: null, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: "outcome_unknown" };
      return Response.json(state);
    });
    const results = await checkLogoBatchRequests({ client, requestKeys: logoBatchRecoveryRequestKeys(withTwo), isCurrent: () => true, signal: new AbortController().signal });
    expect(results.map(result => result.requestKey)).toEqual([id(913), id(916)]);
    expect(paths).toHaveLength(4); expect(paths.some(path => path.includes(id(61)))).toBe(false);
    expect(paths.filter(path => path.startsWith("POST ")).every(path => path.endsWith("/reconcile"))).toBe(true);
    expect(withTwo.slots.filter(slot => slot.acceptedPreview)).toHaveLength(5); expect(JSON.stringify(withTwo)).toBe(before);
  });
  it("not_found stays read-only and one failed check does not hide other uncertain requests", async () => {
    const paths: string[] = [], client = createAccountLogoClient(account, saved.projectId, () => true, () => undefined, async path => {
      paths.push(String(path)); return String(path).endsWith(id(916)) ? new Response(null, { status: 503 }) : Response.json({ status: "not_found" });
    });
    const results = await checkLogoBatchRequests({ client, requestKeys: [id(913), id(916)], isCurrent: () => true, signal: new AbortController().signal });
    expect(results).toHaveLength(2); expect(results[0]?.state?.status).toBe("not_found"); expect(results[1]?.error).not.toBeNull(); expect(paths).toHaveLength(2);
  });
});
