import { z } from "zod";
import { assetLogoExportResponseSchema } from "@/features/identity-deliverables/model/asset-export-response";
import {
  ASSET_MAX_FILE_BYTES, assetDetailQuerySchema, assetDetailSchema, assetLibraryPageSchema,
  assetLibraryQuerySchema, assetRetentionResponseSchema, assetSelectionResponseSchema,
  assetVersionDetailSchema, selectAssetVersionSchema, setAssetRetentionSchema,
  type AssetDetailQuery, type AssetLibraryQuery, type AssetRecord, type AssetVersionDetail,
  type SelectAssetVersion, type SetAssetRetention,
} from "@/domain/asset-library";
import { accountProjectListSchema } from "@/domain/project-api";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const downloadSchema = z.strictObject({
  url: z.url().max(8192).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }),
  versionId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string().min(1).max(150), expiresInSeconds: z.literal(60),
});
const rasterMimes = new Set(["image/png", "image/jpeg", "image/webp"]);
const mimeBase = (value: string) => value.split(";", 1)[0]!.trim().toLowerCase();
export const canReadAssetFile = (version: AssetVersionDetail) => version.fileState === "unverified" || version.fileState === "verified";
export const canPreviewAsset = (version: AssetVersionDetail) => canReadAssetFile(version) && rasterMimes.has(mimeBase(version.mimeType));

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
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new AccountRequestError(502);
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!total) throw new AccountRequestError(502);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function queryString(query: AssetLibraryQuery | AssetDetailQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  return params.toString();
}

/** A tab-local private scope. Every response is checked again after its last await. */
export function createAccountAssetsClient(account: VerifiedAccount, isCurrent: (account: VerifiedAccount) => boolean, expire: (account: VerifiedAccount) => void) {
  let closed = false, previews = 0;
  const controllers = new Set<AbortController>(), urls = new Set<string>();
  const waiting = new Set<() => void>();
  const current = () => !closed && isCurrent(account);
  const owned = (row: { ownerId: string }) => row.ownerId === account.userId;
  function controller(external?: AbortSignal) {
    const value = new AbortController();
    const abort = () => value.abort();
    if (external?.aborted) value.abort(); else external?.addEventListener("abort", abort, { once: true });
    controllers.add(value);
    return { value, release: () => { controllers.delete(value); external?.removeEventListener("abort", abort); } };
  }
  function dispose() {
    closed = true;
    controllers.forEach(value => value.abort()); controllers.clear();
    urls.forEach(url => URL.revokeObjectURL(url)); urls.clear();
  }
  function invalidate() { dispose(); expire(account); }
  async function request<T>(path: string, schema: z.ZodType<T>, verify: (value: T) => boolean, options: { method?: "GET" | "POST" | "PATCH"; body?: unknown; signal?: AbortSignal } = {}): Promise<T | null> {
    if (!current()) return null;
    if (!/^\/api\/(?:assets(?:\/|\?|$)|projects(?:\?|$))/.test(path)) throw new AccountRequestError(422);
    const pending = controller(options.signal), signal = pending.value.signal;
    try {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (body && new TextEncoder().encode(body).byteLength > 2048) throw new AccountRequestError(413);
      const response = await fetch(path, { method: options.method ?? "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body } : {}) });
      if (!current() || signal.aborted) return null;
      if (response.status === 401) { invalidate(); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (mimeBase(response.headers.get("content-type") ?? "") !== "application/json") throw new AccountRequestError(502);
      const bytes = await readBytes(response, 4 * 1024 * 1024, signal);
      if (!current() || signal.aborted) return null;
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AccountRequestError(502); }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AccountRequestError(502);
      if (!verify(parsed.data)) { invalidate(); return null; }
      return parsed.data;
    } catch (error) { if (!current() || signal.aborted) return null; throw error; }
    finally { pending.release(); }
  }
  async function acquire(signal: AbortSignal): Promise<boolean> {
    while (previews >= 3 && current() && !signal.aborted) {
      await new Promise<void>(resolve => {
        const wake = () => { waiting.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
        waiting.add(wake); signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (!current() || signal.aborted) return false;
    previews += 1; return true;
  }
  async function preview(input: AssetVersionDetail, external?: AbortSignal) {
    if (!current()) return null;
    const version = assetVersionDetailSchema.parse(input);
    if (!owned(version)) { invalidate(); return null; }
    if (!canPreviewAsset(version)) throw new AccountRequestError(422);
    const transportMime = mimeBase(version.mimeType);
    const pending = controller(external), signal = pending.value.signal;
    let acquired = false;
    try {
      acquired = await acquire(signal);
      if (!acquired) return null;
      const response = await fetch(`/api/assets/${version.versionId}/preview`, { credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal, headers: { Accept: transportMime } });
      if (!current() || signal.aborted) return null;
      if (response.status === 401) { invalidate(); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (mimeBase(response.headers.get("content-type") ?? "") !== transportMime) throw new AccountRequestError(502);
      const bytes = await readBytes(response, ASSET_MAX_FILE_BYTES, signal);
      if (!current() || signal.aborted) return null;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      if (!current() || signal.aborted) return null;
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== version.contentHash) throw new AccountRequestError(502);
      const url = URL.createObjectURL(new Blob([bytes], { type: transportMime }));
      urls.add(url);
      return { url, release: () => { URL.revokeObjectURL(url); urls.delete(url); } };
    } catch (error) { if (!current() || signal.aborted) return null; throw error; }
    finally { pending.release(); if (acquired) { previews -= 1; [...waiting].forEach(wake => wake()); } }
  }
  async function download(input: AssetVersionDetail) {
    const version = assetVersionDetailSchema.parse(input);
    if (!current()) return null;
    if (!owned(version)) { invalidate(); return null; }
    if (!canReadAssetFile(version)) throw new AccountRequestError(422);
    const reply = await request(`/api/assets/${version.versionId}/download`, downloadSchema, () => true);
    if (reply && (reply.versionId !== version.versionId || reply.contentHash !== version.contentHash || mimeBase(reply.mimeType) !== mimeBase(version.mimeType))) throw new AccountRequestError(502);
    return reply;
  }
  return {
    current, request, preview, download, dispose, activate: () => { closed = false; },
    async exportManifest(input: AssetVersionDetail, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const version = assetVersionDetailSchema.parse(input);
      if (!owned(version)) { invalidate(); return null; }
      const result = await request(`/api/assets/${version.versionId}/logo-export`, assetLogoExportResponseSchema, value =>
        owned(value) && value.projectId === version.projectId && value.versionId === version.versionId && (!value.manifest || value.manifest.files.some(file => {
          const ref = file.asset.reference;
          return file.asset.publicationState === "committed" && ref.ownerId === version.ownerId && ref.projectId === version.projectId && ref.assetId === version.assetId && ref.versionId === version.versionId && ref.contentHash === version.contentHash && file.asset.verification.mimeType === version.mimeType && file.format === version.format;
        })), { signal });
      return result?.manifest ?? null;
    },
    list(input: Partial<AssetLibraryQuery>, signal?: AbortSignal) {
      const query = assetLibraryQuerySchema.parse(input);
      return request(`/api/assets?${queryString(query)}`, assetLibraryPageSchema, value => owned(value) && JSON.stringify(value.query) === JSON.stringify(query), { signal });
    },
    detail(asset: AssetRecord, input: Partial<AssetDetailQuery> = {}, signal?: AbortSignal) {
      const query = assetDetailQuerySchema.parse(input);
      if (query.cursor && (query.cursor.assetId !== asset.id || query.cursor.projectId !== asset.projectId)) throw new AccountRequestError(422);
      return request(`/api/assets/library/${asset.id}?${queryString(query)}`, assetDetailSchema, value => owned(value.asset) && value.asset.id === asset.id && value.asset.projectId === asset.projectId && value.versions.format === (query.format ?? null), { signal });
    },
    retain(asset: AssetRecord, input: SetAssetRetention) {
      const body = setAssetRetentionSchema.parse(input);
      return request(`/api/assets/library/${asset.id}/retention`, assetRetentionResponseSchema, value => owned(value.asset) && value.asset.id === asset.id && value.asset.projectId === asset.projectId && value.asset.retentionRevision === body.expectedRetentionRevision + 1 && value.asset.liked === body.liked && value.asset.saved === body.saved, { method: "PATCH", body });
    },
    select(asset: AssetRecord, input: SelectAssetVersion) {
      const body = selectAssetVersionSchema.parse(input);
      return request(`/api/assets/library/${asset.id}/selection`, assetSelectionResponseSchema, value => owned(value.asset) && value.asset.id === asset.id && value.asset.projectId === asset.projectId && value.asset.selectionRevision === body.expectedSelectionRevision + 1 && value.asset.currentSelection?.versionId === body.versionId && value.project.current_revision === body.expectedProjectRevision, { method: "POST", body });
    },
    projects(signal?: AbortSignal) { return request("/api/projects", accountProjectListSchema, value => value.projects.every(project => project.owner_id === account.userId), { signal }); },
  };
}
export type AccountAssetsClient = ReturnType<typeof createAccountAssetsClient>;

export function assetErrorMessage(error: unknown, action: "read" | "write" | "file" = "read"): string {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "This asset or its brand changed. Check the latest version before trying again.";
    if (error.status === 404) return action === "file" ? "This file is unavailable. Its saved version remains in the library." : "This asset is no longer available to this account.";
    if (error.status === 503) return action === "file" ? "Private files are unavailable right now." : "The account asset library is unavailable right now.";
    if (error.status === 502) return "The asset response could not be verified. Check again to reload it.";
  }
  return action === "write" ? "The change could not be confirmed. Check the latest asset before trying again." : action === "file" ? "The file could not be checked. Try again." : "Assets could not be loaded. Check your connection and try again.";
}
