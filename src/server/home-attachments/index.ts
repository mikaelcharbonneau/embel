import "server-only";
import { z } from "zod";
import {
  attachmentPolicySchema,
  attachedProjectDraftInputSchema,
  attachedProjectDraftReceiptSchema,
  ownedAttachmentRefSchema,
  requestLookupSchema,
  stageHomeAttachmentInputSchema,
  type AttachmentPolicy,
  type AttachedProjectDraftInput,
  type AttachedProjectDraftReceipt,
  type OwnedAttachmentRef,
  type RequestLookup,
  type StageHomeAttachmentInput,
} from "@/domain/attachments";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { validateHomeAttachmentBytes } from "./validation";
export type HomeAttachmentReservation = {
  requestKey: string;
  storagePath: string;
  ref: OwnedAttachmentRef;
  verified: boolean;
};
export type HomeAttachmentObservation = {
  contentHash: string;
  mimeType: OwnedAttachmentRef["mimeType"];
  byteLength: number;
};
/** Only a trusted server capability may prepare or observe actual-byte proof.
 * Every implementation derives ownership from a verified principal, atomically
 * reserves exact intent, never replaces an object, and freezes committed receipts. */
export interface HomeAttachmentBackend {
  prepare(
    auth: AuthenticatedContext,
    input: StageHomeAttachmentInput,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<HomeAttachmentReservation>;
  lookup(
    auth: AuthenticatedContext,
    requestKey: string,
    signal?: AbortSignal,
  ): Promise<HomeAttachmentReservation | null>;
  observe(
    auth: AuthenticatedContext,
    id: string,
    observed: HomeAttachmentObservation,
    signal?: AbortSignal,
  ): Promise<OwnedAttachmentRef>;
  resolve(auth: AuthenticatedContext, ids: string[], signal?: AbortSignal): Promise<HomeAttachmentReservation[]>;
  save(
    auth: AuthenticatedContext,
    input: AttachedProjectDraftInput,
    signal?: AbortSignal,
  ): Promise<AttachedProjectDraftReceipt>;
  lookupProject(
    auth: AuthenticatedContext,
    requestKey: string,
    signal?: AbortSignal,
  ): Promise<RequestLookup<AttachedProjectDraftReceipt>>;
}
/** Server-owned immutable private objects. null means confirmed absence only;
 * transport failures MUST throw. No overwrite, delete, public URL or fallback. */
export interface HomeAttachmentStorage {
  putIfAbsent(path: string, bytes: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<void>;
  read(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}
export type HomeAttachmentDependencies = {
  backend: HomeAttachmentBackend;
  storage: HomeAttachmentStorage;
  policy: AttachmentPolicy;
};
export class HomeAttachmentUncertainError extends ApiError {
  constructor(readonly requestKey: string) {
    super("integration_unavailable");
    this.name = "HomeAttachmentUncertainError";
  }
}
export const homeAttachmentReservationSchema = z.strictObject({
  requestKey: z.uuid(),
  storagePath: z.string().min(1).max(255),
  ref: ownedAttachmentRefSchema,
  verified: z.boolean(),
});
const parse = <T>(schema: z.ZodType<T>, raw: unknown, stored = false): T => {
  const p = schema.safeParse(raw);
  if (!p.success) throw new ApiError(stored ? "integration_unavailable" : "invalid_input");
  return p.data;
};
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new ApiError("integration_unavailable");
};
const uuid = (id: string) => {
  const p = z.uuid().safeParse(id);
  if (!p.success) throw new ApiError("not_found");
  return p.data.toLowerCase();
};
const staged = (ref: OwnedAttachmentRef): OwnedAttachmentRef => ({
  ...ref,
  projectId: null,
  projectRevision: null,
  state: "staged",
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** This factory performs no provisioning, environment lookup, credential lookup,
 * inference or project creation during staging. Default capability is unavailable. */
export function createHomeAttachmentService(dependencies: HomeAttachmentDependencies | null) {
  const requestedPolicy = dependencies ? parse(attachmentPolicySchema, dependencies.policy) : null;
  // The reviewed proposal includes PDF, but the available decoder cannot enforce
  // a total decoded-memory bound. Do not advertise or admit it as configured.
  const availableTypes: AttachmentPolicy["allowedMimeTypes"] =
    requestedPolicy?.allowedMimeTypes.filter((type) => type !== "application/pdf") ?? [];
  const policy =
    requestedPolicy && availableTypes.length
      ? Object.freeze({ ...requestedPolicy, allowedMimeTypes: availableTypes })
      : null;
  const configured = () => {
    if (!dependencies || !policy) throw new ApiError("integration_unavailable");
    return dependencies;
  };
  function reservation(auth: AuthenticatedContext, raw: unknown) {
    const r = parse(homeAttachmentReservationSchema, raw, true),
      ref = r.ref;
    if (ref.ownerId !== uuid(auth.userId) || r.storagePath !== `${ref.ownerId}/home/${ref.id}/${ref.blobVersionId}`)
      throw new ApiError("not_found");
    if (ref.mimeType === "application/pdf") throw new ApiError("integration_unavailable");
    if (!policy!.allowedMimeTypes.includes(ref.mimeType) || ref.byteLength > policy!.maxFileBytes)
      throw new ApiError("invalid_input");
    return r;
  }
  async function readBytes(r: HomeAttachmentReservation, signal?: AbortSignal) {
    active(signal);
    const stored = await configured().storage.read(r.storagePath, signal);
    active(signal);
    if (stored === null) return null;
    if (
      !(stored.bytes instanceof Uint8Array) ||
      stored.bytes.byteLength !== r.ref.byteLength ||
      stored.mimeType !== r.ref.mimeType
    )
      throw new ApiError("integration_unavailable");
    const bytes = new Uint8Array(stored.bytes);
    await validateHomeAttachmentBytes(
      { requestKey: r.requestKey, name: r.ref.name, mimeType: r.ref.mimeType, contentHash: r.ref.contentHash },
      bytes,
      signal,
    );
    return bytes;
  }
  async function verify(auth: AuthenticatedContext, r: HomeAttachmentReservation, signal?: AbortSignal) {
    const bytes = await readBytes(r, signal);
    if (!bytes) return null;
    const receipt = parse(
      ownedAttachmentRefSchema,
      await configured().backend.observe(
        auth,
        r.ref.id,
        { contentHash: r.ref.contentHash, mimeType: r.ref.mimeType, byteLength: bytes.byteLength },
        signal,
      ),
      true,
    );
    active(signal);
    if (!same(receipt, staged(r.ref))) throw new ApiError("integration_unavailable");
    return receipt;
  }
  function projectReceipt(auth: AuthenticatedContext, raw: unknown, input?: AttachedProjectDraftInput) {
    const r = parse(attachedProjectDraftReceiptSchema, raw, true);
    if (r.ownerId !== uuid(auth.userId)) throw new ApiError("not_found");
    if (
      r.project.current_revision !== 1 ||
      r.attachments.length > policy!.maxFiles ||
      r.attachments.reduce((n, ref) => n + ref.byteLength, 0) > policy!.maxTotalBytes ||
      r.attachments.some(
        (ref) => !policy!.allowedMimeTypes.includes(ref.mimeType) || ref.byteLength > policy!.maxFileBytes,
      )
    )
      throw new ApiError("integration_unavailable");
    if (
      input &&
      (r.requestKey !== input.requestKey ||
        r.project.title !== input.project.title ||
        r.project.scope !== input.project.scope ||
        !same(r.project.context, input.project.context) ||
        !same(
          r.attachments.map((ref) => ref.id),
          input.attachmentIds,
        ))
    )
      throw new ApiError("conflict");
    return r;
  }
  async function readAttachedProjectDraftRequest(
    auth: AuthenticatedContext,
    key: string,
    signal?: AbortSignal,
  ): Promise<RequestLookup<AttachedProjectDraftReceipt>> {
    active(signal);
    key = uuid(key);
    const lookup = parse(
      requestLookupSchema(attachedProjectDraftReceiptSchema),
      await configured().backend.lookupProject(auth, key, signal),
      true,
    );
    active(signal);
    if (lookup.status === "committed") {
      if (lookup.receipt.requestKey !== key) throw new ApiError("integration_unavailable");
      return { status: "committed", receipt: projectReceipt(auth, lookup.receipt) };
    }
    if (lookup.status === "pending" && lookup.requestKey !== key) throw new ApiError("integration_unavailable");
    return lookup;
  }
  return {
    getHomeAttachmentCapability: (): AttachmentPolicy | null => (policy ? structuredClone(policy) : null),
    async stageHomeAttachment(
      auth: AuthenticatedContext,
      raw: StageHomeAttachmentInput,
      source: Uint8Array,
      signal?: AbortSignal,
    ): Promise<OwnedAttachmentRef> {
      active(signal);
      const d = configured(),
        input = parse(stageHomeAttachmentInputSchema, raw);
      if (!(source instanceof Uint8Array) || !source.byteLength) throw new ApiError("invalid_input");
      if (source.byteLength > policy!.maxFileBytes) throw new ApiError("body_too_large");
      if (input.mimeType === "application/pdf") throw new ApiError("integration_unavailable");
      if (!policy!.allowedMimeTypes.includes(input.mimeType)) throw new ApiError("invalid_input");
      const bytes = new Uint8Array(source);
      await validateHomeAttachmentBytes(input, bytes, signal);
      active(signal);
      let r: HomeAttachmentReservation;
      try {
        r = reservation(auth, await d.backend.prepare(auth, input, bytes.byteLength, signal));
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new HomeAttachmentUncertainError(input.requestKey);
      }
      if (
        r.requestKey !== input.requestKey ||
        r.ref.name !== input.name ||
        r.ref.mimeType !== input.mimeType ||
        r.ref.contentHash !== input.contentHash ||
        r.ref.byteLength !== bytes.byteLength
      )
        throw new ApiError("conflict");
      try {
        active(signal);
        await d.storage.putIfAbsent(r.storagePath, bytes, input.mimeType, signal);
        active(signal);
        const receipt = await verify(auth, r, signal);
        if (!receipt) throw new Error("Missing immutable bytes");
        return receipt;
      } catch {
        throw new HomeAttachmentUncertainError(input.requestKey);
      }
    },
    async readHomeAttachmentRequest(
      auth: AuthenticatedContext,
      key: string,
      signal?: AbortSignal,
    ): Promise<RequestLookup<OwnedAttachmentRef>> {
      active(signal);
      key = uuid(key);
      const raw = await configured().backend.lookup(auth, key, signal);
      active(signal);
      if (raw === null) return { status: "not_found" };
      const r = reservation(auth, raw);
      if (r.requestKey !== key) throw new ApiError("integration_unavailable");
      try {
        const receipt = await verify(auth, r, signal);
        if (!receipt && r.verified) throw new Error("Verified object missing");
        return receipt ? { status: "committed", receipt } : { status: "pending", requestKey: key };
      } catch {
        throw new HomeAttachmentUncertainError(key);
      }
    },
    async saveAttachedProjectDraft(
      auth: AuthenticatedContext,
      raw: AttachedProjectDraftInput,
      signal?: AbortSignal,
    ): Promise<AttachedProjectDraftReceipt> {
      active(signal);
      const d = configured(),
        input = parse(attachedProjectDraftInputSchema, raw);
      if (Buffer.byteLength(JSON.stringify(input)) > 32_768) throw new ApiError("body_too_large");
      if (input.attachmentIds.length > policy!.maxFiles) throw new ApiError("invalid_input");
      const previous = await readAttachedProjectDraftRequest(auth, input.requestKey, signal);
      if (previous.status === "committed") return projectReceipt(auth, previous.receipt, input);
      if (previous.status === "pending") throw new HomeAttachmentUncertainError(input.requestKey);
      const rows = (await d.backend.resolve(auth, input.attachmentIds, signal)).map((row) => reservation(auth, row));
      active(signal);
      if (
        !same(
          rows.map((r) => r.ref.id),
          input.attachmentIds,
        )
      )
        throw new ApiError("not_found");
      if (rows.some((r) => !r.verified || r.ref.state !== "staged")) throw new ApiError("conflict");
      if (rows.reduce((n, r) => n + r.ref.byteLength, 0) > policy!.maxTotalBytes) throw new ApiError("body_too_large");
      for (const row of rows) if (!(await readBytes(row, signal))) throw new ApiError("integration_unavailable");
      active(signal);
      try {
        const receipt = projectReceipt(auth, await d.backend.save(auth, input, signal), input);
        active(signal);
        if (
          !same(
            receipt.attachments.map(staged),
            rows.map((r) => r.ref),
          )
        )
          throw new Error("Changed attachment proof");
        return receipt;
      } catch (e) {
        if (e instanceof ApiError && ["conflict", "not_found", "invalid_input", "unauthenticated"].includes(e.code))
          throw e;
        throw new HomeAttachmentUncertainError(input.requestKey);
      }
    },
    readAttachedProjectDraftRequest,
    async resolveOwnedAttachments(
      auth: AuthenticatedContext,
      projectId: string,
      refs: OwnedAttachmentRef[],
      signal?: AbortSignal,
    ): Promise<OwnedAttachmentRef[]> {
      active(signal);
      projectId = uuid(projectId);
      const d = configured();
      const parsed = parse(z.array(ownedAttachmentRefSchema).max(policy!.maxFiles), refs);
      if (
        new Set(parsed.map((r) => r.id)).size !== parsed.length ||
        parsed.some((r) => r.ownerId !== uuid(auth.userId) || r.projectId !== projectId || r.state !== "linked")
      )
        throw new ApiError("not_found");
      const rows = (
        await d.backend.resolve(
          auth,
          parsed.map((r) => r.id),
          signal,
        )
      ).map((r) => reservation(auth, r));
      active(signal);
      if (
        rows.some((r) => !r.verified) ||
        !same(
          rows.map((r) => r.ref),
          parsed,
        )
      )
        throw new ApiError("not_found");
      return rows.map((r) => r.ref);
    },
  };
}
export const productionHomeAttachmentService = createHomeAttachmentService(null);
async function withRouteService<T>(
  auth: AuthenticatedContext,
  signal: AbortSignal | undefined,
  run: (service: ReturnType<typeof createHomeAttachmentService>) => Promise<T> | T,
): Promise<T> {
  const { acquireSharedAccountHome } = await import("../shared-account/bootstrap");
  const lease = await acquireSharedAccountHome(auth, signal);
  try {
    return await run(lease.value ?? productionHomeAttachmentService);
  } finally {
    await lease.release();
  }
}
export async function getHomeAttachmentCapability(auth?: AuthenticatedContext): Promise<AttachmentPolicy | null> {
  return auth ? withRouteService(auth, undefined, (service) => service.getHomeAttachmentCapability()) : null;
}
export async function stageHomeAttachment(
  auth: AuthenticatedContext,
  input: StageHomeAttachmentInput,
  bytes: Uint8Array,
  signal?: AbortSignal,
) {
  return withRouteService(auth, signal, (service) => service.stageHomeAttachment(auth, input, bytes, signal));
}
export async function readHomeAttachmentRequest(auth: AuthenticatedContext, key: string, signal?: AbortSignal) {
  return withRouteService(auth, signal, (service) => service.readHomeAttachmentRequest(auth, key, signal));
}
export async function saveAttachedProjectDraft(
  auth: AuthenticatedContext,
  input: AttachedProjectDraftInput,
  signal?: AbortSignal,
) {
  return withRouteService(auth, signal, (service) => service.saveAttachedProjectDraft(auth, input, signal));
}
export async function readAttachedProjectDraftRequest(auth: AuthenticatedContext, key: string, signal?: AbortSignal) {
  return withRouteService(auth, signal, (service) => service.readAttachedProjectDraftRequest(auth, key, signal));
}
export async function resolveOwnedAttachments(
  auth: AuthenticatedContext,
  projectId: string,
  refs: OwnedAttachmentRef[],
  signal?: AbortSignal,
) {
  return withRouteService(auth, signal, (service) => service.resolveOwnedAttachments(auth, projectId, refs, signal));
}
