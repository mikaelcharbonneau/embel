import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";

// Private file Storage for the generation engine: bucket fluid-assets, one path
// per immutable asset version, {owner}/{project}/{asset}/{version}, exactly as
// the shared worker and the download routes use it. The engine authenticates
// with a Supabase secret API key (sb_secret_…) sent on the apikey header; it is
// not a JWT. Only workflow step bodies may construct this client, and every
// path is checked against the run's own owner and project before any request.

const BUCKET = "fluid-assets";
/** The bucket's own size limit. */
const MAX_OBJECT_BYTES = 52_428_800;
const uuid = z.uuid();
const REQUEST_TIMEOUT_MS = 60_000;

export class EngineStorageError extends Error {
  constructor(
    readonly code: "storage_path_refused" | "storage_unavailable" | "storage_not_found" | "storage_mismatch",
  ) {
    super(code);
    this.name = "EngineStorageError";
  }
}

export type OwnedAsset = { ownerId: string; projectId: string; assetId: string; versionId: string };
/**
 * The object path of one asset version that belongs to the run's owner and
 * project. Anything else (another owner, another project, a malformed id) is
 * refused before Storage is ever called.
 */
export function ownedAssetPath(run: { ownerId: string; projectId: string }, asset: OwnedAsset): string {
  const ids = [run.ownerId, run.projectId, asset.ownerId, asset.projectId, asset.assetId, asset.versionId];
  if (
    !ids.every((id) => typeof id === "string" && uuid.safeParse(id).success && id === id.toLowerCase()) ||
    asset.ownerId !== run.ownerId ||
    asset.projectId !== run.projectId
  )
    throw new EngineStorageError("storage_path_refused");
  return `${asset.ownerId}/${asset.projectId}/${asset.assetId}/${asset.versionId}`;
}
/** Re-checks a finished path string against the owner prefix, as a last guard. */
function assertOwnedPath(run: { ownerId: string; projectId: string }, path: string) {
  const parts = path.split("/");
  if (parts.length !== 4) throw new EngineStorageError("storage_path_refused");
  ownedAssetPath(run, { ownerId: parts[0]!, projectId: parts[1]!, assetId: parts[2]!, versionId: parts[3]! });
}

export interface EngineStorage {
  /** Stores new bytes once. A path that already holds these exact bytes is fine. */
  put(
    run: { ownerId: string; projectId: string },
    asset: OwnedAsset,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<void>;
  /** Reads one owned object and checks its hash. */
  get(
    run: { ownerId: string; projectId: string },
    asset: OwnedAsset & { contentHash: string },
  ): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function createEngineStorage(options: { url: string; secretKey: string; fetch?: typeof fetch }): EngineStorage {
  const fetcher = options.fetch ?? fetch;
  const origin = new URL(options.url);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol === "http:" && !["127.0.0.1", "localhost"].includes(origin.hostname))
  )
    throw new Error("storage_unconfigured");
  if (!/^[A-Za-z0-9._-]{20,500}$/u.test(options.secretKey)) throw new Error("storage_unconfigured");
  const headers = { apikey: options.secretKey };
  const objectUrl = (path: string, read: boolean) =>
    `${origin.origin}/storage/v1/object/${read ? "authenticated/" : ""}${BUCKET}/${path}`;

  async function call(url: string, init: RequestInit) {
    try {
      return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new EngineStorageError("storage_unavailable");
    }
  }
  async function read(path: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const response = await call(objectUrl(path, true), {
      method: "GET",
      headers: { ...headers, "accept-encoding": "identity" },
    });
    if (response.status === 404 || response.status === 400) {
      await response.body?.cancel().catch(() => {});
      throw new EngineStorageError("storage_not_found");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new EngineStorageError("storage_unavailable");
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_OBJECT_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new EngineStorageError("storage_mismatch");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new EngineStorageError("storage_mismatch");
    return { bytes, mimeType: (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() };
  }
  return {
    async put(run, asset, raw, mimeType) {
      const path = ownedAssetPath(run, asset);
      assertOwnedPath(run, path);
      if (
        !(raw instanceof Uint8Array) ||
        raw.byteLength < 1 ||
        raw.byteLength > MAX_OBJECT_BYTES ||
        !/^image\/(png|jpeg|webp)$/u.test(mimeType)
      )
        throw new EngineStorageError("storage_mismatch");
      const bytes = Uint8Array.from(raw);
      const response = await call(objectUrl(path, false), {
        method: "POST",
        body: bytes,
        headers: { ...headers, "content-type": mimeType, "x-upsert": "false", "cache-control": "max-age=31536000" },
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const text = await response.text().catch(() => "");
      // A repeated upload of the same version keeps the first bytes; accept it only if they are ours.
      if ((response.status === 409 || response.status === 400) && /already exists|Duplicate/iu.test(text)) {
        const stored = await read(path);
        if (sha256(stored.bytes) === sha256(bytes) && stored.mimeType === mimeType) return;
        throw new EngineStorageError("storage_mismatch");
      }
      throw new EngineStorageError("storage_unavailable");
    },
    async get(run, asset) {
      const path = ownedAssetPath(run, asset);
      assertOwnedPath(run, path);
      if (!/^[0-9a-f]{64}$/u.test(asset.contentHash)) throw new EngineStorageError("storage_mismatch");
      const stored = await read(path);
      if (sha256(stored.bytes) !== asset.contentHash) throw new EngineStorageError("storage_mismatch");
      return stored;
    },
  };
}

let shared: EngineStorage | null = null;
/** Storage for workflow steps: the project's Supabase URL and the engine's secret key. */
export function engineStorage(): EngineStorage {
  if (shared) return shared;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.EMBEL_ENGINE_SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("storage_unconfigured");
  shared = createEngineStorage({ url, secretKey: key });
  return shared;
}
