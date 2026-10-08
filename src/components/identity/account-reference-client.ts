import { z } from "zod";
import { ASSET_MAX_FILE_BYTES } from "@/domain/asset-library";
import { identityReferenceEntrySchema, identityReferenceMediaSchema, identityReferenceQuerySchema, identityReferencesOverviewSchema, setReferenceReactionResponseSchema, setReferenceReactionSchema, type IdentityReferenceEntry, type IdentityReferenceQuery, type SetReferenceReaction } from "@/domain/identity-references";
import { accountProjectSchema, PROJECT_MUTATION_MAX_BYTES } from "@/domain/project-api";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const projectResponse = z.strictObject({ project: accountProjectSchema.strict() });
const mimeBase = (value: string) => value.split(";", 1)[0]!.trim().toLowerCase();
async function boundedBytes(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const size = response.headers.get("content-length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > max)) throw new AccountRequestError(502);
  const reader = response.body?.getReader(); if (!reader) throw new AccountRequestError(502);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength; if (length > max) throw new AccountRequestError(502); chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!length) throw new AccountRequestError(502);
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** References carry a real media pointer, never invented asset-detail provenance. */
export function createAccountReferenceClient(account: VerifiedAccount, routeProjectId: string, isCurrent: (account: VerifiedAccount) => boolean, expire: (account: VerifiedAccount) => void) {
  const projectId = z.uuid().parse(routeProjectId).toLowerCase(), ownerId = account.userId.toLowerCase();
  const base = `/api/projects/${projectId}`, references = `${base}/identity/references`;
  let closed = false, activePreviews = 0;
  const controllers = new Set<AbortController>(), urls = new Set<string>(), waiting = new Set<() => void>();
  const current = () => !closed && isCurrent(account);
  const owned = (value: { ownerId: string; projectId: string }) => value.ownerId === ownerId && value.projectId === projectId;
  function controller(external?: AbortSignal) {
    const value = new AbortController(), abort = () => value.abort();
    if (external?.aborted) value.abort(); else external?.addEventListener("abort", abort, { once: true }); controllers.add(value);
    return { value, release: () => { controllers.delete(value); external?.removeEventListener("abort", abort); } };
  }
  function dispose() { closed = true; controllers.forEach(value => value.abort()); controllers.clear(); urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); }
  function invalidate() { dispose(); expire(account); }
  async function request<T>(path: string, schema: z.ZodType<T>, verify: (value: T) => boolean, options: { method?: "GET" | "PATCH"; body?: unknown; signal?: AbortSignal } = {}): Promise<T | null> {
    if (!current()) return null;
    if (path !== base && path !== references && !path.startsWith(`${references}?`) && !new RegExp(`^${references}/[a-f0-9-]{36}$`).test(path)) throw new AccountRequestError(422);
    const pending = controller(options.signal), signal = pending.value.signal;
    try {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (body && new TextEncoder().encode(body).byteLength > PROJECT_MUTATION_MAX_BYTES) throw new AccountRequestError(413);
      const response = await fetch(path, { method: options.method ?? "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body } : {}) });
      if (!current() || signal.aborted) return null;
      if (response.status === 401) { invalidate(); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (mimeBase(response.headers.get("content-type") ?? "") !== "application/json") throw new AccountRequestError(502);
      const bytes = await boundedBytes(response, 16 * 1024 * 1024, signal);
      if (!current() || signal.aborted) return null;
      let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AccountRequestError(502); }
      const parsed = schema.safeParse(value); if (!parsed.success) throw new AccountRequestError(502);
      if (!verify(parsed.data)) { invalidate(); return null; } return parsed.data;
    } catch (error) { if (!current() || signal.aborted) return null; throw error; }
    finally { pending.release(); }
  }
  function list(input: Partial<IdentityReferenceQuery> = {}, signal?: AbortSignal) {
    const query = identityReferenceQuerySchema.parse(input);
    if (query.cursor && query.cursor.projectId !== projectId) throw new AccountRequestError(422);
    const params = new URLSearchParams({ limit: String(query.limit) });
    query.excludedTags.forEach(tag => params.append("excludedTag", tag));
    if (query.cursor) params.set("cursor", JSON.stringify(query.cursor));
    if (new TextEncoder().encode(`?${params}`).byteLength > 32_768) throw new AccountRequestError(413);
    return request(`${references}?${params}`, identityReferencesOverviewSchema, value => owned(value) && JSON.stringify(value.query) === JSON.stringify(query), { signal });
  }
  function react(inputEntry: IdentityReferenceEntry, input: SetReferenceReaction) {
    const entry = identityReferenceEntrySchema.parse(inputEntry), body = setReferenceReactionSchema.parse(input);
    if (!owned(entry.reference) || body.elements.some(element => !entry.reference.relevantElements.includes(element))) throw new AccountRequestError(422);
    return request(`${references}/${entry.reference.id}`, setReferenceReactionResponseSchema, value => owned(value) && value.entry.reference.id === entry.reference.id && JSON.stringify(value.entry.reference) === JSON.stringify(entry.reference) && value.entry.reaction.revision === body.expectedRevision + 1 && value.entry.reaction.ensemble === body.ensemble && JSON.stringify(value.entry.reaction.elements) === JSON.stringify(body.elements), { method: "PATCH", body });
  }
  async function acquire(signal: AbortSignal) {
    while (activePreviews >= 3 && current() && !signal.aborted) await new Promise<void>(resolve => { const wake = () => { waiting.delete(wake); signal.removeEventListener("abort", wake); resolve(); }; waiting.add(wake); signal.addEventListener("abort", wake, { once: true }); });
    if (!current() || signal.aborted) return false; activePreviews += 1; return true;
  }
  async function preview(input: unknown, external?: AbortSignal) {
    if (!current()) return null;
    const media = identityReferenceMediaSchema.parse(input);
    if (!owned(media)) throw new AccountRequestError(422);
    const pending = controller(external), signal = pending.value.signal; let acquired = false;
    try {
      acquired = await acquire(signal); if (!acquired) return null;
      const response = await fetch(`/api/assets/${media.versionId}/preview`, { credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal, headers: { Accept: media.mimeType } });
      if (!current() || signal.aborted) return null;
      if (response.status === 401) { invalidate(); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (mimeBase(response.headers.get("content-type") ?? "") !== media.mimeType) throw new AccountRequestError(502);
      const bytes = await boundedBytes(response, ASSET_MAX_FILE_BYTES, signal);
      if (!current() || signal.aborted) return null;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      if (!current() || signal.aborted) return null;
      if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") !== media.contentHash) throw new AccountRequestError(502);
      const url = URL.createObjectURL(new Blob([bytes], { type: media.mimeType })); urls.add(url);
      return { url, release: () => { URL.revokeObjectURL(url); urls.delete(url); } };
    } catch (error) { if (!current() || signal.aborted) return null; throw error; }
    finally { pending.release(); if (acquired) { activePreviews -= 1; [...waiting].forEach(wake => wake()); } }
  }
  return { current, request, list, react, preview, dispose, activate: () => { closed = false; }, getProject: (signal?: AbortSignal) => request(base, projectResponse, value => value.project.owner_id === ownerId && value.project.id === projectId, { signal }) };
}
export type AccountReferenceClient = ReturnType<typeof createAccountReferenceClient>;
export function referenceErrorMessage(error: unknown, write = false) {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "This reference changed in another tab. Check its latest choices before saving yours.";
    if (error.status === 404) return "This reference or project is not available to this account.";
    if (error.status === 413 || error.status === 431) return "This filter request is too large. Remove an excluded tag and try again. Your saved choices are preserved.";
    if (error.status === 503) return "Account references are unavailable right now.";
    if (error.status === 502) return "The reference response could not be verified. Check again to reload it.";
    if (error.status === 422 && write) return "These choices could not be saved. Check the latest reference and its selection limits.";
  }
  return write ? "Your choices could not be confirmed. Check the latest reference before trying again." : "References could not be loaded. Check your connection and try again.";
}
