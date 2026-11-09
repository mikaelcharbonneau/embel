import { z } from "zod";
import { isSignedDownloadUrl } from "@/domain/signed-download-url";
import { logoVectorProposalPageSchema, logoVectorProposalRecordSchema } from "@/domain/logo-vector-proposal-jobs";
import { logoVectorProposalRequestStateSchema, logoVectorProposalRequestCloseSchema, logoVectorProposalRequestPageSchema } from "@/features/logo-vector/model/proposal-session";
import * as W from "@/domain/logo-workspace";
import * as J from "@/domain/logo-jobs";
import { logoCapabilitiesSchema } from "@/domain/logo-capabilities";
import { logoSavedInputsSchema, LOGO_SAVED_INPUTS_MAX_BYTES } from "@/domain/logo-saved-inputs";
import * as D from "@/domain/logo-deliverables";
import * as V from "@/domain/logo-vector";
import * as Directions from "@/domain/logo-directions";
import { ASSET_MAX_FILE_BYTES, type AssetVersionReference } from "@/domain/asset-library";
import { accountProjectResponseSchema } from "@/domain/project-api";
import type { ContextSnapshot } from "@/domain/projects";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { verifyLogoVectorDetailHashes } from "@/features/logo-vector/client/verify-detail";
import { logoVectorEditCommandSchema, logoVectorEditRequestStateSchema, sameLogoVectorEditCommand, type LogoVectorEditCommand } from "@/features/logo-vector/model/cancellation";
import * as VectorHistory from "@/features/logo-vector/model/history";
import { initializeExistingBrandLogoInputSchema, isExistingBrandLogoReceipt, serializeLogoInitialization, logoInitializationRejectionSchema, type LogoInitializationRejection, type InitializeExistingBrandLogoInput } from "@/features/logo-creation/model/existing-brand";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mime = (value: string | null) => (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
const rasters = new Set(["image/png", "image/jpeg", "image/webp"]);
const pageBytes = 1_638_400;
const clientBindings = new WeakMap<object, { ownerId: string; projectId: string; generation: number; current(): boolean }>();
type PageQuery = { cursor?: string; limit?: number };
type Preview = { url: string; release(): void };
type FontImport = { requestKey: string; expected: W.LogoExpectedHeads; catalogFontId: string };
type FontUpload = { requestKey: string; expected: W.LogoExpectedHeads; licenseSourceUrl: string | null; licenseText: string; rightsDeclaration: string; file: File };
const assetDownloadSchema = z.strictObject({
  url: z.url().max(8192).refine(isSignedDownloadUrl),
  versionId: V.logoUuidSchema, contentHash: V.logoHashSchema, mimeType: z.string().min(1).max(150), expiresInSeconds: z.literal(60),
});
type AssetDownload = z.infer<typeof assetDownloadSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown, maxBytes?: number): T {
  if (maxBytes !== undefined) {
    let size: number;
    try { size = V.logoJsonBytes(value); } catch { throw new AccountRequestError(422); }
    if (size > maxBytes) throw new AccountRequestError(413);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new AccountRequestError(422);
  return result.data;
}
async function readBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maximum)) throw new AccountRequestError(502);
  const reader = response.body?.getReader();
  if (!reader) throw new AccountRequestError(502);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new AccountRequestError(502);
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!length) throw new AccountRequestError(502);
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

const admissionRejectionEnvelopeSchema = z.strictObject({
  error: z.strictObject({ code: z.enum(["conflict", "not_found"]), message: z.string().max(1000) }),
  rejection: z.strictObject({ status: z.literal("rejected"), ownerId: V.logoUuidSchema, projectId: V.logoUuidSchema, requestKey: V.logoUuidSchema, quoteId: V.logoUuidSchema }),
});
/** Only an exact authenticated durable rejection envelope can produce this error.
 * A generic status code, missing request read or transport failure cannot. */
export class AccountLogoAdmissionRejectedError extends AccountRequestError {
  constructor(status: 409 | 404, readonly rejection: z.infer<typeof admissionRejectionEnvelopeSchema>["rejection"]) {
    super(status); this.name = "AccountLogoAdmissionRejectedError";
  }
}
async function admissionRejection(response: Response, signal: AbortSignal, binding: { ownerId: string; projectId: string }, intent: J.LogoGenerationIntent): Promise<AccountLogoAdmissionRejectedError | null> {
  if (![409, 404].includes(response.status) || mime(response.headers.get("content-type")) !== "application/json") return null;
  try {
    const bytes = await readBytes(response, 4096, signal);
    const parsed = admissionRejectionEnvelopeSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!parsed.success || parsed.data.error.code !== (response.status === 409 ? "conflict" : "not_found")) return null;
    const proof = parsed.data.rejection;
    if (proof.ownerId !== binding.ownerId || proof.projectId !== binding.projectId || proof.requestKey !== intent.requestKey || proof.quoteId !== intent.quoteId) return null;
    return new AccountLogoAdmissionRejectedError(response.status as 409 | 404, proof);
  } catch { return null; }
}

export class AccountLogoInitializationRejectedError extends AccountRequestError {
  constructor(readonly rejection: LogoInitializationRejection) { super(409); this.name = "AccountLogoInitializationRejectedError"; }
}
const initializationRejectionEnvelopeSchema = z.strictObject({
  error: z.strictObject({ code: z.literal("conflict"), message: z.string().max(1000) }), rejection: logoInitializationRejectionSchema,
});
async function initializationRejection(response: Response, signal: AbortSignal, binding: { ownerId: string; projectId: string }, input: InitializeExistingBrandLogoInput): Promise<AccountLogoInitializationRejectedError | null> {
  if (response.status !== 409 || mime(response.headers.get("content-type")) !== "application/json") return null;
  try {
    const bytes = await readBytes(response, 4096, signal);
    const result = initializationRejectionEnvelopeSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!result.success) return null;
    const proof = result.data.rejection;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializeLogoInitialization(input)));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (proof.ownerId !== binding.ownerId || proof.projectId !== binding.projectId || proof.requestKey !== input.requestKey || proof.inputHash !== hash) return null;
    return new AccountLogoInitializationRejectedError(proof);
  } catch { return null; }
}

const exportRejectionEnvelopeSchema = z.strictObject({ error: z.strictObject({ code: z.literal("conflict"), message: z.string().max(1000) }), rejection: D.logoExportRejectionSchema });
export class AccountLogoExportAdmissionRejectedError extends AccountRequestError {
  constructor(readonly rejection: D.LogoExportRejection) { super(409); this.name = "AccountLogoExportAdmissionRejectedError"; }
}
async function exportAdmissionRejection(response: Response, signal: AbortSignal, binding: { ownerId: string; projectId: string }, input: D.LogoExportIntent): Promise<AccountLogoExportAdmissionRejectedError | null> {
  if (response.status !== 409 || mime(response.headers.get("content-type")) !== "application/json") return null;
  try {
    const bytes = await readBytes(response, 65_536, signal);
    const result = exportRejectionEnvelopeSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!result.success || !D.matchesLogoExportRejection(result.data.rejection, binding.ownerId, binding.projectId, input)) return null;
    return new AccountLogoExportAdmissionRejectedError(result.data.rejection);
  } catch { return null; }
}

/** Fixed same-origin routes; availability comes only from actual API responses. */
export function createAccountLogoClient(
  account: VerifiedAccount, projectId: string, isCurrent: (account: VerifiedAccount) => boolean,
  expire: (account: VerifiedAccount) => void, fetcher: typeof fetch = fetch,
) {
  const captured = Object.freeze({ ...account });
  const binding = Object.freeze({ ownerId: parse(V.logoUuidSchema, captured.userId), generation: parse(V.logoCounterSchema, captured.generation), projectId: parse(V.logoUuidSchema, projectId) });
  let closed = false, workspaceRevision: number | null = null, activePreviews = 0;
  const controllers = new Set<AbortController>(), urls = new Set<string>(), waiters = new Set<() => void>();
  const current = () => !closed && isCurrent(captured);
  const owner = (value: { ownerId: string }) => value.ownerId === binding.ownerId;
  const owned = (value: { ownerId: string; projectId: string }) => owner(value) && value.projectId === binding.projectId;
  const project = () => `/api/projects/${binding.projectId}/logo`;
  function controller(external?: AbortSignal) {
    const value = new AbortController(), abort = () => value.abort();
    if (external?.aborted) value.abort(); else external?.addEventListener("abort", abort, { once: true });
    controllers.add(value);
    return { value, release() { controllers.delete(value); external?.removeEventListener("abort", abort); } };
  }
  function dispose() {
    closed = true; controllers.forEach(value => value.abort()); controllers.clear();
    urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); [...waiters].forEach(wake => wake());
  }
  function unauthorized() { if (!current()) return; dispose(); expire(captured); }
  async function request<T>(path: string, schema: z.ZodType<T>, verify: (value: T) => boolean, options: { method?: "GET" | "PUT" | "POST"; body?: unknown; form?: FormData; signal?: AbortSignal; maximum?: number; admission?: J.LogoGenerationIntent; initialization?: InitializeExistingBrandLogoInput; exportAdmission?: D.LogoExportIntent } = {}): Promise<T | null> {
    if (!current() || options.signal?.aborted) return null;
    const pending = controller(options.signal), signal = pending.value.signal;
    try {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const response = await fetcher(path, { method: options.method ?? "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.method && options.method !== "GET" ? { "X-Embel-Account": binding.ownerId } : {}) },
        ...(options.form ? { body: options.form } : body === undefined ? {} : { body }) });
      if (!current() || signal.aborted) return null;
      if (response.status === 401) { unauthorized(); return null; }
      if (!response.ok) {
        const rejection = options.admission ? await admissionRejection(response, signal, binding, options.admission)
          : options.initialization ? await initializationRejection(response, signal, binding, options.initialization)
          : options.exportAdmission ? await exportAdmissionRejection(response, signal, binding, options.exportAdmission) : null;
        if (!current() || signal.aborted) return null;
        throw rejection ?? new AccountRequestError(response.status);
      }
      if (mime(response.headers.get("content-type")) !== "application/json") throw new AccountRequestError(502);
      const bytes = await readBytes(response, options.maximum ?? W.LOGO_MUTATION_MAX_BYTES, signal);
      if (!current() || signal.aborted) return null;
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new AccountRequestError(502); }
      const parsed = schema.safeParse(raw);
      if (!parsed.success || !verify(parsed.data)) throw new AccountRequestError(502);
      if (!current() || signal.aborted) return null;
      return parsed.data;
    } catch (error) {
      if (!current() || signal.aborted) return null;
      throw error instanceof AccountRequestError ? error : new AccountRequestError(503);
    } finally { pending.release(); }
  }
  function query(input: PageQuery = {}) {
    const parsed = parse(W.logoPageQuerySchema, input), result = new URLSearchParams({ limit: String(parsed.limit) });
    if (parsed.cursor) result.set("cursor", parsed.cursor);
    return result;
  }
  function stateOwned(value: J.LogoRequestState, requestKey: string) {
    return value.status === "not_found" || value.requestKey === requestKey && (!value.receipt || owned(value.receipt)) && (!value.rejection || owned(value.rejection) && value.rejection.requestKey === requestKey && value.rejection.input.requestKey === requestKey) && value.outputs.every(output => owned(output.reference));
  }
  function mutation<I extends { requestKey: string; expected: W.LogoExpectedHeads }>(schema: z.ZodType<I>, path: string, verify?: (receipt: W.LogoMutationReceipt, body: I) => boolean, method: "POST" | "PUT" = "POST") {
    return async (input: I, signal?: AbortSignal): Promise<W.LogoMutationReceipt | null> => {
      if (!current() || signal?.aborted) return null;
      const body = parse(schema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}${path}`, W.logoMutationReceiptSchema, value => owned(value) && value.requestKey === body.requestKey
        && value.revision.revision === body.expected.stageRevisions[value.revision.stage] + 1 && (!verify || verify(value, body)), { method, body, signal, maximum: 65_536 });
    };
  }
  async function unavailable<T>(signal?: AbortSignal): Promise<T | null> {
    if (!current() || signal?.aborted) return null;
    throw new AccountRequestError(503);
  }
  async function download(reference: AssetVersionReference, expectedMime: string, signal?: AbortSignal): Promise<AssetDownload | null> {
    if (!current() || signal?.aborted) return null;
    if (!owned(reference)) throw new AccountRequestError(404);
    return request(`/api/assets/${reference.versionId}/download`, assetDownloadSchema,
      value => value.versionId === reference.versionId && value.contentHash === reference.contentHash && value.mimeType === expectedMime,
      { signal, maximum: 16_384 });
  }
  async function readVectorDetail(vectorRevisionId: string, signal?: AbortSignal): Promise<D.LogoVectorDetail | null> {
    if (!current() || signal?.aborted) return null;
    const id = parse(V.logoUuidSchema, vectorRevisionId);
    const detail = await request(`${project()}/vector/revisions/${id}`, D.logoVectorDetailSchema, value => owned(value.revision) && value.revision.id === id, { signal, maximum: 8_421_376 });
    if (!detail || !current() || signal?.aborted) return null;
    try {
      const document = await verifyLogoVectorDetailHashes(detail, () => current() && !signal?.aborted);
      return document && current() && !signal?.aborted ? { ...detail, document } : null;
    } catch { if (!current() || signal?.aborted) return null; throw new AccountRequestError(502); }
  }
  async function preview(reference: AssetVersionReference, expectedMime: string | null, expectedLength: number | null, signal?: AbortSignal): Promise<Preview | null> {
    if (!current() || signal?.aborted) return null;
    if (!owned(reference) || expectedMime !== null && !rasters.has(expectedMime)) throw new AccountRequestError(422);
    const pending = controller(signal), abort = pending.value.signal; let acquired = false;
    try {
      while (activePreviews >= 3 && current() && !abort.aborted) await new Promise<void>(resolve => {
        const wake = () => { waiters.delete(wake); abort.removeEventListener("abort", wake); resolve(); };
        waiters.add(wake); abort.addEventListener("abort", wake, { once: true });
      });
      if (!current() || abort.aborted) return null;
      activePreviews++; acquired = true;
      const response = await fetcher(`/api/assets/${reference.versionId}/preview`, { credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: abort, headers: { Accept: expectedMime ?? "image/png,image/jpeg,image/webp" } });
      if (!current() || abort.aborted) return null;
      if (response.status === 401) { unauthorized(); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      const mediaType = mime(response.headers.get("content-type"));
      if (!rasters.has(mediaType) || expectedMime !== null && mediaType !== expectedMime) throw new AccountRequestError(502);
      const bytes = await readBytes(response, ASSET_MAX_FILE_BYTES, abort);
      if (expectedLength !== null && bytes.byteLength !== expectedLength) throw new AccountRequestError(502);
      if (!current() || abort.aborted) return null;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      if (!current() || abort.aborted) return null;
      if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") !== reference.contentHash) throw new AccountRequestError(502);
      const url = URL.createObjectURL(new Blob([bytes], { type: mediaType })); urls.add(url);
      return { url, release() { if (urls.delete(url)) URL.revokeObjectURL(url); } };
    } catch (error) { if (!current() || abort.aborted) return null; throw error instanceof AccountRequestError ? error : new AccountRequestError(503); }
    finally { pending.release(); if (acquired) { activePreviews--; [...waiters].forEach(wake => wake()); } }
  }
  const client = {
    dispose,
    async getLogoCapabilities(signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      return request(`${project()}/capabilities`, logoCapabilitiesSchema, owned, { signal });
    },
    async getLogoWorkspace(signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const value = await request(project(), W.logoWorkspaceV2Schema, owned, { signal });
      if (value) workspaceRevision = value.heads.projectRevision;
      return value;
    },
    async readLogoSavedInputs(signal?: AbortSignal) {
      return request(`${project()}/saved-inputs`, logoSavedInputsSchema, owned, { signal, maximum: LOGO_SAVED_INPUTS_MAX_BYTES });
    },
    async readStrategyContext(signal?: AbortSignal): Promise<{ ownerId: string; projectId: string; revision: number; context: ContextSnapshot } | null> {
      if (!current() || signal?.aborted) return null;
      const capturedRevision = workspaceRevision;
      const value = await request(`/api/projects/${binding.projectId}`, accountProjectResponseSchema, result => result.project.owner_id === binding.ownerId && result.project.id === binding.projectId, { signal, maximum: 1_048_576 });
      if (!value || !current() || signal?.aborted || workspaceRevision !== capturedRevision) return null;
      if (capturedRevision !== null && value.project.current_revision !== capturedRevision) throw new AccountRequestError(409);
      return { ownerId: value.project.owner_id, projectId: value.project.id, revision: value.project.current_revision, context: value.project.context };
    },
    async getLogoStageRevision(stage: W.LogoStage, revisionId: string, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const selected = parse(W.logoStageSchema, stage), id = parse(V.logoUuidSchema, revisionId);
      return request(`${project()}/stages/${selected}/revisions/${id}`, W.logoStageRevisionSchema, value => owned(value) && value.stage === selected && value.id === id, { signal });
    },
    async listLogoStageHistory(stage: W.LogoStage, input: { cursor?: W.LogoHistoryCursor; limit?: number } = {}, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const selected = parse(W.logoStageSchema, stage), body = parse(z.strictObject({ cursor: W.logoHistoryCursorSchema.optional(), limit: z.number().int().min(1).max(50).default(20) }), input);
      if (body.cursor && body.cursor.stage !== selected) throw new AccountRequestError(422);
      const params = new URLSearchParams({ limit: String(body.limit) }); if (body.cursor) params.set("cursor", JSON.stringify(body.cursor));
      return request(`${project()}/stages/${selected}/history?${params}`, W.logoHistoryPageSchema, value => owned(value) && value.items.every(item => item.stage === selected) && (!value.nextCursor || value.nextCursor.stage === selected), { signal, maximum: pageBytes });
    },
    async listLogoConceptBatches(input: PageQuery = {}, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      return request(`${project()}/batches?${query(input)}`, J.logoConceptBatchPageSchema, owned, { signal, maximum: 16384 });
    },
    async readLogoConceptBatch(batchId: string, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const id = parse(V.logoUuidSchema, batchId);
      return request(`${project()}/batches/${id}`, J.logoConceptBatchSchema, value => owned(value) && value.id === id, { signal, maximum: 1_048_576 });
    },
    async readLogoRasterRefinement(rasterRevisionId: string, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const id = parse(V.logoUuidSchema, rasterRevisionId);
      return request(`${project()}/raster-refinements/${id}`, J.logoRasterRefinementSchema, value => owned(value) && value.id === id, { signal });
    },
    async listLogoRasterRefinements(input: PageQuery = {}, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      return request(`${project()}/raster-refinements?${query(input)}`, J.logoRasterRefinementPageSchema, owned, { signal, maximum: pageBytes });
    },
    async initializeExistingBrandLogo(input: InitializeExistingBrandLogoInput, signal?: AbortSignal): Promise<W.LogoMutationReceipt | null> {
      if (!current() || signal?.aborted) return null;
      const body = parse(initializeExistingBrandLogoInputSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/initialize`, W.logoMutationReceiptSchema, value => owned(value) && isExistingBrandLogoReceipt(value, body),
        { method: "POST", body, signal, maximum: 65_536, initialization: body });
    },
    saveLogoBrief: mutation(W.saveLogoBriefInputSchema, "/brief", (value, body) => {
      if (value.revision.stage !== "brief_references") return false;
      const { name, activity, audience, personality, logoTypes } = value.revision.payload;
      return same({ name, activity, audience, personality, logoTypes }, body.brief);
    }, "PUT"),
    saveLogoReferences: mutation(W.saveLogoReferencesInputSchema, "/references", value => value.revision.stage === "brief_references", "PUT"),
    selectLogoConcept: mutation(W.selectLogoConceptInputSchema, "/concepts/selection", (value, body) => value.revision.stage === "concepts" && same(value.revision.payload.selected, { kind: "concept", batchId: body.batchId, slotId: body.slotId, attemptId: body.attemptId })),
    selectLogoRaster: mutation(W.selectLogoRasterInputSchema, "/rasters/selection", (value, body) => value.revision.stage === "concepts" && same(value.revision.payload.selected, body.source)),
    saveLogoEdit: mutation(W.saveLogoEditInputSchema, "/edits"),
    acceptLogoVector: mutation(W.acceptLogoVectorInputSchema, "/vector/accept", (value, body) => value.workspace.approvedLogo?.vectorRevisionId === body.vectorRevisionId),
    restoreLogoStage: mutation(W.restoreLogoStageInputSchema, "/restore", (value, body) => value.revision.stage === body.stage),
    selectIdentityDirectionComponents: mutation(W.selectIdentityDirectionComponentsInputSchema, "/directions/selection", value => value.revision.stage === "directions"),
    approveIdentityDirection: mutation(W.approveIdentityDirectionInputSchema, "/directions/approval", (value, body) => value.revision.stage === "directions" && value.revision.payload.selectionId === body.directionSelectionId && value.revision.payload.approvalId !== null),
    reviewLogoVariants: mutation(W.reviewLogoVariantsInputSchema, "/variants/review", (value, body) => value.revision.stage === "deliverables" && value.revision.payload.variantSetId === body.variantSetId),
    async listPendingVectorProposalRequests(input: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) {
      const body = parse(z.strictObject({ cursor: V.logoUuidSchema.optional(), limit: z.number().int().min(1).max(10).default(10) }), input);
      const params = new URLSearchParams({ limit: String(body.limit) }); if (body.cursor) params.set("cursor", body.cursor);
      return request(`${project()}/vector-proposals/requests/current?${params}`, logoVectorProposalRequestPageSchema, owned, { signal, maximum: 2_097_152 });
    },
    async listLogoVectorProposals(input: PageQuery = {}, signal?: AbortSignal) {
      return request(`${project()}/vector-proposals?${query(input)}`, logoVectorProposalPageSchema, owned, { signal, maximum: 65_536 });
    },
    async readLogoVectorProposal(proposalId: string, signal?: AbortSignal) {
      const id = parse(V.logoUuidSchema, proposalId);
      return request(`${project()}/vector-proposals/${id}`, logoVectorProposalRecordSchema, value => owned(value) && value.id === id, { signal, maximum: 163_840 });
    },
    async readVectorProposalRequest(input: J.LogoGenerationIntent, signal?: AbortSignal) {
      const body = parse(J.logoGenerationIntentSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/vector-proposals/requests/${body.requestKey}/lookup`, logoVectorProposalRequestStateSchema, value => owned(value) && same(value.input, body), { method: "POST", body, signal, maximum: 524_288 });
    },
    async closeVectorProposalRequest(input: J.LogoGenerationIntent, signal?: AbortSignal) {
      const body = parse(J.logoGenerationIntentSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/vector-proposals/requests/${body.requestKey}/cancel`, logoVectorProposalRequestCloseSchema,
        value => value.status === "not_admitted" ? owned(value) && same(value.input, body) : owned(value.request) && same(value.request.input, body), { method: "POST", body, signal, maximum: 524_288 });
    },
    async quoteLogoOperation(input: J.LogoQuoteRequest, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const body = parse(J.logoQuoteRequestSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/quotes`, J.logoCostQuoteSchema, value => owned(value) && same(value.request, body), { method: "POST", body, signal });
    },
    async admitLogoOperation(input: J.LogoGenerationIntent, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const body = parse(J.logoGenerationIntentSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/requests`, J.logoDispatchReceiptSchema, value => owned(value) && value.requestKey === body.requestKey && value.operation !== "identity.logo_export", { method: "POST", body, signal, admission: body });
    },
    async cancelLogoVectorEdit(input: LogoVectorEditCommand, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const command = parse(logoVectorEditCommandSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/edits/requests/${command.body.requestKey}/cancel`, logoVectorEditRequestStateSchema,
        value => value.status !== "not_found" && owned(value) && value.requestKey === command.body.requestKey && sameLogoVectorEditCommand(value.command, command),
        { method: "POST", body: command, signal, maximum: 131_072 });
    },
    async readLogoVectorEditRequest(requestKey: string, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const key = parse(V.logoUuidSchema, requestKey);
      return request(`${project()}/edits/requests/${key}`, logoVectorEditRequestStateSchema,
        value => value.status === "not_found" || owned(value) && value.requestKey === key,
        { signal, maximum: 131_072 });
    },
    async readLogoRequest(requestKey: string, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const key = parse(V.logoUuidSchema, requestKey);
      return request(`${project()}/requests/${key}`, J.logoRequestStateSchema, value => stateOwned(value, key), { signal, maximum: pageBytes });
    },
    async reconcileLogoRequest(requestKey: string, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const key = parse(V.logoUuidSchema, requestKey);
      return request(`${project()}/requests/${key}/reconcile`, J.logoRequestStateSchema, value => stateOwned(value, key), { method: "POST", signal, maximum: pageBytes });
    },
    async readLogoReferenceSnapshot(snapshotId: string, signal?: AbortSignal): Promise<W.LogoReferenceSnapshot | null> {
      if (!current() || signal?.aborted) return null;
      const id = parse(V.logoUuidSchema, snapshotId);
      return request(`${project()}/reference-snapshots/${id}`, W.logoReferenceSnapshotSchema,
        value => owned(value) && value.id === id, { signal, maximum: 131_072 });
    },
    async listLogoReferences(input: PageQuery = {}, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      return request(`${project()}/references?${query(input)}`, W.logoReferencePageSchema, owned, { signal, maximum: 3_276_800 });
    },
    async importCuratedLogoReference(input: z.infer<typeof W.importCuratedLogoReferenceInputSchema>, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const body = parse(W.importCuratedLogoReferenceInputSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/references/imports`, W.logoReferenceRegistrationSchema, value => owned(value.asset) && value.sourceKind === "curated" && same(value.aspects, body.aspects), { method: "POST", body, signal, maximum: 65_536 });
    },
    async uploadLogoReference(input: z.infer<typeof W.uploadLogoReferenceInputSchema> & { file: File }, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new AccountRequestError(422);
      const { file, ...metadata } = input, body = parse(W.uploadLogoReferenceInputSchema, metadata, W.LOGO_MUTATION_MAX_BYTES);
      if (!(file instanceof File) || file.size < 1) throw new AccountRequestError(422);
      if (file.size > ASSET_MAX_FILE_BYTES) throw new AccountRequestError(413);
      const form = new FormData(); form.set("input", JSON.stringify(body)); form.set("file", file);
      return request(`${project()}/references/uploads`, W.logoReferenceRegistrationSchema, value => owned(value.asset) && value.sourceKind === "upload" && same(value.aspects, body.aspects), { method: "POST", form, signal, maximum: 65_536 });
    },
    async downloadAsset(input: D.IdentityAssetReceipt, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const receipt = parse(D.committedIdentityAssetReceiptSchema, input);
      return download(receipt.reference, receipt.verification.mimeType, signal);
    },
    /** Download the exact saved SVG, independent of acceptance or a brand-pack export.
     * Only a revision ID is accepted: local editor changes cannot become a saved file. */
    async downloadLogoVector(vectorRevisionId: string, signal?: AbortSignal): Promise<AssetDownload | null> {
      const detail = await readVectorDetail(vectorRevisionId, signal);
      return detail ? download(detail.revision.svgAsset, "image/svg+xml", signal) : null;
    },
    async previewAsset(input: D.IdentityAssetReceipt, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const receipt = parse(D.committedIdentityAssetReceiptSchema, input);
      return preview(receipt.reference, receipt.verification.mimeType, receipt.verification.byteLength, signal);
    },
    async previewLogoReference(input: W.LogoReferenceRegistration, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const reference = parse(W.logoReferenceRegistrationSchema, input);
      return preview(reference.asset, null, null, signal);
    },
    async getIdentityDirections(input: PageQuery = {}, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      return request(`${project()}/directions?${query(input)}`, Directions.identityDirectionsOverviewSchema, owned, { signal, maximum: 8_388_608 });
    },
    async listLogoFonts(signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      return request(`${project()}/fonts`, z.array(Directions.fontRecordSchema).max(100), value => value.every(font => owned(font.asset)), { signal, maximum: 3_276_800 });
    },
    async prepareLogoVariants(input: z.infer<typeof W.prepareLogoVariantsInputSchema>, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const body = parse(W.prepareLogoVariantsInputSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/variants/prepare`, D.logoVariantSetSchema, value => owned(value) && value.approvedLogoId === body.approvedLogoId && value.directionApprovalId === body.directionApprovalId, { method: "POST", body, signal });
    },
    async requestLogoExport(input: D.LogoExportIntent, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const body = parse(D.logoExportIntentSchema, input, W.LOGO_MUTATION_MAX_BYTES);
      return request(`${project()}/exports`, J.logoDispatchReceiptSchema, value => owned(value) && value.requestKey === body.requestKey && value.operation === "identity.logo_export", { method: "POST", body, signal, exportAdmission: body });
    },
    async getLogoExport(exportId: string, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const id = parse(V.logoUuidSchema, exportId);
      return request(`${project()}/exports/${id}`, D.logoExportManifestSchema, value => owned(value) && value.id === id, { signal, maximum: 131_072 });
    },
    async getLogoDeliverables(input: { cursor?: string; requestCursor?: string; limit?: number } = {}, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const body = parse(W.logoPageQuerySchema.extend({ requestCursor: z.string().min(1).max(2048).optional() }), input), params = query({ cursor: body.cursor, limit: body.limit });
      if (body.requestCursor) params.set("requestCursor", body.requestCursor);
      return request(`${project()}/deliverables?${params}`, D.logoDeliverablesOverviewSchema, value => owned(value) && value.exportRequests.every(entry => {
        const receipt = entry.state.receipt;
        if (!stateOwned(entry.state, entry.requestKey) || entry.state.rejection && !D.matchesLogoExportRejection(entry.state.rejection, binding.ownerId, binding.projectId!, entry.input)) return false;
        if (receipt && (!("operation" in receipt) || receipt.operation !== "identity.logo_export")) return false;
        const manifest = value.exports.find(item => item.manifest.id === entry.exportManifestId)?.manifest;
        return !manifest || manifest.requestKey === entry.requestKey && manifest.approvedLogoId === entry.input.approvedLogoId
          && manifest.directionApprovalId === entry.input.directionApprovalId && manifest.variantSetId === entry.input.variantSetId;
      }), { signal, maximum: 26_214_400 });
    },
    async listLogoVectorHistory(input: VectorHistory.LogoVectorHistoryQuery = {}, signal?: AbortSignal) {
      if (!current() || signal?.aborted) return null;
      const body = parse(VectorHistory.logoVectorHistoryQuerySchema, input), params = query(body);
      return request(`${project()}/vector/history?${params}`, VectorHistory.logoVectorHistoryPageSchema,
        value => owned(value) && value.items.length <= body.limit, { signal, maximum: VectorHistory.LOGO_VECTOR_HISTORY_MAX_BYTES });
    },
    async readLogoCurrentVectorRevisionId(signal?: AbortSignal): Promise<string | null> {
      if (!current() || signal?.aborted) return null;
      const selection = await request(`${project()}/vector/current`, W.logoCurrentVectorSelectionSchema, owned, { signal });
      return selection?.vectorRevisionId ?? null;
    },
    readLogoVectorDetail: readVectorDetail,
    async resolveLogoVariantSet(variantSetId: string, signal?: AbortSignal): Promise<D.ResolvedLogoVariantSet | null> {
      if (!current() || signal?.aborted) return null;
      parse(V.logoUuidSchema, variantSetId); return unavailable(signal);
    },
    async getApprovedLogoIdentitySnapshot(signal?: AbortSignal): Promise<D.ApprovedLogoIdentitySnapshot | null> {
      if (!current() || signal?.aborted) return null;
      return unavailable(signal);
    },
    // Shared catalog/font admission contracts and their actual licensed-byte
    // readers are future dependencies; there is no browser source/license fallback.
    async listCuratedLogoReferences(input: PageQuery = {}, signal?: AbortSignal): Promise<{ items: { id: string; title: string; sourceUrl: string; rightsEvidenceId: string; previewHash: string }[]; nextCursor: string | null } | null> {
      if (!current() || signal?.aborted) return null;
      query(input); return unavailable(signal);
    },
    async getCuratedLogoReferencePreview(referenceId: string, signal?: AbortSignal): Promise<Preview | null> {
      if (!current() || signal?.aborted) return null;
      parse(V.logoUuidSchema, referenceId); return unavailable(signal);
    },
    async listCatalogLogoFonts(signal?: AbortSignal): Promise<{ id: string; family: string; rights: Directions.FontRightsEvidence }[] | null> { return unavailable(signal); },
    async importCatalogLogoFont(input: FontImport, signal?: AbortSignal): Promise<Directions.FontRecord | null> {
      if (!current() || signal?.aborted) return null;
      void input; return unavailable(signal);
    },
    async uploadLogoFont(input: FontUpload, signal?: AbortSignal): Promise<Directions.FontRecord | null> {
      if (!current() || signal?.aborted) return null;
      void input; return unavailable(signal);
    },
  };
  clientBindings.set(client, { ...binding, current });
  return client;
}
export type AccountLogoClient = ReturnType<typeof createAccountLogoClient>;

/** Factory provenance, not caller-supplied metadata, validates an injected client. */
export function isAccountLogoClientCurrent(client: AccountLogoClient, account: VerifiedAccount, projectId: string): boolean {
  const binding = clientBindings.get(client);
  return !!binding && binding.ownerId === account.userId && binding.generation === account.generation && binding.projectId === projectId && binding.current();
}
