import { describe, expect, it } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoCreationController } from "../../src/components/logo-creation/creation-controller";
import type { LogoGenerationIntent, LogoRequestState, LogoOperation } from "../../src/domain/logo-jobs";
import { syntheticLogoQuote, syntheticLogoReferences, syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function setup(readiness?: (operation: LogoOperation) => boolean) {
  let workspace = syntheticLogoWorkspace(), current = true, dirty = false, pending: LogoGenerationIntent | null = null;
  workspace = { ...workspace, capabilities: { ...workspace.capabilities, generate: { status: "available" } } };
  const quote = { ...syntheticLogoQuote(), estimatedCostMicrousd: 6000, maxCostMicrousd: 12000 };
  const source = syntheticResolvedLogoConcept(), reference = syntheticLogoReferences()[0]!;
  let referenceCount = 0, holdReferences: Promise<void> | null = null, referencesStarted: (() => void) | null = null;
  let now = Date.parse("2026-10-06T11:00:00Z"), quoteStatus = 200, loseAdmission = false, rejection: "durable" | "generic" | null = null, nextKey = 501;
  let read: LogoRequestState = { status: "not_found" };
  const posted: LogoGenerationIntent[] = [], reads: string[] = [], paths: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); paths.push(path);
    if (path.endsWith(`/stages/brief_references/revisions/${source.brief.id}`)) return json(source.brief);
    if (path.endsWith(`/reference-snapshots/${source.referenceSnapshot.id}`)) {
      referencesStarted?.();
      if (holdReferences) await holdReferences;
      return json({ ...source.referenceSnapshot, references: Array.from({ length: referenceCount }, (_, index) => ({ referenceId: id(700 + index), sourceKind: reference.sourceKind,
        rightsEvidenceId: reference.rightsEvidenceId, aspects: reference.aspects, asset: { ...reference.asset, assetId: id(720 + index), versionId: id(740 + index) } })) });
    }
    if (path.endsWith("/quotes")) return json(quote, quoteStatus);
    if (path.endsWith("/requests")) {
      const body = JSON.parse(String(init?.body)) as LogoGenerationIntent;
      posted.push(body);
      const receipt = { ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: body.requestKey,
        operation: "identity.logo_concept", batchId: id(60), jobIds: [id(500)], inputHash: quote.inputHash };
      if (loseAdmission) throw new Error("Lost response after server accepted");
      if (rejection) return json({ error: { code: "conflict", message: "This request conflicts with the current state." }, ...(rejection === "durable" ? { rejection: { status: "rejected", ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: body.requestKey, quoteId: body.quoteId } } : {}) }, 409);
      return json(receipt);
    }
    reads.push(path.split("/").at(-1)!); return json(read);
  };
  const account = { status: "ready" as const, userId: workspace.ownerId, generation: 1, email: "fixture@example.test" };
  const client = createAccountLogoClient(account, workspace.projectId, () => current, () => { current = false; }, fetcher);
  const controller = createLogoCreationController({ client, projectId: workspace.projectId, getWorkspace: () => workspace,
    hasUnsavedInputs: () => dirty, getPendingIntent: () => pending, retainIntent: value => { pending = value; }, clearIntent: key => { if (pending?.requestKey === key) pending = null; },
    isOperationAvailable: readiness, refreshWorkspace: async () => "reloaded", isCurrent: () => current, now: () => now, createRequestKey: () => id(nextKey++) });
  return { controller, quote, posted, reads, paths, client, get pending() { return pending; },
    setRead(value: LogoRequestState) { read = value; }, dirty() { dirty = true; }, expire() { now = Date.parse(quote.expiresAt); },
    foreign() { current = false; }, headsChanged() { workspace = { ...workspace, heads: { ...workspace.heads, referenceRevision: 1 } }; },
    reject(kind: "durable" | "generic" | null) { loseAdmission = false; rejection = kind; },
    referenceCount(count: number) { referenceCount = count; },
    holdReferences() { let release!: () => void; const started = new Promise<void>(resolve => { referencesStarted = resolve; }); holdReferences = new Promise<void>(resolve => { release = resolve; }); return { started, release }; },
    lose() { loseAdmission = true; }, status(status: number) { quoteStatus = status; } };
}

describe("explicit logo generation controller", () => {
  it("prepares a background estimate without changing request state, then starts once on a deliberate action", async () => {
    const s = setup(), quote = await s.controller.estimate(s.quote.request, new AbortController().signal);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: "idle", quote: null, request: null });
    expect(s.pending).toBeNull(); expect(s.posted).toEqual([]);
    await Promise.all([s.controller.start(quote), s.controller.start(quote)]);
    expect(s.posted).toHaveLength(1); expect(s.pending).toEqual(s.posted[0]);
    expect(s.controller.getSnapshot().phase).toBe("active");
  });
  it.each(["expire", "headsChanged", "dirty", "foreign"] as const)("does not start a prepared estimate after %s", async change => {
    const s = setup(), quote = await s.controller.estimate(s.quote.request, new AbortController().signal);
    s[change](); await s.controller.start(quote);
    expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
  });
  it("cancels a delayed estimate without quoting or admitting after its inputs were abandoned", async () => {
    const s = setup(), gate = s.holdReferences(), abort = new AbortController();
    const result = s.controller.estimate(s.quote.request, abort.signal).catch(error => error);
    await gate.started; abort.abort(); gate.release(); await result;
    expect(s.paths.filter(path => path.endsWith("/quotes"))).toEqual([]);
    expect(s.controller.getSnapshot().phase).toBe("idle"); expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
  });
  it("never replaces uncertain work with a fresh background estimate or generation", async () => {
    const s = setup(), quote = await s.controller.estimate(s.quote.request, new AbortController().signal);
    s.lose(); await s.controller.start(quote); const original = s.pending;
    await expect(s.controller.estimate(s.quote.request, new AbortController().signal)).rejects.toThrow();
    await s.controller.start(quote); await s.controller.checkRequest();
    expect(s.posted).toEqual([original]); expect(s.pending).toEqual(original);
  });
  it("offers saved-input recovery when a background estimate finds a server conflict", async () => {
    const s = setup(); s.status(409);
    await expect(s.controller.estimate(s.quote.request, new AbortController().signal)).rejects.toThrow();
    expect(s.controller.getSnapshot().phase).toBe("rejected"); expect(s.posted).toEqual([]);
    await s.controller.returnToCostReview(); expect(s.controller.getSnapshot().phase).toBe("idle");
    expect(s.pending).toBeNull(); expect(s.posted).toEqual([]);
  });
  it("quotes an estimate without admitting until explicit confirmation", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request);
    expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: "awaiting_confirmation", request: null, quote: { estimatedCostMicrousd: 6000, maxCostMicrousd: 12000 } });
    await s.controller.confirmQuote(s.quote.id);
    expect(s.posted).toHaveLength(1); expect(s.pending).toEqual(s.posted[0]);
    expect(s.controller.getSnapshot().phase).toBe("active");
  });
  it.each(["expire", "headsChanged", "dirty"] as const)("does not admit a %s quote", async change => {
    const s = setup(); await s.controller.prepare(s.quote.request); s[change]();
    await s.controller.confirmQuote(s.quote.id); expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
    expect(s.controller.getSnapshot().quote).toBeNull();
  });
  it("an exact durable admission rejection offers an explicit fresh cost review without dispatch", async () => {
    const s = setup(); s.reject("durable"); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    expect(s.controller.getSnapshot().phase).toBe("rejected"); expect(s.pending).toBeNull(); expect(s.posted).toHaveLength(1);
    await s.controller.returnToCostReview(); expect(s.controller.getSnapshot().phase).toBe("idle"); expect(s.posted).toHaveLength(1);
    s.reject(null); await s.controller.prepare(s.quote.request); expect(s.posted).toHaveLength(1);
    await s.controller.confirmQuote(s.quote.id); expect(s.posted).toHaveLength(2); expect(s.posted[1]!.requestKey).not.toBe(s.posted[0]!.requestKey);
  });
  it("a generic admission 409 and not-found read cannot discard an uncertain intent", async () => {
    const s = setup(); s.reject("generic"); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    const original = s.pending; await s.controller.checkRequest(); await s.controller.returnToCostReview();
    expect(s.pending).toEqual(original); expect(s.controller.getSnapshot().phase).toBe("needs_reconciliation"); expect(s.posted).toHaveLength(1);
  });
  it("a committed durable rejection can settle a previously ambiguous original-key replay", async () => {
    const s = setup(); s.lose(); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    const original = s.pending; await s.controller.checkRequest(); s.reject("durable"); await s.controller.retryOriginalIntent();
    expect(s.posted).toEqual([original, original]); expect(s.pending).toBeNull(); expect(s.controller.getSnapshot().phase).toBe("rejected");
  });
  it("the durable admission-rejected request read settles recovery but does not request a new quote", async () => {
    const s = setup(); s.lose(); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    s.setRead({ status: "failed", requestKey: s.pending!.requestKey, receipt: null, outputs: [], reason: "admission_rejected", billing: { status: "recorded", confirmedMicrousd: 0 } });
    await s.controller.checkRequest(); expect(s.pending).toBeNull(); expect(s.controller.getSnapshot().phase).toBe("rejected"); expect(s.posted).toHaveLength(1);
    expect(s.paths.filter(path => path.endsWith("/quotes"))).toHaveLength(1);
  });
  it("a double click retains and posts one original intent", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request);
    await Promise.all([s.controller.confirmQuote(s.quote.id), s.controller.confirmQuote(s.quote.id)]);
    expect(s.posted).toHaveLength(1); expect(s.pending?.requestKey).toBe(id(501));
  });
  it("a lost admission response uses read-only original-key recovery; not found stays unresolved", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); s.lose(); await s.controller.confirmQuote(s.quote.id);
    expect(s.controller.getSnapshot().phase).toBe("needs_reconciliation");
    await s.controller.checkRequest(); await s.controller.prepare(s.quote.request);
    expect(s.reads).toEqual([id(501)]); expect(s.posted).toHaveLength(1); expect(s.pending).not.toBeNull();
    expect(s.controller.getSnapshot().phase).toBe("needs_reconciliation");
  });
  it("explicit original-intent replay uses exactly the same body and synchronously locks double clicks", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); s.lose(); await s.controller.confirmQuote(s.quote.id);
    await s.controller.checkRequest();
    await Promise.all([s.controller.retryOriginalIntent(), s.controller.retryOriginalIntent()]);
    expect(s.posted).toHaveLength(2); expect(s.posted[0]).toEqual(s.posted[1]);
    expect(s.pending).toEqual(s.posted[0]);
  });
  it("a contradictory not-found read cannot make a known admitted request replayable", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    const admitted = s.controller.getSnapshot().request;
    s.setRead({ status: "not_found" }); await s.controller.checkRequest(); await s.controller.retryOriginalIntent();
    expect(s.posted).toHaveLength(1); expect(s.controller.getSnapshot().request).toEqual(admitted);
    expect(s.controller.getSnapshot().phase).toBe("needs_reconciliation");
  });
  it("known running requests cannot replay admission", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    const known = s.controller.getSnapshot().request!; expect(known.status).toBe("admitted");
    s.setRead({ ...known as Exclude<LogoRequestState, { status: "not_found" }>, status: "running" });
    await s.controller.checkRequest(); await s.controller.retryOriginalIntent();
    expect(s.posted).toHaveLength(1); expect(s.controller.getSnapshot().phase).toBe("active");
  });
  it("retains confirmed successful output when a later check is unavailable", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    const known = s.controller.getSnapshot().request as Exclude<LogoRequestState, { status: "not_found" }>;
    s.setRead({ ...known, status: "needs_reconciliation", reason: "billing_unknown" });
    await s.controller.checkRequest(); expect(s.pending?.requestKey).toBe(id(501));
    expect(s.controller.getSnapshot().phase).toBe("needs_reconciliation"); expect(s.posted).toHaveLength(1);
  });
  it("a terminal partial request with settled billing releases its intent for an explicit new quote", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    const admitted = s.controller.getSnapshot().request as Exclude<LogoRequestState, { status: "not_found" }>;
    s.setRead({ ...admitted, status: "partial", billing: { status: "recorded", confirmedMicrousd: 5000 } });
    await s.controller.checkRequest();
    expect(s.controller.getSnapshot().phase).toBe("idle"); expect(s.pending).toBeNull(); expect(s.posted).toHaveLength(1);
    await s.controller.prepare(s.quote.request); expect(s.controller.getSnapshot().phase).toBe("awaiting_confirmation"); expect(s.posted).toHaveLength(1);
  });
  it("cancelled unadmitted quotes and manual input invalidation never submit", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); s.controller.cancelQuote();
    await s.controller.confirmQuote(s.quote.id); expect(s.posted).toEqual([]);
    await s.controller.prepare(s.quote.request); s.dirty(); s.controller.refreshInputs();
    expect(s.controller.getSnapshot().quote).toBeNull(); expect(s.posted).toEqual([]);
  });
  it.each([401, 404, 409, 413, 422, 503])("handles quote HTTP %s without an admission or fallback", async status => {
    const s = setup(); s.status(status); await s.controller.prepare(s.quote.request);
    expect(s.posted).toEqual([]); expect(s.paths.filter(path => path.endsWith("/quotes"))).toHaveLength(1); expect(s.pending).toBeNull();
    expect(s.controller.getSnapshot().quote).toBeNull();
  });
  it("blocks over-limit source references before a quote and permits explicit review after saving a bounded set", async () => {
    const s = setup(); s.referenceCount(5); await s.controller.prepare(s.quote.request);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: "idle", quote: null, error: expect.stringContaining("5 reference images") });
    expect(s.paths.some(path => path.endsWith("/quotes"))).toBe(false); expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
    s.referenceCount(4); await s.controller.prepare(s.quote.request);
    expect(s.controller.getSnapshot().phase).toBe("awaiting_confirmation"); expect(s.posted).toEqual([]);
  });
  it.each(["foreign", "dirty", "headsChanged"] as const)("does not quote after %s changes during the source reference preflight", async change => {
    const s = setup(), gate = s.holdReferences();
    const prepared = s.controller.prepare(s.quote.request); await gate.started; s[change](); gate.release(); await prepared;
    expect(s.paths.some(path => path.endsWith("/quotes"))).toBe(false); expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
  });
  it("fences account changes and disposal before confirmation", async () => {
    const s = setup(); await s.controller.prepare(s.quote.request); s.foreign();
    await s.controller.confirmQuote(s.quote.id); expect(s.controller.getSnapshot().quote).toBeNull(); expect(s.posted).toEqual([]);
    s.controller.dispose(); await s.controller.retryOriginalIntent(); expect(s.posted).toEqual([]);
  });
});


describe("fresh exact-operation admission hints", () => {
  it("keeps an interrupted source review recoverable and requires explicit retry and confirmation", async () => {
    let ready = true; const s = setup(() => ready), gate = s.holdReferences();
    const prepared = s.controller.prepare(s.quote.request); await gate.started; ready = false; gate.release(); await prepared;
    expect(s.controller.getSnapshot()).toMatchObject({ phase: "idle", quote: null, error: expect.stringContaining("Refresh operation availability, then try again") });
    expect(s.paths.filter(path => path.endsWith("/quotes"))).toHaveLength(0); expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
    ready = true; s.controller.refreshInputs();
    expect(s.paths.filter(path => path.endsWith("/quotes"))).toHaveLength(0);
    await s.controller.prepare(s.quote.request);
    expect(s.paths.filter(path => path.endsWith("/quotes"))).toHaveLength(1); expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
    await s.controller.confirmQuote(s.quote.id); await s.controller.confirmQuote(s.quote.id);
    expect(s.posted).toHaveLength(1); expect(s.controller.getSnapshot().phase).toBe("active");
  });
  it("blocks a concept quote when only directions or vectors are ready", async () => {
    const s = setup(operation => operation === "identity.logo_vectorize" || operation === "identity.logo_directions");
    await s.controller.prepare(s.quote.request);
    expect(s.paths).toEqual([]); expect(s.controller.getSnapshot().quote).toBeNull();
  });
  it("retains a quote and blocks its click when readiness expires before the timer runs", async () => {
    let ready = true; const s = setup(() => ready); await s.controller.prepare(s.quote.request);
    ready = false; await s.controller.confirmQuote(s.quote.id);
    expect(s.posted).toEqual([]); expect(s.pending).toBeNull();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: "awaiting_confirmation", quote: s.quote });
    s.controller.refreshInputs(); expect(s.controller.getSnapshot().quote).toEqual(s.quote);
    ready = true; await s.controller.confirmQuote(s.quote.id); expect(s.posted).toHaveLength(1);
  });
  it("recovers the original admitted request with readiness unavailable", async () => {
    let ready = true; const s = setup(() => ready); await s.controller.prepare(s.quote.request); await s.controller.confirmQuote(s.quote.id);
    const original = s.pending, admitted = s.controller.getSnapshot().request!; ready = false;
    s.setRead({ ...admitted as Exclude<LogoRequestState, { status: "not_found" }>, status: "running" });
    s.controller.refreshInputs(); await s.controller.checkRequest();
    expect(s.pending).toEqual(original); expect(s.posted).toHaveLength(1); expect(s.reads).toEqual([original!.requestKey]);
    expect(s.controller.getSnapshot().phase).toBe("active");
  });
});
