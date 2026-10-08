import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { assetRevisionFreshness, assetVersionDetailSchema } from "@/domain/asset-library";
import { createAccountAssetsClient } from "@/components/assets/account-assets-client";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: id(1), generation: 1 };
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");
const hash = createHash("sha256").update(bytes).digest("hex");
const version = (n = 4) => assetVersionDetailSchema.parse({ ownerId: id(1), projectId: id(2), assetId: id(3), versionId: id(n), contentHash: hash, inputHash: "a".repeat(64), inputRevision: 1, versionNumber: n - 3, createdAt: "2026-10-04T12:00:00Z", mimeType: "image/png", format: "png", provenance: { status: "legacy_unverified" }, vectorStatus: "unverified", licenseStatus: "unverified", fileState: "unverified", fileVerification: null, freshness: assetRevisionFreshness(1, 2) });
const envelope = z.strictObject({ ownerId: z.uuid(), value: z.string() });
const owned = (value: z.infer<typeof envelope>) => value.ownerId === account.userId;
const nativeFetch = globalThis.fetch;
const raster = () => new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.byteLength) } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Assets private account request scope", () => {
  it("uses same-origin, no-store metadata and expires mismatched ownership", async () => {
    const fetch = vi.fn(async () => Response.json({ ownerId: id(9), value: "Another owner's asset" })); vi.stubGlobal("fetch", fetch);
    const expire = vi.fn(), client = createAccountAssetsClient(account, () => true, expire);
    await expect(client.request("/api/assets", envelope, owned)).resolves.toBeNull();
    expect(expire).toHaveBeenCalledWith(account);
    expect(fetch).toHaveBeenCalledWith("/api/assets", expect.objectContaining({ credentials: "same-origin", cache: "no-store", mode: "same-origin" }));
    client.dispose();
  });
  it.each(["GET", "PATCH", "POST"] as const)("discards a late %s after an account generation changes", async method => {
    let current = true, finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const client = createAccountAssetsClient(account, () => current, vi.fn());
    const pending = client.request("/api/assets", envelope, owned, { method });
    current = false; finish(Response.json({ ownerId: account.userId, value: "Private asset" }));
    await expect(pending).resolves.toBeNull(); client.dispose();
  });
  it("hides expired sessions without publishing an error payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private error", { status: 401 })));
    const expire = vi.fn(), client = createAccountAssetsClient(account, () => true, expire);
    await expect(client.request("/api/assets", envelope, owned)).resolves.toBeNull();
    expect(expire).toHaveBeenCalledWith(account); client.dispose();
  });
});

describe("private raster lifetime and actual file integrity", () => {
  it("verifies real bytes and revokes the actual object URL on release", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => raster()));
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    const preview = await client.preview(version());
    expect(preview).not.toBeNull();
    expect(new Uint8Array(await (await nativeFetch(preview!.url)).arrayBuffer())).toEqual(new Uint8Array(bytes));
    preview!.release(); await expect(nativeFetch(preview!.url)).rejects.toThrow(); client.dispose();
  });
  it("revokes existing URLs and never creates a URL from a late prior-account response", async () => {
    let current = true, finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(raster()).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })));
    const client = createAccountAssetsClient(account, () => current, vi.fn());
    const first = await client.preview(version());
    const pending = client.preview(version(5));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    current = false; client.dispose(); finish(raster());
    await expect(pending).resolves.toBeNull();
    await expect(nativeFetch(first!.url)).rejects.toThrow();
  });
  it("keeps at most three preview reads active and cancels waiting consumers", async () => {
    const finishes: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>(resolve => finishes.push(resolve))); vi.stubGlobal("fetch", fetch);
    const client = createAccountAssetsClient(account, () => true, vi.fn()), cancelled = new AbortController();
    const pending = [client.preview(version(4)), client.preview(version(5)), client.preview(version(6)), client.preview(version(7), cancelled.signal)];
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    cancelled.abort(); finishes.forEach(finish => finish(raster()));
    const responses = await Promise.all(pending);
    expect(responses[3]).toBeNull(); expect(fetch).toHaveBeenCalledTimes(3);
    client.dispose();
  });
  it.each([
    () => new Response(bytes, { headers: { "Content-Type": "text/html" } }),
    () => new Response("changed bytes", { headers: { "Content-Type": "image/png" } }),
    () => new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": "52428801" } }),
    () => new Response(null, { status: 404 }),
  ])("rejects unsupported, modified, oversized or missing preview content", async response => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    await expect(client.preview(version())).rejects.toThrow(); client.dispose();
  });
  it("never attempts metadata-only or non-raster previews", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    await expect(client.preview({ ...version(), fileState: "metadata_only" })).rejects.toThrow();
    await expect(client.preview({ ...version(), mimeType: "image/svg+xml", format: "svg" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); client.dispose();
  });
});

describe("genuine private download envelopes", () => {
  const link = { url: "https://files.example.invalid/fixture?token=synthetic", versionId: id(4), contentHash: hash, mimeType: "image/png", expiresInSeconds: 60 };
  it("requests a fresh verified link each time instead of caching a bearer URL", async () => {
    const fetch = vi.fn(async () => Response.json(link)); vi.stubGlobal("fetch", fetch);
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    expect(await client.download(version())).toEqual(link);
    expect(await client.download(version())).toEqual(link);
    expect(fetch).toHaveBeenCalledTimes(2); client.dispose();
  });
  it.each([{ versionId: id(8) }, { contentHash: "b".repeat(64) }, { mimeType: "text/html" }, { url: "javascript:alert(1)" }, { expiresInSeconds: 3600 }])("rejects a mismatched or unsafe signed link %j", async patch => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...link, ...patch })));
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    await expect(client.download(version())).rejects.toThrow(); client.dispose();
  });
});

describe("strict metadata and continuation wire", () => {
  it("encodes the full query-bound cursor and rejects changed filters before fetch", async () => {
    const cursor = { createdAt: "2026-10-04T12:00:00Z", assetId: id(3), tab: "all_generations" as const, projectId: id(2), format: "svg" as const };
    const query = { tab: "all_generations" as const, projectId: id(2), format: "svg" as const, cursor, limit: 40 };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ownerId: account.userId, query, items: [], nextCursor: null })); vi.stubGlobal("fetch", fetch);
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    expect(await client.list(query)).not.toBeNull();
    const wire = new URL(fetch.mock.calls[0]![0] as string, "https://fluid.example.invalid");
    expect(JSON.parse(wire.searchParams.get("cursor")!)).toEqual(cursor);
    expect(wire.searchParams.get("projectId")).toBe(id(2));
    expect(() => client.list({ ...query, format: "png" })).toThrow(); expect(fetch).toHaveBeenCalledTimes(1); client.dispose();
  });
  it("rejects a valid page returned for a different filter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ownerId: account.userId, query: { tab: "all_generations", limit: 40 }, items: [], nextCursor: null })));
    const expire = vi.fn(), client = createAccountAssetsClient(account, () => true, expire);
    expect(await client.list({ tab: "my_selection" })).toBeNull(); expect(expire).toHaveBeenCalledOnce(); client.dispose();
  });
  it.each([
    () => new Response("<html>Private error</html>", { headers: { "Content-Type": "text/html" } }),
    () => new Response("invalid json", { headers: { "Content-Type": "application/json" } }),
    () => Response.json({ ownerId: account.userId, value: "valid", extra: "unknown field" }),
    () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "4194305" } }),
  ])("fails closed on unparseable, unknown-field or oversized metadata", async response => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    await expect(client.request("/api/assets", envelope, owned)).rejects.toThrow(); client.dispose();
  });
  it("rejects unrelated origins and oversized mutations without a network request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    await expect(client.request("https://elsewhere.invalid/api/assets", envelope, owned)).rejects.toThrow();
    await expect(client.request("/api/assets", envelope, owned, { method: "PATCH", body: { value: "a".repeat(2049) } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); client.dispose();
  });
  it("suppresses a signed download response after ownership changes", async () => {
    let current = true, finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const client = createAccountAssetsClient(account, () => current, vi.fn());
    const pending = client.download(version()); current = false;
    finish(Response.json({ url: "https://files.example.invalid/private", versionId: id(4), contentHash: hash, mimeType: "image/png", expiresInSeconds: 60 }));
    expect(await pending).toBeNull(); client.dispose();
  });
  it("aborts active preview reads and queued consumers on disposal", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => { signals.push(options.signal!); options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); })));
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    const pending = [client.preview(version(4)), client.preview(version(5)), client.preview(version(6)), client.preview(version(7))];
    await vi.waitFor(() => expect(signals).toHaveLength(3)); client.dispose();
    expect(await Promise.all(pending)).toEqual([null, null, null, null]); expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it("reactivation cannot publish a response from a disposed request", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    const pending = client.request("/api/assets", envelope, owned); client.dispose(); client.activate(); finish(Response.json({ ownerId: account.userId, value: "Prior request" }));
    expect(await pending).toBeNull(); client.dispose();
  });
});

describe("legacy MIME transport compatibility", () => {
  it.each(["\ufeffimage/png\ufeff", "\u2028image/png\u2029", "\nimage/png\n", " IMAGE/PNG ; charset=binary "])("canonicalizes a supported legacy manifest MIME for real Request and Blob coercion: %j", async mimeType => {
    const manifest = assetVersionDetailSchema.parse({ ...version(), mimeType });
    const fetch = vi.fn(async (path: string, options: RequestInit) => {
      // Exercise native header ByteString conversion instead of only inspecting a mock argument.
      const request = new Request(new URL(path, "https://fluid.example.invalid"), options);
      expect(request.headers.get("accept")).toBe("image/png");
      return raster();
    });
    vi.stubGlobal("fetch", fetch);
    const client = createAccountAssetsClient(account, () => true, vi.fn());
    try {
      const preview = await client.preview(manifest);
      expect(preview).not.toBeNull();
      const blobResponse = await nativeFetch(preview!.url);
      expect(blobResponse.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await blobResponse.arrayBuffer())).toEqual(new Uint8Array(bytes));
      expect(manifest.mimeType).toBe(mimeType);
      preview!.release();
    } finally { client.dispose(); }
  });
});

describe('approved logo export evidence lookup',()=>{
 const manifest=()=>({id:id(10),ownerId:id(1),projectId:id(2),requestKey:id(11),approvedLogoId:id(12),directionApprovalId:id(13),variantSetId:id(14),variantReviewId:id(15),sourceSnapshotHash:'c'.repeat(64),files:[{role:'primary.black',format:'png',variantId:id(16),asset:{id:id(17),reference:{ownerId:id(1),projectId:id(2),assetId:id(3),versionId:id(4),contentHash:hash},verification:{status:'verified',checkedAt:'2026-10-07T00:00:00Z',contentHash:hash,mimeType:'image/png',byteLength:bytes.length},purpose:'brand_asset',sourceReceiptId:id(8),rightsEvidenceId:null,publicationState:'committed'}}],licenseOmissions:[],inputRevisions:[],createdAt:'2026-10-07T00:00:00Z'});
 it('accepts only exact owned version and byte evidence',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ownerId:id(1),projectId:id(2),versionId:id(4),manifest:manifest()})));const client=createAccountAssetsClient(account,()=>true,vi.fn());expect((await client.exportManifest(version()))?.id).toBe(id(10));client.dispose();});
 it('does not upgrade an asset from mismatched byte evidence',async()=>{const m=manifest();m.files[0]!.asset.reference.contentHash='f'.repeat(64);m.files[0]!.asset.verification.contentHash='f'.repeat(64);vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ownerId:id(1),projectId:id(2),versionId:id(4),manifest:m})));const expire=vi.fn(),client=createAccountAssetsClient(account,()=>true,expire);expect(await client.exportManifest(version())).toBeNull();expect(expire).toHaveBeenCalledWith(account);client.dispose();});
 it('fences delayed manifest evidence after account changes',async()=>{let current=true,finish!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>finish=resolve)));const client=createAccountAssetsClient(account,()=>current,vi.fn());const pending=client.exportManifest(version());current=false;finish(Response.json({ownerId:id(1),projectId:id(2),versionId:id(4),manifest:manifest()}));expect(await pending).toBeNull();client.dispose();});
});
