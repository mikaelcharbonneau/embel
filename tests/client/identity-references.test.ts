import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { identityReferenceEntrySchema, identityReferenceMediaSchema, identityReferencesOverviewSchema } from "@/domain/identity-references";
import { createAccountReferenceClient, referenceErrorMessage } from "@/components/identity/account-reference-client";
import { applyReferenceReceipt, createReferenceIntentMemory, type ReferenceIntent } from "@/components/identity/use-identity-references";
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: id(1), generation: 1 }, projectId = id(2);
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64"), hash = createHash("sha256").update(bytes).digest("hex");
const media = (n = 4) => identityReferenceMediaSchema.parse({ ownerId: id(1), projectId, assetId: id(3), versionId: id(n), contentHash: hash, purpose: "reference_media", mimeType: "image/png" });
const entry = () => identityReferenceEntrySchema.parse({ reference: { id: id(5), ownerId: id(1), projectId, createdAt: "2026-10-04T12:00:00Z", media: media(), source: "user_supplied", attribution: { label: "Synthetic reference", creator: null, sourceUrl: null, rightsNote: null }, relevantElements: ["logo", "colors"], tags: ["soft", "warm"] }, reaction: { ownerId: id(1), projectId, referenceId: id(5), revision: 0, ensemble: false, elements: [], updatedAt: null } });
const overview = () => identityReferencesOverviewSchema.parse({ ownerId: id(1), projectId, referenceRevision: 0, selectedReferenceCount: 0, query: { limit: 40, excludedTags: [] }, feed: { status: "unavailable", reason: "reference_source_unconfigured" }, availableTags: ["soft", "warm"], tagsComplete: true, references: { items: [entry()], nextCursor: null } });
const envelope = z.strictObject({ ownerId: z.uuid(), projectId: z.uuid() });
const nativeFetch = globalThis.fetch;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("strict owner and project reference requests", () => {
  it("reads real persisted references despite an unavailable source", async () => {
    const fetch = vi.fn(async () => Response.json(overview())); vi.stubGlobal("fetch", fetch);
    const client = createAccountReferenceClient(account, projectId, () => true, vi.fn());
    expect((await client.list({}))?.references.items).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(`/api/projects/${projectId}/identity/references?limit=40`, expect.objectContaining({ credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error" })); client.dispose();
  });
  it.each(["GET", "PATCH"] as const)("drops late %s responses after an account generation changes", async method => {
    let current = true, finish!: (value: Response) => void; vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const client = createAccountReferenceClient(account, projectId, () => current, vi.fn());
    const pending = client.request(`/api/projects/${projectId}/identity/references`, envelope, value => value.ownerId === account.userId && value.projectId === projectId, { method });
    current = false; finish(Response.json({ ownerId: account.userId, projectId })); expect(await pending).toBeNull(); client.dispose();
  });
  it("expires an unexpected owner and never publishes it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...overview(), ownerId: id(9), references: { items: [], nextCursor: null } })));
    const expire = vi.fn(), client = createAccountReferenceClient(account, projectId, () => true, expire);
    expect(await client.list({})).toBeNull(); expect(expire).toHaveBeenCalledWith(account); client.dispose();
  });
  it("rejects wrong nested project ownership and unknown provenance fields", async () => {
    const value = overview(); const bad = { ...value, references: { ...value.references, items: [{ ...entry(), reference: { ...entry().reference, media: { ...media(), projectId: id(8), fileState: "verified" } } }] } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(bad))); const client = createAccountReferenceClient(account, projectId, () => true, vi.fn());
    await expect(client.list({})).rejects.toThrow(); client.dispose();
  });
  it("serializes actual exclusions and full project-bound cursor", async () => {
    const cursor = { projectId, createdAt: "2026-10-04T12:00:00Z", referenceId: id(5), excludedTags: ["soft", "warm"] }, query = { limit: 40, excludedTags: ["warm", "soft"], cursor };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ...overview(), query: { ...query, excludedTags: ["soft", "warm"] }, references: { items: [], nextCursor: null } })); vi.stubGlobal("fetch", fetch);
    const client = createAccountReferenceClient(account, projectId, () => true, vi.fn()); expect(await client.list(query)).not.toBeNull();
    const url = new URL(fetch.mock.calls[0]![0] as string, "https://fluid.example.invalid"); expect(url.searchParams.getAll("excludedTag")).toEqual(["soft", "warm"]); expect(JSON.parse(url.searchParams.get("cursor")!)).toEqual(cursor);
    expect(() => client.list({ ...query, cursor: { ...cursor, projectId: id(8) } })).toThrow(); client.dispose();
  });
  it("preserves Ensemble separately from element likes in the confirmed CAS receipt", async () => {
    const current = entry(), reaction = { ...current.reaction, revision: 1, ensemble: false, elements: ["logo", "colors"], updatedAt: "2026-10-04T12:01:00Z" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ownerId: account.userId, projectId, referenceRevision: 1, selectedReferenceCount: 1, entry: { ...current, reaction } })); vi.stubGlobal("fetch", fetch);
    const client = createAccountReferenceClient(account, projectId, () => true, vi.fn()); const reply = await client.react(current, { expectedRevision: 0, ensemble: false, elements: ["colors", "logo"] });
    expect(reply?.entry.reaction.ensemble).toBe(false); expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ expectedRevision: 0, ensemble: false, elements: ["logo", "colors"] }); client.dispose();
  });
  it("refuses irrelevant elements before sending a request", async () => {
    const fetch = vi.fn(async () => Response.json({ ...overview() })); vi.stubGlobal("fetch", fetch);
    const client = createAccountReferenceClient(account, projectId, () => true, vi.fn());
    expect(() => client.react(entry(), { expectedRevision: 0, ensemble: false, elements: ["typography"] })).toThrow(); expect(fetch).not.toHaveBeenCalled(); client.dispose();
  });
  it("invalidates on a missing session without rendering a private error payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private error", { status: 401 }))); const expire = vi.fn(), client = createAccountReferenceClient(account, projectId, () => true, expire);
    expect(await client.list({})).toBeNull(); expect(expire).toHaveBeenCalledOnce(); client.dispose();
  });
});

describe("exact reference media previews", () => {
  it("needs no invented asset detail and exposes canonical checked raster bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => { const request = new Request(new URL(path, "https://fluid.example.invalid"), init); expect(request.headers.get("accept")).toBe("image/png"); return new Response(bytes, { headers: { "Content-Type": "image/png" } }); }));
    const client = createAccountReferenceClient(account, projectId, () => true, vi.fn()); const preview = await client.preview(media());
    const response = await nativeFetch(preview!.url); expect(response.headers.get("content-type")).toBe("image/png"); expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
    preview!.release(); await expect(nativeFetch(preview!.url)).rejects.toThrow(); client.dispose();
  });
  it.each([{ projectId: id(8) }, { ownerId: id(9) }, { mimeType: "image/svg+xml" }, { purpose: "brand_asset" }, { fileState: "verified" }])("refuses a forged media pointer before byte access: %j", async patch => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const client = createAccountReferenceClient(account, projectId, () => true, vi.fn());
    await expect(client.preview({ ...media(), ...patch })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); client.dispose();
  });
  it.each([
    () => new Response(bytes, { headers: { "Content-Type": "text/html" } }),
    () => new Response("different bytes", { headers: { "Content-Type": "image/png" } }),
    () => new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": "52428801" } }),
    () => new Response(null, { status: 404 }),
  ])("rejects wrong MIME, modified, oversized or absent bytes", async response => {
    vi.stubGlobal("fetch", vi.fn(async () => response())); const client = createAccountReferenceClient(account, projectId, () => true, vi.fn()); await expect(client.preview(media())).rejects.toThrow(); client.dispose();
  });
  it("revokes prior object URLs and discards a late ignored-abort preview", async () => {
    let current = true, finish!: (value: Response) => void; vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "image/png" } })).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })));
    const client = createAccountReferenceClient(account, projectId, () => current, vi.fn()); const first = await client.preview(media()), late = client.preview(media(6)); await vi.waitFor(() => expect(finish).toBeTypeOf("function")); current = false; client.dispose(); finish(new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    expect(await late).toBeNull(); await expect(nativeFetch(first!.url)).rejects.toThrow();
  });
  it("bounds active previews to three and cancels queued consumers", async () => {
    const finish: Array<(value: Response) => void> = []; const fetch = vi.fn(() => new Promise<Response>(resolve => finish.push(resolve))); vi.stubGlobal("fetch", fetch);
    const client = createAccountReferenceClient(account, projectId, () => true, vi.fn()), abort = new AbortController(); const pending = [client.preview(media(4)), client.preview(media(6)), client.preview(media(7)), client.preview(media(8), abort.signal)];
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3)); abort.abort(); finish.forEach(resolve => resolve(new Response(bytes, { headers: { "Content-Type": "image/png" } })));
    expect((await Promise.all(pending))[3]).toBeNull(); expect(fetch).toHaveBeenCalledTimes(3); client.dispose();
  });
});


describe("reference recovery boundaries", () => {
  it.each([false, true])("bounds encoded Unicode exclusions before fetch (continuation=%s)", continuation => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createAccountReferenceClient(account, projectId, () => true, vi.fn());
    const excludedTags = Array.from({ length: continuation ? 40 : 50 }, (_, index) => "界".repeat(78) + String(index).padStart(2, "0"));
    let error: unknown;
    try { client.list({ excludedTags, ...(continuation ? { cursor: { projectId, referenceId: id(5), createdAt: "2026-10-04T12:00:00Z", excludedTags } } : {}) }); } catch (cause) { error = cause; }
    expect(error).toMatchObject({ status: 413 }); expect(referenceErrorMessage(error)).toContain("Remove an excluded tag"); expect(fetch).not.toHaveBeenCalled(); client.dispose();
  });
  it.each(["id", "immutable", "revision", "choices"] as const)("rejects a valid but unexpected %s reaction receipt", async change => {
    const current = entry(), reply = { ownerId: account.userId, projectId, referenceRevision: 2, selectedReferenceCount: 1, entry: { ...current, reaction: { ...current.reaction, revision: 1, ensemble: true, updatedAt: "2026-10-04T12:01:00Z" } } };
    if (change === "id") { reply.entry.reference.id = id(7); reply.entry.reaction.referenceId = id(7); }
    if (change === "immutable") reply.entry.reference.attribution.label = "Unexpected replacement";
    if (change === "revision") reply.entry.reaction.revision = 2;
    if (change === "choices") { reply.entry.reaction.ensemble = false; reply.selectedReferenceCount = 0; }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(reply)));
    const expire = vi.fn(), client = createAccountReferenceClient(account, projectId, () => true, expire);
    const original = entry(); expect(await client.react(original, { expectedRevision: 0, ensemble: true, elements: [] })).toBeNull(); expect(expire).toHaveBeenCalledOnce(); client.dispose();
  });
  it("does not roll back an aggregate or a newer row when independent receipts arrive out of order", () => {
    const page = overview(); page.referenceRevision = 8; page.selectedReferenceCount = 2;
    page.references.items[0]!.reaction = { ...entry().reaction, revision: 3, ensemble: true, updatedAt: "2026-10-04T12:02:00Z" };
    const receipt = { ownerId: account.userId, projectId, referenceRevision: 7, selectedReferenceCount: 1, entry: { ...entry(), reaction: { ...entry().reaction, revision: 2, ensemble: false, elements: ["logo" as const], updatedAt: "2026-10-04T12:01:00Z" } } };
    expect(applyReferenceReceipt(page, receipt)).toEqual(page);
    expect(() => applyReferenceReceipt(page, { ...receipt, ownerId: id(9) })).toThrow();
  });
  it("retains same-owner intent privately and rejects writes from a previous owner", () => {
    const memory = createReferenceIntentMemory(), intent: ReferenceIntent = { entry: entry(), query: { limit: 40, excludedTags: [] }, choices: { ensemble: true, elements: [] }, phase: "unconfirmed", error: "Not confirmed" };
    memory.bind(account.userId); memory.put(account.userId, projectId, new Map([[id(5), intent]])); memory.bind(account.userId);
    expect(memory.get(account.userId, projectId).get(id(5))).toEqual(intent); memory.get(account.userId, projectId).clear(); expect(memory.get(account.userId, projectId).size).toBe(1);
    memory.clear(); memory.bind(account.userId); expect(memory.get(account.userId, projectId).size).toBe(0);
    memory.put(account.userId, projectId, new Map([[id(5), intent]]));
    memory.bind(id(9)); memory.put(account.userId, projectId, new Map([[id(5), intent]])); expect(memory.get(id(9), projectId).size).toBe(0); memory.bind(account.userId); expect(memory.get(account.userId, projectId).size).toBe(0);
  });
});

it("explains a server URL/header limit as a recoverable filter size error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Private proxy detail", { status: 431 })));
  const client = createAccountReferenceClient(account, projectId, () => true, vi.fn());
  let error: unknown; try { await client.list({ excludedTags: ["warm"] }); } catch (cause) { error = cause; }
  expect(referenceErrorMessage(error)).toContain("Remove an excluded tag"); expect(referenceErrorMessage(error)).not.toContain("Private proxy"); client.dispose();
});
