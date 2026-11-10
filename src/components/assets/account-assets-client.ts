import { z } from "zod";
import { isSignedDownloadUrl } from "@/domain/signed-download-url";
import { assetLogoExportResponseSchema } from "@/features/identity-deliverables/model/asset-export-response";
import {
  ASSET_MAX_FILE_BYTES,
  assetDetailQuerySchema,
  assetDetailSchema,
  assetLibraryPageSchema,
  assetLibraryQuerySchema,
  assetRetentionResponseSchema,
  assetSelectionResponseSchema,
  assetVersionDetailSchema,
  selectAssetVersionSchema,
  setAssetRetentionSchema,
  type AssetDetailQuery,
  type AssetLibraryQuery,
  type AssetRecord,
  type AssetVersionDetail,
  type SelectAssetVersion,
  type SetAssetRetention,
} from "@/domain/asset-library";
import { accountProjectListSchema } from "@/domain/project-api";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const downloadSchema = z.strictObject({
  url: z.url().max(8192).refine(isSignedDownloadUrl),
  versionId: z.uuid(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().min(1).max(150),
  expiresInSeconds: z.literal(60),
});
const rasterMimes = new Set(["image/png", "image/jpeg", "image/webp"]);
const mimeBase = (value: string) => value.split(";", 1)[0]!.trim().toLowerCase();
export const canReadAssetFile = (version: AssetVersionDetail) =>
  version.fileState === "unverified" || version.fileState === "verified";
export const canPreviewAsset = (version: AssetVersionDetail) =>
  canReadAssetFile(version) && rasterMimes.has(mimeBase(version.mimeType));

/** One deadline covers headers, body consumption and integrity verification. */
export const ASSET_REQUEST_TIMEOUT_MS = 30_000;
export class AssetRequestTimeoutError extends Error {}
export class AssetWriteOutcomeUnknownError extends Error {}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      void work.catch(() => undefined);
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBytes(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) throw new AccountRequestError(502);
  const reader = response.body?.getReader();
  if (!reader) throw new AccountRequestError(502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new AccountRequestError(502);
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!total) throw new AccountRequestError(502);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function queryString(query: AssetLibraryQuery | AssetDetailQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  return params.toString();
}

/** A tab-local private scope. Every response is checked again after its last await. */
export function createAccountAssetsClient(
  account: VerifiedAccount,
  isCurrent: (account: VerifiedAccount) => boolean,
  expire: (account: VerifiedAccount) => void,
) {
  let closed = false,
    previews = 0;
  const controllers = new Set<AbortController>(),
    urls = new Set<string>();
  const waiting = new Set<() => void>();
  const uncertainWrites = new Map<string, { asset: AssetRecord; token: symbol }>();
  const writing = new Set<string>();
  const current = () => !closed && isCurrent(account);
  const owned = (row: { ownerId: string }) => row.ownerId === account.userId;
  function controller(external?: AbortSignal) {
    const value = new AbortController();
    const abort = () => value.abort();
    if (external?.aborted) value.abort();
    else external?.addEventListener("abort", abort, { once: true });
    controllers.add(value);
    const timer = setTimeout(() => value.abort(new AssetRequestTimeoutError()), ASSET_REQUEST_TIMEOUT_MS);
    return {
      value,
      release: () => {
        clearTimeout(timer);
        controllers.delete(value);
        external?.removeEventListener("abort", abort);
      },
    };
  }
  function dispose() {
    closed = true;
    controllers.forEach((value) => value.abort());
    controllers.clear();
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
  }
  function invalidate() {
    dispose();
    expire(account);
  }
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    verify: (value: T) => boolean,
    options: { method?: "GET" | "POST" | "PATCH"; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T | null> {
    if (!current() || options.signal?.aborted) return null;
    if (!/^\/api\/(?:assets(?:\/|\?|$)|projects(?:\?|$))/.test(path)) throw new AccountRequestError(422);
    const pending = controller(options.signal),
      signal = pending.value.signal;
    let response: Response | undefined;
    try {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (body && new TextEncoder().encode(body).byteLength > 2048) throw new AccountRequestError(413);
      const received = await abortable<Response>(
        fetch(path, {
          method: options.method ?? "GET",
          credentials: "same-origin",
          mode: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal,
          headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body } : {}),
        }).then((response) => {
          if (signal.aborted || !current()) void response.body?.cancel().catch(() => undefined);
          return response;
        }),
        signal,
      );
      response = received;
      if (!current() || signal.aborted) return null;
      if (received.status === 401) {
        invalidate();
        return null;
      }
      if (!received.ok) throw new AccountRequestError(received.status);
      if (mimeBase(received.headers.get("content-type") ?? "") !== "application/json")
        throw new AccountRequestError(502);
      const bytes = await readBytes(received, 4 * 1024 * 1024, signal);
      if (!current() || signal.aborted) return null;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new AccountRequestError(502);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AccountRequestError(502);
      if (!verify(parsed.data)) {
        invalidate();
        return null;
      }
      return parsed.data;
    } catch (error) {
      if (!current()) return null;
      if (signal.reason instanceof AssetRequestTimeoutError) throw signal.reason;
      if (signal.aborted) return null;
      throw error;
    } finally {
      pending.release();
      if (response && !response.body?.locked) void response.body?.cancel().catch(() => undefined);
    }
  }
  async function acquire(signal: AbortSignal): Promise<boolean> {
    while (previews >= 3 && current() && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiting.delete(wake);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        waiting.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (!current() || signal.aborted) return false;
    previews += 1;
    return true;
  }
  async function preview(input: AssetVersionDetail, external?: AbortSignal) {
    if (!current() || external?.aborted) return null;
    const version = assetVersionDetailSchema.parse(input);
    if (!owned(version)) {
      invalidate();
      return null;
    }
    if (!canPreviewAsset(version)) throw new AccountRequestError(422);
    const transportMime = mimeBase(version.mimeType);
    const pending = controller(external),
      signal = pending.value.signal;
    let acquired = false;
    let response: Response | undefined;
    try {
      acquired = await acquire(signal);
      if (!acquired) {
        if (current() && signal.reason instanceof AssetRequestTimeoutError) throw signal.reason;
        return null;
      }
      const received = await abortable<Response>(
        fetch(`/api/assets/${version.versionId}/preview`, {
          credentials: "same-origin",
          mode: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal,
          headers: { Accept: transportMime },
        }).then((response) => {
          if (signal.aborted || !current()) void response.body?.cancel().catch(() => undefined);
          return response;
        }),
        signal,
      );
      response = received;
      if (!current() || signal.aborted) return null;
      if (received.status === 401) {
        invalidate();
        return null;
      }
      if (!received.ok) throw new AccountRequestError(received.status);
      if (mimeBase(received.headers.get("content-type") ?? "") !== transportMime) throw new AccountRequestError(502);
      const bytes = await readBytes(received, ASSET_MAX_FILE_BYTES, signal);
      if (!current() || signal.aborted) return null;
      const digest = await abortable(crypto.subtle.digest("SHA-256", bytes), signal);
      if (!current() || signal.aborted) return null;
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== version.contentHash) throw new AccountRequestError(502);
      const url = URL.createObjectURL(new Blob([bytes], { type: transportMime }));
      urls.add(url);
      return {
        url,
        release: () => {
          URL.revokeObjectURL(url);
          urls.delete(url);
        },
      };
    } catch (error) {
      if (!current()) return null;
      if (signal.reason instanceof AssetRequestTimeoutError) throw signal.reason;
      if (signal.aborted) return null;
      throw error;
    } finally {
      pending.release();
      if (response && !response.body?.locked) void response.body?.cancel().catch(() => undefined);
      if (acquired) {
        previews -= 1;
        [...waiting].forEach((wake) => wake());
      }
    }
  }
  async function download(input: AssetVersionDetail) {
    const version = assetVersionDetailSchema.parse(input);
    if (!current()) return null;
    if (!owned(version)) {
      invalidate();
      return null;
    }
    if (!canReadAssetFile(version)) throw new AccountRequestError(422);
    const reply = await request(`/api/assets/${version.versionId}/download`, downloadSchema, () => true);
    if (
      reply &&
      (reply.versionId !== version.versionId ||
        reply.contentHash !== version.contentHash ||
        mimeBase(reply.mimeType) !== mimeBase(version.mimeType))
    )
      throw new AccountRequestError(502);
    return reply;
  }
  async function mutate<T>(asset: AssetRecord, execute: () => Promise<T | null>): Promise<T | null> {
    if (!current()) return null;
    if (writing.has(asset.id) || uncertainWrites.has(asset.id)) throw new AssetWriteOutcomeUnknownError();
    writing.add(asset.id);
    try {
      return await execute();
    } catch (error) {
      // A transport failure or unverifiable successful reply cannot prove that
      // the server did not commit. Known client rejections remain distinct.
      if (current() && (!(error instanceof AccountRequestError) || error.status === 408 || error.status >= 500)) {
        uncertainWrites.set(asset.id, { asset, token: Symbol() });
        throw new AssetWriteOutcomeUnknownError();
      }
      throw error;
    } finally {
      writing.delete(asset.id);
    }
  }
  async function detail(asset: AssetRecord, input: Partial<AssetDetailQuery> = {}, signal?: AbortSignal) {
    const query = assetDetailQuerySchema.parse(input);
    if (query.cursor && (query.cursor.assetId !== asset.id || query.cursor.projectId !== asset.projectId))
      throw new AccountRequestError(422);
    const uncertain = uncertainWrites.get(asset.id);
    const reply = await request(
      `/api/assets/library/${asset.id}?${queryString(query)}`,
      assetDetailSchema,
      (value) =>
        owned(value.asset) &&
        value.asset.id === asset.id &&
        value.asset.projectId === asset.projectId &&
        value.versions.format === (query.format ?? null),
      { signal },
    );
    // Only a fresh head read begun after the uncertain outcome reconciles it.
    if (
      reply &&
      !query.cursor &&
      uncertain &&
      uncertainWrites.get(asset.id)?.token === uncertain.token &&
      !writing.has(asset.id)
    )
      uncertainWrites.delete(asset.id);
    return reply;
  }
  return {
    current,
    request,
    preview,
    download,
    dispose,
    activate: () => {
      closed = false;
    },
    async exportManifest(input: AssetVersionDetail, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const version = assetVersionDetailSchema.parse(input);
      if (!owned(version)) {
        invalidate();
        return null;
      }
      const result = await request(
        `/api/assets/${version.versionId}/logo-export`,
        assetLogoExportResponseSchema,
        (value) =>
          owned(value) &&
          value.projectId === version.projectId &&
          value.versionId === version.versionId &&
          (!value.manifest ||
            value.manifest.files.some((file) => {
              const ref = file.asset.reference;
              return (
                file.asset.publicationState === "committed" &&
                ref.ownerId === version.ownerId &&
                ref.projectId === version.projectId &&
                ref.assetId === version.assetId &&
                ref.versionId === version.versionId &&
                ref.contentHash === version.contentHash &&
                file.asset.verification.mimeType === version.mimeType &&
                file.format === version.format
              );
            })),
        { signal },
      );
      return result?.manifest ?? null;
    },
    list(input: Partial<AssetLibraryQuery>, signal?: AbortSignal) {
      const query = assetLibraryQuerySchema.parse(input);
      return request(
        `/api/assets?${queryString(query)}`,
        assetLibraryPageSchema,
        (value) => owned(value) && JSON.stringify(value.query) === JSON.stringify(query),
        { signal },
      );
    },
    detail,
    async reconcileWrites(signal?: AbortSignal) {
      for (const { asset } of [...uncertainWrites.values()]) {
        if (!(await detail(asset, {}, signal))) return false;
      }
      return uncertainWrites.size === 0;
    },
    retain(asset: AssetRecord, input: SetAssetRetention) {
      const body = setAssetRetentionSchema.parse(input);
      return mutate(asset, () =>
        request(
          `/api/assets/library/${asset.id}/retention`,
          assetRetentionResponseSchema,
          (value) =>
            owned(value.asset) &&
            value.asset.id === asset.id &&
            value.asset.projectId === asset.projectId &&
            value.asset.retentionRevision === body.expectedRetentionRevision + 1 &&
            value.asset.liked === body.liked &&
            value.asset.saved === body.saved,
          { method: "PATCH", body },
        ),
      );
    },
    select(asset: AssetRecord, input: SelectAssetVersion) {
      const body = selectAssetVersionSchema.parse(input);
      return mutate(asset, () =>
        request(
          `/api/assets/library/${asset.id}/selection`,
          assetSelectionResponseSchema,
          (value) =>
            owned(value.asset) &&
            value.asset.id === asset.id &&
            value.asset.projectId === asset.projectId &&
            value.asset.selectionRevision === body.expectedSelectionRevision + 1 &&
            value.asset.currentSelection?.versionId === body.versionId &&
            value.project.current_revision === body.expectedProjectRevision,
          { method: "POST", body },
        ),
      );
    },
    projects(signal?: AbortSignal) {
      return request(
        "/api/projects",
        accountProjectListSchema,
        (value) => value.projects.every((project) => project.owner_id === account.userId),
        { signal },
      );
    },
  };
}
export type AccountAssetsClient = ReturnType<typeof createAccountAssetsClient>;

export function assetErrorMessage(error: unknown, action: "read" | "write" | "file" = "read"): string {
  if (error instanceof AssetWriteOutcomeUnknownError)
    return "The change may have been saved, but its outcome could not be confirmed. Check the latest asset before making another change.";
  if (error instanceof AssetRequestTimeoutError)
    return action === "file"
      ? "The file check timed out. Try again."
      : "The asset request timed out. Check your connection and try again.";
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "This asset or its brand changed. Check the latest version before trying again.";
    if (error.status === 404)
      return action === "file"
        ? "This file is unavailable. Its saved version remains in the library."
        : "This asset is no longer available to this account.";
    if (error.status === 503)
      return action === "file"
        ? "Private files are unavailable right now."
        : "The account asset library is unavailable right now.";
    if (error.status === 502) return "The asset response could not be verified. Check again to reload it.";
  }
  return action === "write"
    ? "The change could not be confirmed. Check the latest asset before trying again."
    : action === "file"
      ? "The file could not be checked. Try again."
      : "Assets could not be loaded. Check your connection and try again.";
}
