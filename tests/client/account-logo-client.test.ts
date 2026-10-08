/** Synthetic HTTP responses only; these tests do not claim an active API. */
import { describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";

const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: id(1), generation: 1 }, projectId = id(2), requestKey = id(3);
const brief = { name: "Cedar", activity: "Studio", audience: "Founders", personality: "Calm", logoTypes: ["wordmark" as const] };
const heads = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 0,
  stageRevisions: { brief_references: 0, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
const workspace = () => logoWorkspaceV2Schema.parse({ version: 2, ownerId: account.userId, projectId, heads,
  stages: { brief_references: null, concepts: null, vector: null, refinements: null, directions: null, deliverables: null }, approvedLogo: null, staleStages: [],
  capabilities: Object.fromEntries(["save", "upload", "generate", "convert", "export"].map(key => [key, { status: "unavailable", reason: "Synthetic fixture" }])) });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

describe("account logo transport", () => {
  it("reads a strictly owned no-store workspace from the fixed route", async () => {
    let seen: [unknown, RequestInit | undefined] | undefined;
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async (path, init) => { seen = [path, init]; return json(workspace()); });
    expect(await client.getLogoWorkspace()).toEqual(workspace());
    expect(seen?.[0]).toBe(`/api/projects/${projectId}/logo`); expect(seen?.[1]).toMatchObject({ credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error" });
  });
  it("returns null for a delayed previous-generation response", async () => {
    const response = deferred<Response>(); let current = true;
    const client = createAccountLogoClient(account, projectId, () => current, vi.fn(), () => response.promise);
    const pending = client.getLogoWorkspace(); current = false; response.resolve(json(workspace())); expect(await pending).toBeNull();
  });
  it("expires only a still-current account on 401", async () => {
    const expire = vi.fn(), stale = deferred<Response>(); let current = true;
    const client = createAccountLogoClient(account, projectId, () => current, expire, () => stale.promise);
    const pending = client.getLogoWorkspace(); current = false; stale.resolve(new Response(null, { status: 401 })); expect(await pending).toBeNull(); expect(expire).not.toHaveBeenCalled();
    const active = createAccountLogoClient(account, projectId, () => true, expire, async () => new Response(null, { status: 401 }));
    expect(await active.getLogoWorkspace()).toBeNull(); expect(expire).toHaveBeenCalledExactlyOnceWith(account);
  });
  it("rejects foreign and malformed response payloads without exposing a workspace", async () => {
    for (const response of [{ ...workspace(), ownerId: id(9) }, { ...workspace(), version: 1 }, { ...workspace(), extra: true }]) {
      const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => json(response));
      await expect(client.getLogoWorkspace()).rejects.toMatchObject({ status: 502 });
    }
  });
  it("retains 409/503 errors and rejects invalid request bodies before sending", async () => {
    let calls = 0;
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => { calls++; return new Response(null, { status: 409 }); });
    await expect(client.saveLogoBrief({ requestKey, expected: heads, brief: { ...brief, name: "" } })).rejects.toMatchObject({ status: 422 });
    await expect(client.saveLogoBrief({ requestKey, expected: heads, brief, ownerId: id(9) } as never)).rejects.toMatchObject({ status: 422 });
    await expect(client.saveLogoBrief({ requestKey, expected: heads, brief: { ...brief, activity: "x".repeat(40000) } })).rejects.toMatchObject({ status: 413 });
    expect(calls).toBe(0); await expect(client.saveLogoBrief({ requestKey, expected: heads, brief })).rejects.toMatchObject({ status: 409 });
    const unavailable = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => new Response(null, { status: 503 }));
    await expect(unavailable.getLogoWorkspace()).rejects.toMatchObject({ status: 503 });
  });
  it("creation works in the null-project slot; recovery reads never automatically post", async () => {
    const calls: { path: string; method?: string; body?: BodyInit | null }[] = [];
    const client = createAccountLogoClient(account, null, () => true, vi.fn(), async (path, init) => {
      calls.push({ path: String(path), method: init?.method, body: init?.body });
      return json(String(path).endsWith(`/requests/${requestKey}`) ? { status: "not_found" } : workspace());
    });
    expect(await client.readLogoProjectCreation(requestKey)).toEqual({ status: "not_found" }); expect(calls).toHaveLength(1);
    expect(await client.startLogoProject({ requestKey, brief })).toEqual(workspace());
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ requestKey, brief });
    await expect(client.getLogoWorkspace()).rejects.toMatchObject({ status: 422 }); expect(calls).toHaveLength(2);
  });
  it("checks recovered creation request identity and owned bounded summary pages", async () => {
    const client = createAccountLogoClient(account, null, () => true, vi.fn(), async () => json({ status: "succeeded", requestKey: id(4), projectId, workspace: workspace() }));
    await expect(client.readLogoProjectCreation(requestKey)).rejects.toMatchObject({ status: 502 });
    const page = { ownerId: account.userId, items: [{ requestKey, projectId, brief, createdAt: "2026-10-06T12:00:00Z" }], nextCursor: null };
    const listed = createAccountLogoClient(account, null, () => true, vi.fn(), async () => json(page)); expect(await listed.listLogoProjectCreations()).toEqual(page);
    await expect(listed.listLogoProjectCreations({ limit: 51 })).rejects.toMatchObject({ status: 422 });
  });
  it("checks request receipt keys and nested owner before returning recovery evidence", async () => {
    const state = { status: "admitted", requestKey, receipt: { ownerId: id(9), projectId, requestKey, operation: "identity.logo_export", batchId: null, jobIds: [id(8)], inputHash: "a".repeat(64) }, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null };
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => json(state));
    await expect(client.readLogoRequest(requestKey)).rejects.toMatchObject({ status: 502 });
  });
  it("reads revision payloads only for the requested stage and exact immutable ID", async () => {
    const revision = { version: 2, id: id(5), ownerId: account.userId, projectId, stage: "brief_references", revision: 1, parentRevisionId: null, inputRevisions: [], inputHash: "a".repeat(64), payload: { ...brief, referenceSnapshotId: id(6), sourceProjectRevision: 1 }, createdAt: "2026-10-06T12:00:00Z" };
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => json(revision));
    expect(await client.getLogoStageRevision("brief_references", id(5))).toEqual(revision);
    await expect(client.getLogoStageRevision("concepts", id(5))).rejects.toMatchObject({ status: 502 });
    await expect(client.getLogoStageRevision("brief_references", id(7))).rejects.toMatchObject({ status: 502 });
  });
  it("bounds streamed JSON even without trustworthy Content-Length", async () => {
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => new Response(" ".repeat(32769), { headers: { "content-type": "application/json", "content-length": "1" } }));
    await expect(client.getLogoWorkspace()).rejects.toMatchObject({ status: 502 });
  });
  it("disposal aborts pending reads and ignores a transport that resolves after abort", async () => {
    const response = deferred<Response>(); let signal: AbortSignal | null | undefined;
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), (_path, init) => { signal = init?.signal; return response.promise; });
    const pending = client.getLogoWorkspace(); client.dispose(); expect(signal?.aborted).toBe(true); response.resolve(json(workspace())); expect(await pending).toBeNull();
  });
  it("rejects malformed vector details and keeps unresolved variant reads unavailable", async () => {
    let calls = 0; const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => { calls++; return json({}); });
    await expect(client.readLogoVectorDetail(id(5))).rejects.toMatchObject({ status: 502 });
    await expect(client.resolveLogoVariantSet(id(6))).rejects.toMatchObject({ status: 503 }); expect(calls).toBe(1);
  });
});

it("rejects a preview whose actual byte length contradicts its verification receipt", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
  const receipt = { id: id(10), reference: { ownerId: account.userId, projectId, assetId: id(11), versionId: id(12), contentHash: hash },
    verification: { status: "verified" as const, checkedAt: "2026-10-06T12:00:00Z", contentHash: hash, mimeType: "image/png", byteLength: 9 }, purpose: "brand_asset" as const, sourceReceiptId: id(13), rightsEvidenceId: null, publicationState: "committed" as const };
  const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => new Response(bytes, { headers: { "content-type": "image/png" } }));
  await expect(client.previewAsset(receipt)).rejects.toMatchObject({ status: 502 });
  client.dispose();
});

it("rejects malformed multipart metadata as a typed input error without a request", async () => {
  let calls = 0;
  const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => { calls++; return json({}); });
  await expect(client.uploadLogoReference(null as never)).rejects.toMatchObject({ status: 422 });
  expect(calls).toBe(0);
});

it("does not report a concept receipt as a recovered export request", async () => {
  const input = { requestKey, expected: heads, approvedLogoId: id(15), directionApprovalId: id(16), variantSetId: id(17), pngLongEdge: 4096, socialSelections: [{ kind: "avatar", presetId: "square" }] };
  const receipt = { ownerId: account.userId, projectId, requestKey, operation: "identity.logo_concept", batchId: id(20), jobIds: [id(21)], inputHash: "a".repeat(64) };
  const response = { ownerId: account.userId, projectId, logoApproval: null, directionApproval: null, variantSets: [], variantReviews: [], exports: [],
    exportRequests: [{ requestKey, input, state: { status: "admitted", requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null }, exportManifestId: null, createdAt: "2026-10-06T12:00:00Z" }], nextCursor: null, nextRequestCursor: null };
  const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => json(response));
  await expect(client.getLogoDeliverables()).rejects.toMatchObject({ status: 502 });
});

it("reads an exact owned reference snapshot independently of paginated registrations", async () => {
  const snapshot = { version: 2, id: id(31), ownerId: account.userId, projectId, revision: 1, references: [{ referenceId: id(32),
    asset: { ownerId: account.userId, projectId, assetId: id(33), versionId: id(34), contentHash: "b".repeat(64) }, sourceKind: "upload", aspects: ["lettering", "shape", "composition", "overall_feel"], rightsEvidenceId: id(35) }] };
  const paths: string[] = [];
  const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async path => { paths.push(String(path)); return new Response(" ".repeat(66000) + JSON.stringify(snapshot), { headers: { "content-type": "application/json" } }); });
  expect(await client.readLogoReferenceSnapshot(id(31))).toEqual(snapshot);
  expect(paths).toEqual([`/api/projects/${projectId}/logo/reference-snapshots/${id(31)}`]);
});

it("reads lightweight owned concept batch summaries from the bounded history route", async () => {
  const page = { ownerId: account.userId, projectId, items: [{ id: id(40), requestKey, createdAt: "2026-10-06T12:00:00Z" }], nextCursor: id(40) };
  const requests: string[] = [], client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async path => { requests.push(String(path)); return json(page); });
  expect(await client.listLogoConceptBatches({ limit: 20 })).toEqual(page);
  expect(requests).toEqual([`/api/projects/${projectId}/logo/batches?limit=20`]);
  await expect(client.listLogoConceptBatches({ limit: 51 })).rejects.toMatchObject({ status: 422 });
});

it("rejects foreign or heavyweight batch summary data", async () => {
  for (const page of [
    { ownerId: id(9), projectId, items: [], nextCursor: null },
    { ownerId: account.userId, projectId, items: [{ id: id(40), requestKey, createdAt: "2026-10-06T12:00:00Z", slots: [] }], nextCursor: null },
  ]) {
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => json(page));
    await expect(client.listLogoConceptBatches()).rejects.toMatchObject({ status: 502 });
  }
});


describe("live operation capability transport", () => {
  const capabilities = () => ({ ownerId: account.userId, projectId, observedAt: "2026-10-07T06:00:00.000Z",
    operations: Object.fromEntries(["identity.logo_concept", "identity.logo_refine", "identity.logo_vectorize", "identity.logo_directions", "identity.logo_export"].map(operation => [operation, operation === "identity.logo_vectorize" ? { status: "available", expiresAt: "2026-10-07T06:00:20.000Z" } : { status: "unavailable" }])) });
  it("reads an owned operation-specific no-store hint separately from the saved workspace", async () => {
    let seen: [unknown, RequestInit | undefined] | undefined;
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async (path, init) => { seen = [path, init]; return json(capabilities()); });
    expect(await client.getLogoCapabilities()).toEqual(capabilities());
    expect(seen?.[0]).toBe(`/api/projects/${projectId}/logo/capabilities`);
    expect(seen?.[1]).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error" });
  });
  it("rejects foreign scope and extra readiness metadata", async () => {
    for (const value of [{ ...capabilities(), ownerId: id(9) }, { ...capabilities(), projectId: id(9) }, { ...capabilities(), secret: "not allowed" }]) {
      const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async () => json(value));
      await expect(client.getLogoCapabilities()).rejects.toMatchObject({ status: 502 });
    }
  });
  it("fences a late old-session capability response and aborts it on disposal", async () => {
    const response = deferred<Response>(); let current = true, signal: AbortSignal | null | undefined;
    const client = createAccountLogoClient(account, projectId, () => current, vi.fn(), (_url, init) => { signal = init?.signal; return response.promise; });
    const pending = client.getLogoCapabilities(); current = false; client.dispose();
    expect(signal?.aborted).toBe(true); response.resolve(json(capabilities())); expect(await pending).toBeNull();
  });
});
