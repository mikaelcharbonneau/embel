import { z } from "zod";
import type { VerifiedAccount } from "./account-session";
import { AccountRequestError } from "./account-api";
import {
  attachmentPolicySchema,
  attachedProjectDraftInputSchema,
  attachedProjectDraftReceiptSchema,
  ownedAttachmentRefSchema,
  requestLookupSchema,
  stageHomeAttachmentInputSchema,
  type AttachedProjectDraftInput,
  type StageHomeAttachmentInput,
  type OwnedAttachmentRef,
} from "@/domain/attachments";
import { accountProjectResponseSchema } from "@/domain/project-api";
async function boundedResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  maxBytes: number,
): Promise<T> {
  if (!response.ok) throw new AccountRequestError(response.status);
  if (
    response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
    Number(response.headers.get("content-length")) > maxBytes
  )
    throw new AccountRequestError(502);
  const reader = response.body?.getReader();
  if (!reader) throw new AccountRequestError(502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let count = 0; count < 8192; count++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await reader.read();
      if (result.done) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new AccountRequestError(502);
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new AccountRequestError(502);
        return parsed.data;
      }
      size += result.value.byteLength;
      if (size > maxBytes) throw new AccountRequestError(502);
      chunks.push(result.value);
    }
    throw new AccountRequestError(502);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
const uuid = (value: string) => z.uuid().parse(value).toLowerCase();
/** Same-origin client only. null means fenced, never a successful empty response. */
export function createAccountLifecycleClient(
  account: VerifiedAccount,
  isCurrent: (account: VerifiedAccount) => boolean,
  expire: (account: VerifiedAccount) => void,
) {
  async function run<T>(
    path: string,
    schema: z.ZodType<T>,
    verify: (value: T) => boolean,
    signal?: AbortSignal,
    body?: unknown,
    maxBytes = 65_536,
  ): Promise<T | null> {
    if (!isCurrent(account) || signal?.aborted) return null;
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 30_000);
    try {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized && new TextEncoder().encode(serialized).byteLength > 32_768) throw new AccountRequestError(413);
      const response = await fetch(path, {
        signal: controller.signal,
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Embel-Account": account.userId }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
      const result = await boundedResponse(response, schema, controller.signal, maxBytes);
      if (!isCurrent(account) || controller.signal.aborted) return null;
      if (!verify(result)) throw new AccountRequestError(502);
      return result;
    } catch (error) {
      if (!isCurrent(account) || signal?.aborted) return null;
      if (error instanceof AccountRequestError && error.status === 401) {
        expire(account);
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  const owned = (value: { ownerId: string }) => value.ownerId === account.userId.toLowerCase();
  function read<T extends { ownerId: string; requestKey?: string }>(
    path: string,
    key: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ) {
    key = uuid(key);
    return run(
      `${path}/${key}`,
      requestLookupSchema(schema),
      (value) =>
        value.status === "not_found" ||
        (value.status === "pending"
          ? value.requestKey === key
          : owned(value.receipt) && (value.receipt.requestKey === undefined || value.receipt.requestKey === key)),
      signal,
    );
  }
  return {
    getHomeAttachmentCapability(signal?: AbortSignal) {
      const schema = z
        .strictObject({
          ownerId: z.uuid(),
          policy: attachmentPolicySchema.nullable(),
          reason: z.string().min(1).max(1000).nullable(),
        })
        .refine((value) => (value.policy === null ? value.reason !== null : value.reason === null));
      return run("/api/home/attachments/capability", schema, owned, signal);
    },
    getProject(projectId: string, signal?: AbortSignal) {
      projectId = uuid(projectId);
      return run(
        `/api/projects/${projectId}`,
        accountProjectResponseSchema,
        (v) =>
          v.project.id.toLowerCase() === projectId && v.project.owner_id.toLowerCase() === account.userId.toLowerCase(),
        signal,
        undefined,
        262_144,
      );
    },
    async stageHomeAttachment(
      raw: StageHomeAttachmentInput,
      bytes: Uint8Array,
      signal?: AbortSignal,
    ): Promise<OwnedAttachmentRef | null> {
      const input = stageHomeAttachmentInputSchema.parse(raw);
      if (!isCurrent(account) || signal?.aborted) return null;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 10_485_760)
        throw new AccountRequestError(413);
      const snapshot = new Uint8Array(bytes);
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 30_000);
      try {
        const digest = await crypto.subtle.digest("SHA-256", snapshot);
        const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
        if (hash !== input.contentHash) throw new AccountRequestError(422);
        if (!isCurrent(account) || controller.signal.aborted) return null;
        const response = await fetch("/api/home/attachments", {
          method: "POST",
          credentials: "same-origin",
          mode: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": input.mimeType,
            "X-Embel-Account": account.userId,
            "X-Fluid-Request-Key": input.requestKey,
            "X-Fluid-Attachment-Name": encodeURIComponent(input.name),
            "X-Fluid-Content-Hash": input.contentHash,
          },
          body: snapshot.buffer,
        });
        const result = await boundedResponse(
          response,
          z.strictObject({ requestKey: z.uuid(), attachment: ownedAttachmentRefSchema }),
          controller.signal,
          65_536,
        );
        if (!isCurrent(account) || controller.signal.aborted) return null;
        const ref = result.attachment;
        if (
          result.requestKey !== input.requestKey ||
          !owned(ref) ||
          ref.state !== "staged" ||
          ref.projectId !== null ||
          ref.projectRevision !== null ||
          ref.name !== input.name ||
          ref.mimeType !== input.mimeType ||
          ref.contentHash !== input.contentHash ||
          ref.byteLength !== snapshot.byteLength
        )
          throw new AccountRequestError(502);
        return ref;
      } catch (error) {
        if (!isCurrent(account) || signal?.aborted) return null;
        if (error instanceof AccountRequestError && error.status === 401) {
          expire(account);
          return null;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
    readHomeAttachmentRequest: (key: string, signal?: AbortSignal) =>
      read("/api/home/attachments/requests", key, ownedAttachmentRefSchema, signal),
    saveAttachedProjectDraft(raw: AttachedProjectDraftInput, signal?: AbortSignal) {
      const input = attachedProjectDraftInputSchema.parse(raw);
      return run(
        "/api/home/projects",
        attachedProjectDraftReceiptSchema,
        (r) =>
          owned(r) &&
          r.requestKey === input.requestKey &&
          r.project.current_revision === 1 &&
          r.project.title === input.project.title &&
          r.project.scope === input.project.scope &&
          JSON.stringify(r.project.context) === JSON.stringify(input.project.context) &&
          r.attachments.length === input.attachmentIds.length &&
          r.attachments.every((a) => input.attachmentIds.includes(a.id)),
        signal,
        input,
      );
    },
    readAttachedProjectDraftRequest: (key: string, signal?: AbortSignal) =>
      read("/api/home/projects/requests", key, attachedProjectDraftReceiptSchema, signal),
  };
}
export type AccountLifecycleClient = ReturnType<typeof createAccountLifecycleClient>;
