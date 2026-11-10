import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import {
  createEngineStorage,
  EngineStorageError,
  engineStorage,
  ownedAssetPath,
} from "../../src/server/engine/storage";

// Synthetic Storage only: no network, and no real key.
const owner = "aaaaaaaa-1111-4111-8111-111111111111",
  project = "bbbbbbbb-2222-4222-8222-222222222222",
  other = "dddddddd-4444-4444-8444-444444444444";
const assetId = "11111111-7777-4777-8777-777777777771",
  versionId = "2222abcd-7777-4777-8777-777777777771";
const run = { ownerId: owner, projectId: project };
const mine = { ownerId: owner, projectId: project, assetId, versionId };
const key = "sb_secret_synthetic_engine_key_0000";
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const hash = createHash("sha256").update(bytes).digest("hex");

function storage(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return answer(String(url), init!);
  });
  return {
    calls,
    store: createEngineStorage({
      url: "https://project.example.supabase.co",
      secretKey: key,
      fetch: fetch as unknown as typeof globalThis.fetch,
    }),
  };
}

describe("owner paths", () => {
  it("is {owner}/{project}/{asset}/{version} for the run's own owner and project", () => {
    expect(ownedAssetPath(run, mine)).toBe(`${owner}/${project}/${assetId}/${versionId}`);
  });
  it.each([
    ["another owner", { ...mine, ownerId: other }],
    ["another project", { ...mine, projectId: other }],
    ["a malformed asset id", { ...mine, assetId: "../../etc" }],
    ["an uppercase id", { ...mine, versionId: versionId.toUpperCase() }],
    ["a nested path", { ...mine, assetId: `${assetId}/x` }],
  ])("refuses %s before Storage is called", async (_label, target) => {
    expect(() => ownedAssetPath(run, target)).toThrow(EngineStorageError);
    const { calls, store } = storage(() => new Response("{}"));
    await expect(store.put(run, target, bytes, "image/png")).rejects.toThrow("storage_path_refused");
    await expect(store.get(run, { ...target, contentHash: hash })).rejects.toThrow("storage_path_refused");
    expect(calls).toEqual([]);
  });
});

describe("engine Storage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes once to the private bucket with the secret key on the apikey header only", async () => {
    const { calls, store } = storage(() =>
      Response.json({ Id: versionId, Key: `fluid-assets/${owner}/${project}/${assetId}/${versionId}` }),
    );
    await store.put(run, mine, bytes, "image/png");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://project.example.supabase.co/storage/v1/object/fluid-assets/${owner}/${project}/${assetId}/${versionId}`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.headers).toMatchObject({ apikey: key, "content-type": "image/png", "x-upsert": "false" });
    expect(calls[0]!.init.headers).not.toHaveProperty("Authorization");
    expect(calls[0]!.init.headers).not.toHaveProperty("authorization");
  });
  it("accepts a repeated write only when the stored bytes are exactly these", async () => {
    const duplicate = () =>
      new Response(JSON.stringify({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }), {
        status: 409,
      });
    const same = storage((url) =>
      url.includes("/authenticated/") ? new Response(bytes, { headers: { "content-type": "image/png" } }) : duplicate(),
    );
    await same.store.put(run, mine, bytes, "image/png");
    const changed = storage((url) =>
      url.includes("/authenticated/")
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
        : duplicate(),
    );
    await expect(changed.store.put(run, mine, bytes, "image/png")).rejects.toThrow("storage_mismatch");
  });
  it("reads an owned object and checks its hash", async () => {
    const { calls, store } = storage(() => new Response(bytes, { headers: { "content-type": "image/png" } }));
    expect(await store.get(run, { ...mine, contentHash: hash })).toEqual({ bytes, mimeType: "image/png" });
    expect(calls[0]!.url).toBe(
      `https://project.example.supabase.co/storage/v1/object/authenticated/fluid-assets/${owner}/${project}/${assetId}/${versionId}`,
    );
    await expect(store.get(run, { ...mine, contentHash: "0".repeat(64) })).rejects.toThrow("storage_mismatch");
  });
  it("tells a missing object from an outage", async () => {
    await expect(
      storage(() => new Response("{}", { status: 404 })).store.get(run, { ...mine, contentHash: hash }),
    ).rejects.toThrow("storage_not_found");
    await expect(
      storage(() => new Response("{}", { status: 503 })).store.get(run, { ...mine, contentHash: hash }),
    ).rejects.toThrow("storage_unavailable");
    await expect(
      storage(() => {
        throw new TypeError("fetch failed");
      }).store.put(run, mine, bytes, "image/png"),
    ).rejects.toThrow("storage_unavailable");
  });
  it("needs its URL and secret key, and allows plain HTTP only on this machine", () => {
    expect(() => createEngineStorage({ url: "http://project.example.supabase.co", secretKey: key })).toThrow(
      "storage_unconfigured",
    );
    expect(() => createEngineStorage({ url: "https://project.example.supabase.co/path", secretKey: key })).toThrow(
      "storage_unconfigured",
    );
    expect(() => createEngineStorage({ url: "https://project.example.supabase.co", secretKey: "short" })).toThrow(
      "storage_unconfigured",
    );
    expect(() => createEngineStorage({ url: "http://127.0.0.1:54321", secretKey: key })).not.toThrow();
    vi.stubEnv("EMBEL_ENGINE_SUPABASE_SECRET_KEY", "");
    expect(() => engineStorage()).toThrow("storage_unconfigured");
  });
});
