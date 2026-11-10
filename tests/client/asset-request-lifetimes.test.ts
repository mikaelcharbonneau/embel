import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { assetRecordSchema, assetRevisionFreshness, assetVersionDetailSchema } from "@/domain/asset-library";
import { AccountRequestError } from "@/components/workspace/account-api";
import {
  ASSET_REQUEST_TIMEOUT_MS,
  AssetRequestTimeoutError,
  AssetWriteOutcomeUnknownError,
  assetErrorMessage,
  createAccountAssetsClient,
} from "@/components/assets/account-assets-client";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: id(1), generation: 1 };
const bytes = new Uint8Array([1, 2, 3]);
const version = assetVersionDetailSchema.parse({
  ownerId: id(1),
  projectId: id(2),
  assetId: id(3),
  versionId: id(4),
  contentHash: createHash("sha256").update(bytes).digest("hex"),
  inputHash: "a".repeat(64),
  inputRevision: 1,
  versionNumber: 1,
  createdAt: "2026-10-04T12:00:00Z",
  mimeType: "image/png",
  format: "png",
  provenance: { status: "legacy_unverified" },
  vectorStatus: "unverified",
  licenseStatus: "unverified",
  fileState: "unverified",
  fileVerification: null,
  freshness: assetRevisionFreshness(1, 1),
});
const asset = assetRecordSchema.parse({
  id: id(3),
  ownerId: id(1),
  projectId: id(2),
  kind: "Logo",
  purpose: "brand_asset",
  createdAt: version.createdAt,
  versionCount: 1,
  retentionRevision: 0,
  liked: false,
  saved: true,
  usage: { active: false, legacy: false },
  selectionRevision: 0,
  currentSelection: null,
});
const project = {
  id: id(2),
  owner_id: id(1),
  title: "Brand",
  scope: "complete_brand",
  current_revision: 1,
  created_at: version.createdAt,
};
const detail = {
  asset,
  project,
  selectedVersion: null,
  versions: {
    ownerId: id(1),
    projectId: id(2),
    assetId: id(3),
    format: null,
    items: [version],
    totalCount: 1,
    nextCursor: null,
  },
};
const retention = { expectedRetentionRevision: 0, liked: true, saved: true };
const selection = {
  versionId: id(4),
  expectedProjectRevision: 1,
  expectedSelectionRevision: 0,
  acceptStaleBasis: false,
};
const raster = () => new Response(bytes, { headers: { "content-type": "image/png" } });
const clients: ReturnType<typeof createAccountAssetsClient>[] = [];
const client = () => {
  const value = createAccountAssetsClient(account, () => true, vi.fn());
  clients.push(value);
  return value;
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clients.splice(0).forEach((value) => value.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bounded Assets requests", () => {
  it("rejects an uncooperative fetch at the deadline and discards its late response", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<(path: string, options: RequestInit) => Promise<Response>>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const scope = client();
    const result = scope.request("/api/assets", z.object({ value: z.string() }), () => true).catch((error) => error);
    await vi.advanceTimersByTimeAsync(ASSET_REQUEST_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(AssetRequestTimeoutError);
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(assetErrorMessage(await result)).toContain("timed out");
  });
  it("bounds a stalled metadata stream and cancels the reader", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"value":'));
              },
              cancel,
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const result = client()
      .request("/api/assets", z.object({ value: z.string() }), () => true)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(ASSET_REQUEST_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(AssetRequestTimeoutError);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("releases stalled preview slots and does not create late object URLs", async () => {
    const create = vi.spyOn(URL, "createObjectURL");
    const cancel = vi.fn();
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(new ReadableStream({ cancel }), { headers: { "content-type": "image/png" } }),
      )
      .mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const scope = client();
    const first = [scope.preview(version), scope.preview(version), scope.preview(version)].map((work) =>
      work.catch((error) => error),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const next = scope.preview(version).catch((error) => error);
    await vi.advanceTimersByTimeAsync(ASSET_REQUEST_TIMEOUT_MS - 1000);
    expect(await Promise.all(first)).toEqual(expect.arrayContaining([expect.any(AssetRequestTimeoutError)]));
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(cancel).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    scope.dispose();
    expect(await next).toBeNull();
  });
  it("bounds hashing and never creates an object URL from a late digest", async () => {
    let finish!: (hash: ArrayBuffer) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => raster()),
    );
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    );
    const create = vi.spyOn(URL, "createObjectURL");
    const result = client()
      .preview(version)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(ASSET_REQUEST_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(AssetRequestTimeoutError);
    finish(new Uint8Array(createHash("sha256").update(bytes).digest()).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(create).not.toHaveBeenCalled();
  });
  it("treats a stalled successful mutation body as unknown rather than acknowledged", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const scope = client();
    const result = scope.retain(asset, retention).catch((error) => error);
    await vi.advanceTimersByTimeAsync(ASSET_REQUEST_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(AssetWriteOutcomeUnknownError);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(scope.select(asset, selection)).rejects.toBeInstanceOf(AssetWriteOutcomeUnknownError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts active and queued uncooperative previews on dispose and can reactivate safely", async () => {
    const fetch = vi.fn<() => Promise<Response>>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const scope = client();
    const results = Array.from({ length: 4 }, () => scope.preview(version));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    scope.dispose();
    scope.activate();
    expect(await Promise.all(results)).toEqual([null, null, null, null]);
    fetch.mockImplementation(async () => raster());
    expect(await scope.preview(version)).not.toBeNull();
  });
  it.each(["retain", "select"] as const)(
    "keeps an uncertain %s blocked until a fresh verified detail read",
    async (method) => {
      let finish!: (response: Response) => void;
      const fetch = vi.fn().mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const scope = client();
      const result = (method === "retain" ? scope.retain(asset, retention) : scope.select(asset, selection)).catch(
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(ASSET_REQUEST_TIMEOUT_MS);
      expect(await result).toBeInstanceOf(AssetWriteOutcomeUnknownError);
      expect(assetErrorMessage(await result, "write")).toContain("may have been saved");
      await expect(scope.retain(asset, retention)).rejects.toBeInstanceOf(AssetWriteOutcomeUnknownError);
      await expect(scope.select(asset, selection)).rejects.toBeInstanceOf(AssetWriteOutcomeUnknownError);
      expect(fetch).toHaveBeenCalledTimes(1);
      finish(Response.json({ asset: { ...asset, liked: true, retentionRevision: 1 }, project }));
      await vi.advanceTimersByTimeAsync(0);
      await expect(scope.retain(asset, retention)).rejects.toBeInstanceOf(AssetWriteOutcomeUnknownError);
      fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(scope.reconcileWrites()).rejects.toBeInstanceOf(AccountRequestError);
      await expect(scope.retain(asset, retention)).rejects.toBeInstanceOf(AssetWriteOutcomeUnknownError);
      fetch.mockResolvedValueOnce(Response.json(detail));
      expect(await scope.reconcileWrites()).toBe(true);
      fetch.mockResolvedValueOnce(Response.json({ asset: { ...asset, liked: true, retentionRevision: 1 }, project }));
      expect(await scope.retain(asset, retention)).not.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );
  it("does not reconcile uncertainty with a read started before the write timed out", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetch);
    const scope = client();
    const write = scope.retain(asset, retention).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const read = scope.detail(asset);
    await vi.advanceTimersByTimeAsync(ASSET_REQUEST_TIMEOUT_MS - 1000);
    expect(await write).toBeInstanceOf(AssetWriteOutcomeUnknownError);
    finish(Response.json(detail));
    expect(await read).not.toBeNull();
    await expect(scope.retain(asset, retention)).rejects.toBeInstanceOf(AssetWriteOutcomeUnknownError);
  });
  it("keeps an acknowledged rejection distinct from an unknown transport outcome", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const scope = client();
    await expect(scope.retain(asset, retention)).rejects.toMatchObject({ status: 409 });
    await expect(scope.retain(asset, retention)).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
