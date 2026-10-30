/** Local HTTP fixtures only: these tests do not access live accounts or Storage. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createVectorHttpFixture, ownerId, projectId } from "../features/logo-vector/http-fixture";
import type { AssetVersionReference } from "../../src/domain/asset-library";

const account = { status: "ready" as const, userId: ownerId, generation: 1 };
const link = (asset: AssetVersionReference, mimeType: string) => ({ url: "https://private-storage.example/signed-file?download=logo", versionId: asset.versionId, contentHash: asset.contentHash, mimeType, expiresInSeconds: 60 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

describe("direct saved logo downloads", () => {
  afterEach(() => vi.restoreAllMocks());

  it("downloads a verified saved SVG without an approval, direction, export job or paid request", async () => {
    const f = createVectorHttpFixture(), paths: string[] = [];
    const fetcher: typeof fetch = async (path, init) => {
      paths.push(String(path));
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error" });
      return String(path).endsWith("/download") ? Response.json(link(f.initial.revision.svgAsset, "image/svg+xml")) : f.fetcher(path, init);
    };
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), fetcher);
    expect(f.state.workspace.approvedLogo).toBeNull();
    expect(await client.downloadLogoVector(f.initial.revision.id)).toEqual(link(f.initial.revision.svgAsset, "image/svg+xml"));
    expect(paths).toEqual([`/api/projects/${projectId}/logo/vector/revisions/${f.initial.revision.id}`, `/api/assets/${f.initial.revision.svgAsset.versionId}/download`]);
    expect(f.state.posts).toEqual([]);
  });

  it("downloads the committed original PNG with its own hash, separately from the saved SVG", async () => {
    const f = createVectorHttpFixture(), fetcher = vi.fn(async () => Response.json(link(f.preview.reference, "image/png")));
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), fetcher);
    expect(await client.downloadAsset(f.preview)).toEqual(link(f.preview.reference, "image/png"));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/assets/${f.preview.reference.versionId}/download`, expect.objectContaining({ method: "GET" }));
  });

  it.each(["geometry", "owner", "id"])("never requests an SVG link for mismatched saved %s", async mismatch => {
    const f = createVectorHttpFixture(), requestedId = f.initial.revision.id;
    if (mismatch === "geometry") f.initial.document.components[0]!.paths[0]!.fill!.color = "#123456";
    if (mismatch === "owner") f.initial.revision.ownerId = projectId;
    if (mismatch === "id") f.initial.revision.id = projectId;
    const fetcher = vi.fn(async () => Response.json(f.initial));
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), fetcher);
    await expect(client.downloadLogoVector(requestedId)).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/api/projects/${projectId}/logo/vector/revisions/${requestedId}`, expect.anything());
  });

  it.each([
    { contentHash: "b".repeat(64) }, { versionId: projectId }, { mimeType: "image/png" },
    { url: "http://private-storage.example/file" }, { url: "https://user:password@private-storage.example/file" },
  ])("rejects a link that does not match the saved vector: %j", async override => {
    const f = createVectorHttpFixture();
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), async (path, init) => String(path).endsWith("/download")
      ? Response.json({ ...link(f.initial.revision.svgAsset, "image/svg+xml"), ...override }) : f.fetcher(path, init));
    await expect(client.downloadLogoVector(f.initial.revision.id)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects staged or foreign image receipts before requesting a download", async () => {
    const f = createVectorHttpFixture(), fetcher = vi.fn();
    const client = createAccountLogoClient(account, projectId, () => true, vi.fn(), fetcher);
    await expect(client.downloadAsset({ ...f.preview, publicationState: "staged" })).rejects.toMatchObject({ status: 422 });
    await expect(client.downloadAsset({ ...f.preview, reference: { ...f.preview.reference, ownerId: projectId } })).rejects.toMatchObject({ status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not request a link after the account changes during saved-vector verification", async () => {
    const f = createVectorHttpFixture(), gate = deferred<void>(); let current = true;
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => { await gate.promise; return originalDigest(algorithm, bytes); });
    const fetcher = vi.fn(f.fetcher), client = createAccountLogoClient(account, projectId, () => current, vi.fn(), fetcher);
    const pending = client.downloadLogoVector(f.initial.revision.id);
    await vi.waitFor(() => expect(hashing).toHaveBeenCalledTimes(1));
    current = false; gate.resolve();
    expect(await pending).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "account", "dispose"])("discards a delayed download link after %s", async change => {
    const f = createVectorHttpFixture(), response = deferred<Response>(), controller = new AbortController(); let current = true;
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => String(path).endsWith("/download") ? response.promise : f.fetcher(path, init));
    const client = createAccountLogoClient(account, projectId, () => current, vi.fn(), fetcher);
    const pending = client.downloadLogoVector(f.initial.revision.id, controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    if (change === "abort") controller.abort();
    else if (change === "account") current = false;
    else client.dispose();
    response.resolve(Response.json(link(f.initial.revision.svgAsset, "image/svg+xml")));
    expect(await pending).toBeNull();
  });
});
