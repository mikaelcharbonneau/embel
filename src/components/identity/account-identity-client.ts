import { z } from "zod";
import { identityReferenceUploadSchema, identityReferenceUploadLookupSchema, type IdentityReferenceUpload } from "@/domain/identity-reference-uploads";
import { identityReferenceEntrySchema } from "@/domain/identity-references";
import { logoInputRequestSchema, logoInputRequestStateSchema, LOGO_REFERENCE_UPLOAD_MAX_BYTES } from "@/features/logo-inputs/model/contracts";
import { ASSET_MAX_FILE_BYTES } from "@/domain/asset-library";
import {
  IDENTITY_MUTATION_MAX_BYTES, getIdentityFreshness, identityBasisSchema, identityRefinementResponseSchema, identitySystemAssetSchema,
  identitySystemDetailSchema, identitySystemPageSchema, identitySystemVersionSchema, listIdentitySystemsSchema, projectIdentityOverviewSchema,
  refineIdentityComponentSchema, selectIdentitySystemResponseSchema, selectIdentitySystemSchema, updateIdentityPreferencesResponseSchema,
  updateIdentityPreferencesSchema, validateIdentityRefinement,
  type IdentitySystemAsset, type IdentitySystemVersion, type ListIdentitySystems, type ProjectIdentityOverview,
  type RefineIdentityComponent, type SelectIdentitySystem, type UpdateIdentityPreferences,
} from "@/domain/project-identity";
import { AccountRequestError } from "@/components/workspace/account-api";
import { identityBatchOverviewSchema, identityBatchRequestLookupSchema, identityBatchRequestCloseSchema, identityBatchStateSchema, identityGenerationIntentSchema, type IdentityBatchState, type IdentityGenerationIntent } from "@/domain/identity-jobs";
import type { VerifiedAccount } from "@/components/workspace/account-session";

export const IDENTITY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const observationSchema = z.strictObject({
  ownerId: z.uuid(), projectId: z.uuid(), projectRevision: counter.min(1), referenceRevision: counter, preferencesRevision: counter,
  identityRevision: counter, basis: identityBasisSchema, previousSelectionId: z.uuid().nullable(),
}).refine(value => value.ownerId === value.basis.ownerId && value.projectId === value.basis.projectId && (value.identityRevision === 0) === (value.previousSelectionId === null));
export type IdentityObservation = z.infer<typeof observationSchema>;
export function identityObservation(input: ProjectIdentityOverview): IdentityObservation {
  const overview = projectIdentityOverviewSchema.parse(input);
  if (overview.currentBasis.status !== "available") throw new AccountRequestError(409);
  return observationSchema.parse({ ownerId: overview.ownerId, projectId: overview.projectId, projectRevision: overview.project.current_revision,
    referenceRevision: overview.referenceSnapshot.referenceRevision, preferencesRevision: overview.preferences?.revision ?? 0,
    identityRevision: overview.session?.identityRevision ?? 0, basis: overview.currentBasis.basis, previousSelectionId: overview.currentSelection?.selection.id ?? null });
}
const downloadSchema = z.strictObject({
  url: z.url().max(8192).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }),
  versionId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string().min(1).max(150), expiresInSeconds: z.literal(60),
});
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const mimeBase = (value: string) => value.split(";", 1)[0]!.trim().toLowerCase();
const rasterMimes = new Set(["image/png", "image/jpeg", "image/webp"]);
function queryString(query: ListIdentitySystems): string {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", JSON.stringify(query.cursor));
  params.set("limit", String(query.limit)); return params.toString();
}
async function readBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maximum)) throw new AccountRequestError(502);
  const reader = response.body?.getReader(); if (!reader) throw new AccountRequestError(502);
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > maximum) throw new AccountRequestError(502);
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!total) throw new AccountRequestError(502);
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Fixed private routes. Every asynchronous boundary retains this account/project fence. */
export function createAccountIdentityClient(account: VerifiedAccount, inputProjectId: string, isCurrent: (account: VerifiedAccount) => boolean, expire: (account: VerifiedAccount) => void) {
  const projectId = z.uuid().parse(inputProjectId).toLowerCase(), ownerId = z.uuid().parse(account.userId).toLowerCase();
  const prefix = `/api/projects/${projectId}/identity`;
  let closed = false, previews = 0;
  const controllers = new Set<AbortController>(), urls = new Set<string>(), waiting = new Set<() => void>();
  const current = () => !closed && isCurrent(account);
  function controller(external?: AbortSignal) {
    const value = new AbortController(), abort = () => value.abort();
    if (external?.aborted) value.abort(); else external?.addEventListener("abort", abort, { once: true });
    controllers.add(value);
    return { value, release: () => { controllers.delete(value); external?.removeEventListener("abort", abort); } };
  }
  function dispose() {
    closed = true; controllers.forEach(value => value.abort()); controllers.clear();
    urls.forEach(url => URL.revokeObjectURL(url)); urls.clear();
    [...waiting].forEach(wake => wake());
  }
  function invalidate() { dispose(); expire(account); }
  function owned(value: { ownerId: string; projectId: string }): boolean {
    if (value.ownerId.toLowerCase() === ownerId && value.projectId.toLowerCase() === projectId) return true;
    invalidate(); return false;
  }
  async function request<T>(path: string, schema: z.ZodType<T>, verify: (value: T) => boolean, options: { method?: "GET" | "PATCH" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<T | null> {
    if (!current()) return null;
    const pending = controller(options.signal), signal = pending.value.signal;
    try {
      const multipart = options.body instanceof FormData;
      const body = multipart ? options.body as FormData : options.body === undefined ? undefined : JSON.stringify(options.body);
      if (typeof body === "string" && new TextEncoder().encode(body).byteLength > IDENTITY_MUTATION_MAX_BYTES) throw new AccountRequestError(413);
      const response = await fetch(path, { method: options.method ?? "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal,
        headers: { Accept: "application/json", ...(body === undefined || multipart ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body }) });
      if (!current() || signal.aborted) return null;
      if (response.status === 401) { invalidate(); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (mimeBase(response.headers.get("content-type") ?? "") !== "application/json") throw new AccountRequestError(502);
      const bytes = await readBytes(response, IDENTITY_JSON_MAX_BYTES, signal);
      if (!current() || signal.aborted) return null;
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new AccountRequestError(502); }
      const parsed = schema.safeParse(raw); if (!parsed.success) throw new AccountRequestError(502);
      const verified = verify(parsed.data);
      if (!current() || signal.aborted) return null;
      if (!verified) throw new AccountRequestError(502);
      return parsed.data;
    } catch (error) { if (!current() || signal.aborted) return null; throw error; }
    finally { pending.release(); }
  }
  function query(input: Partial<ListIdentitySystems>) {
    const parsed = listIdentitySystemsSchema.parse(input);
    if (parsed.cursor && parsed.cursor.projectId.toLowerCase() !== projectId) throw new AccountRequestError(422);
    return parsed;
  }
  function observed(input: IdentityObservation, intent: SelectIdentitySystem | RefineIdentityComponent) {
    const value = observationSchema.parse(input);
    if (!owned(value)) return null;
    if (intent.expectedProjectRevision !== value.projectRevision || intent.expectedReferenceRevision !== value.referenceRevision
      || intent.expectedPreferencesRevision !== value.preferencesRevision || intent.expectedIdentityRevision !== value.identityRevision) throw new AccountRequestError(409);
    return value;
  }
  function selectionReceipt(value: { projectRevision: number; referenceRevision: number; preferencesRevision: number; identityRevision: number; currentBasis: unknown; previousSelectionId: string | null }, observation: IdentityObservation) {
    return value.projectRevision === observation.projectRevision && value.referenceRevision === observation.referenceRevision && value.preferencesRevision === observation.preferencesRevision
      && value.identityRevision === observation.identityRevision + 1 && value.previousSelectionId === observation.previousSelectionId && same(value.currentBasis, observation.basis);
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
  return {
    current, dispose, activate: () => { closed = false; },
    async uploadReference(input: IdentityReferenceUpload, file: File | null, signal?: AbortSignal) {
      const parsed = identityReferenceUploadSchema.parse(input);
      let body: IdentityReferenceUpload | FormData = parsed;
      if (file) {
        if (!(file instanceof File) || file.size < 1 || file.size > LOGO_REFERENCE_UPLOAD_MAX_BYTES || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new AccountRequestError(422);
        body = new FormData(); body.set("input", JSON.stringify(parsed)); body.set("file", file);
      }
      return request(`${prefix}/references/uploads`, identityReferenceEntrySchema, entry => owned(entry.reference)
        && entry.reference.source === "user_supplied" && same(entry.reference.attribution, parsed.metadata.attribution)
        && same(entry.reference.relevantElements, parsed.metadata.relevantElements) && same(entry.reference.tags, parsed.metadata.tags), { method: "POST", body, signal });
    },
    async referenceUpload(requestKey: string, signal?: AbortSignal) {
      const key = z.uuid().parse(requestKey).toLowerCase();
      return request(`${prefix}/references/uploads/${key}`, identityReferenceUploadLookupSchema, value => value.status === "registered" ? owned(value.entry.reference)
        : value.upload.status === "not_found" || owned(value.upload) && value.upload.requestKey === key && value.upload.request.kind === "reference_upload", { signal });
    },
    async cancelReferenceUpload(input: IdentityReferenceUpload, file: File, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const original = identityReferenceUploadSchema.parse(input);
      if (!(file instanceof File) || file.size < 1 || file.size > LOGO_REFERENCE_UPLOAD_MAX_BYTES) throw new AccountRequestError(422);
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      if (!current() || signal?.aborted) return null;
      const contentHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      const body = logoInputRequestSchema.parse({ kind: "reference_upload", input: original.upload, file: { contentHash, byteLength: file.size, mimeType: file.type } });
      return request(`/api/projects/${projectId}/logo/inputs/requests/${original.upload.requestKey}/cancel`, logoInputRequestStateSchema,
        value => value.status !== "not_found" && owned(value) && value.requestKey === original.upload.requestKey && same(value.request, body), { method: "POST", body, signal });
    },
    async generation(signal?: AbortSignal) {
      return request(`${prefix}/batches`, identityBatchOverviewSchema, owned, { signal });
    },
    async batch(batchId: string, signal?: AbortSignal) {
      const id = z.uuid().parse(batchId).toLowerCase();
      return request(`${prefix}/batches/${id}`, identityBatchStateSchema, value => owned(value) && value.batchId === id, { signal });
    },
    async batchRequest(requestKey: string, signal?: AbortSignal) {
      const key = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(requestKey);
      return request(`${prefix}/batches/requests/${encodeURIComponent(key)}`, identityBatchRequestLookupSchema,
        value => value.status === "not_found" || owned(value.batch) && value.batch.intent.idempotencyKey === key, { signal });
    },
    async closeBatchRequest(input: IdentityGenerationIntent, signal?: AbortSignal) {
      const original = identityGenerationIntentSchema.parse(input);
      if (!("version" in original) || original.version !== 2) throw new AccountRequestError(422);
      return request(`${prefix}/batches/requests/${encodeURIComponent(original.idempotencyKey)}/cancel`, identityBatchRequestCloseSchema,
        value => value.status === "not_admitted" ? owned(value) && same(value.intent, original) : owned(value.batch) && same(value.batch.intent, original), { method: "POST", body: original, signal });
    },
    async generate(input: IdentityGenerationIntent, signal?: AbortSignal) {
      const body = identityGenerationIntentSchema.parse(input);
      if (!("version" in body) || body.version !== 2) throw new AccountRequestError(422);
      return request(`${prefix}/batches`, identityBatchStateSchema, value => owned(value) && same(value.intent, body)
        && value.input.projectRevision === body.expectedProjectRevision && value.input.referenceSnapshot.referenceRevision === body.expectedReferenceRevision
        && value.input.preferencesRevision === body.expectedPreferencesRevision, { method: "POST", body, signal });
    },
    async stopBatch(input: IdentityBatchState, signal?: AbortSignal) {
      const batch = identityBatchStateSchema.parse(input);
      if (!owned(batch)) return null;
      return request(`${prefix}/batches/${batch.batchId}/cancel`, identityBatchStateSchema, value => owned(value) && value.batchId === batch.batchId
        && value.jobId === batch.jobId && same(value.intent, batch.intent) && same(value.input, batch.input), { method: "POST", body: {}, signal });
    },
    async overview(input: Partial<ListIdentitySystems> = {}, signal?: AbortSignal) {
      const parsed = query(input);
      return request(`${prefix}?${queryString(parsed)}`, projectIdentityOverviewSchema, value => owned(value) && same(value.systems.query, parsed), { signal });
    },
    async history(input: Partial<ListIdentitySystems> = {}, signal?: AbortSignal) {
      const parsed = query(input);
      return request(`${prefix}/systems?${queryString(parsed)}`, identitySystemPageSchema, value => owned(value) && same(value.query, parsed), { signal });
    },
    async detail(systemVersionId: string, signal?: AbortSignal) {
      const id = z.uuid().parse(systemVersionId).toLowerCase();
      return request(`${prefix}/systems/${id}`, identitySystemDetailSchema, value => owned(value) && value.system.id.toLowerCase() === id, { signal });
    },
    async preferences(input: UpdateIdentityPreferences) {
      const body = updateIdentityPreferencesSchema.parse(input);
      return request(`${prefix}/preferences`, updateIdentityPreferencesResponseSchema, value => owned(value.session) && value.preferences.revision === body.expectedPreferencesRevision + 1 && same(value.preferences.preferences, body.preferences), { method: "PATCH", body });
    },
    async select(input: SelectIdentitySystem, observation: IdentityObservation, original: IdentitySystemVersion) {
      const body = selectIdentitySystemSchema.parse(input), captured = observed(observation, body), system = identitySystemVersionSchema.parse(original);
      if (!captured || !owned(system)) return null;
      if (system.id !== body.systemVersionId || (!body.acceptEarlierBasis && !same(system.input.basis, captured.basis))) throw new AccountRequestError(409);
      return request(`${prefix}/selection`, selectIdentitySystemResponseSchema, value => owned(value.session) && same(value.currentSelection.system, system)
        && selectionReceipt(value.currentSelection.selection, captured) && value.currentSelection.selection.reason !== "refined", { method: "POST", body });
    },
    async refine(input: RefineIdentityComponent, observation: IdentityObservation, original: IdentitySystemVersion) {
      const body = refineIdentityComponentSchema.parse(input), captured = observed(observation, body), base = identitySystemVersionSchema.parse(original);
      if (!captured || !owned(base)) return null;
      if (base.id !== body.baseSystemVersionId || (!body.acceptEarlierBasis && !same(base.input.basis, captured.basis))) throw new AccountRequestError(409);
      return request(`${prefix}/refinements`, identityRefinementResponseSchema, value => {
        if (!owned(value.system) || !selectionReceipt(value.selection, captured) || value.change.component !== body.component || !same(value.change.after, body.input)) return false;
        try { validateIdentityRefinement({ base, ...value }); return true; } catch { return false; }
      }, { method: "POST", body });
    },
    async preview(input: IdentitySystemAsset, external?: AbortSignal) {
      if (!current()) return null;
      const asset = identitySystemAssetSchema.parse(input); if (!owned(asset)) return null;
      const mimeType = mimeBase(asset.mimeType); if (!rasterMimes.has(mimeType)) throw new AccountRequestError(422);
      const pending = controller(external), signal = pending.value.signal; let acquired = false;
      try {
        acquired = await acquire(signal); if (!acquired) return null;
        const response = await fetch(`/api/assets/${asset.versionId}/preview`, { credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal, headers: { Accept: mimeType } });
        if (!current() || signal.aborted) return null;
        if (response.status === 401) { invalidate(); return null; }
        if (!response.ok) throw new AccountRequestError(response.status);
        if (mimeBase(response.headers.get("content-type") ?? "") !== mimeType) throw new AccountRequestError(502);
        const bytes = await readBytes(response, ASSET_MAX_FILE_BYTES, signal); if (!current() || signal.aborted) return null;
        const digest = await crypto.subtle.digest("SHA-256", bytes); if (!current() || signal.aborted) return null;
        const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (hash !== asset.contentHash) throw new AccountRequestError(502);
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType })); urls.add(url);
        return { url, release: () => { if (urls.delete(url)) URL.revokeObjectURL(url); } };
      } catch (error) { if (!current() || signal.aborted) return null; throw error; }
      finally { pending.release(); if (acquired) { previews -= 1; [...waiting].forEach(wake => wake()); } }
    },
    async download(input: IdentitySystemAsset) {
      if (!current()) return null;
      const asset = identitySystemAssetSchema.parse(input); if (!owned(asset)) return null;
      return request(`/api/assets/${asset.versionId}/download`, downloadSchema, value => value.versionId === asset.versionId && value.contentHash === asset.contentHash && mimeBase(value.mimeType) === mimeBase(asset.mimeType));
    },
  };
}
export type AccountIdentityClient = ReturnType<typeof createAccountIdentityClient>;
export function identityErrorMessage(error: unknown, action: "read" | "write" | "file" = "read"): string {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "Saved inputs changed. Check the latest before trying again. Your edits remain in this tab.";
    if (error.status === 404) return action === "file" ? "This file is unavailable. Its saved system remains in history." : "This system is unavailable to this account.";
    if (error.status === 422) return "Check the entered values before saving.";
    if (error.status === 503) return action === "file" ? "Private files are unavailable right now." : "Saved Identity data is unavailable right now.";
    if (error.status === 502) return "The response could not be verified. Check again before continuing.";
  }
  return action === "write" ? "The change could not be confirmed. Your edit and original request remain available for recovery."
    : action === "file" ? "This file could not be checked. Try again." : "Identity systems could not be loaded. Check your connection and try again.";
}

export function identitySystemFreshness(system: IdentitySystemVersion, overview: ProjectIdentityOverview) {
  return getIdentityFreshness(system.input.basis, overview.currentBasis);
}
