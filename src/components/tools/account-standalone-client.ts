import { z } from "zod";
import { STANDALONE_MUTATION_MAX_BYTES, saveStandaloneWorkspaceInputSchema, standaloneImportResponseSchema,
  standaloneWorkspaceResponseSchema, type SaveStandaloneWorkspaceInput, type StandalonePayloadCodec } from "@/domain/standalone-workspaces";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { StandaloneAccount } from "./standalone-draft-memory";

/** Bounded streamed private responses. The common project helper has a smaller write limit and no PUT. */
async function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, input?: unknown): Promise<T> {
  const body = input === undefined ? undefined : JSON.stringify(input);
  if (body && new TextEncoder().encode(body).byteLength > STANDALONE_MUTATION_MAX_BYTES) throw new AccountRequestError(413);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const response = await fetch(path, { method: body === undefined ? "GET" : "PUT", credentials: "same-origin", mode: "same-origin", cache: "no-store", signal,
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body }) });
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new AccountRequestError(response.status); }
  const limit = STANDALONE_MUTATION_MAX_BYTES * 2;
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => undefined); throw new AccountRequestError(502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AccountRequestError(502);
  let raw: unknown;
  try {
    const bytes = new Uint8Array(limit); let length = 0;
    for (let chunks = 0; ; chunks += 1) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (chunks > 2048) throw new AccountRequestError(502);
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > limit) throw new AccountRequestError(502);
      bytes.set(value, length); length += value.byteLength;
    }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (signal.aborted || error instanceof AccountRequestError) throw error;
    throw new AccountRequestError(502);
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const parsed = schema.safeParse(raw); if (!parsed.success) throw new AccountRequestError(502); return parsed.data;
}
export async function getStandaloneWorkspace<T>(codec: StandalonePayloadCodec<T>, account: StandaloneAccount, signal: AbortSignal) {
  const response = await request(`/api/workspaces/${codec.tool}`, standaloneWorkspaceResponseSchema(codec), signal);
  if (response.ownerId !== account.userId.toLowerCase()) throw new AccountRequestError(502);
  return response;
}
export async function saveStandaloneWorkspace<T>(codec: StandalonePayloadCodec<T>, account: StandaloneAccount, raw: SaveStandaloneWorkspaceInput, signal: AbortSignal) {
  const parsed = saveStandaloneWorkspaceInputSchema.safeParse(raw), payload = codec.schema.safeParse(raw.payload);
  if (!parsed.success || !payload.success) throw new AccountRequestError(422);
  const input = { ...parsed.data, payload: payload.data };
  const response = await request(`/api/workspaces/${codec.tool}`, standaloneWorkspaceResponseSchema(codec), signal, input);
  if (response.ownerId !== account.userId.toLowerCase() || !response.workspace || response.workspace.revision !== input.expectedRevision + 1 ||
      JSON.stringify(response.workspace.payload) !== JSON.stringify(payload.data) || JSON.stringify(response.workspace.imports.map(({ projectId, projectRevision, selectionId }) => ({ projectId, projectRevision, selectionId }))) !== JSON.stringify(input.imports)) throw new AccountRequestError(502);
  return response;
}
export async function getStandaloneImport(projectId: string, account: StandaloneAccount, signal: AbortSignal) {
  if (!z.uuid().safeParse(projectId).success) throw new AccountRequestError(422);
  const result = await request(`/api/workspaces/imports?projectId=${encodeURIComponent(projectId)}`, standaloneImportResponseSchema, signal);
  if (result.ownerId !== account.userId.toLowerCase() || (result.source && result.source.projectId !== projectId.toLowerCase())) throw new AccountRequestError(502);
  return result;
}
export function standaloneErrorMessage(error: unknown): string {
  if (error instanceof AccountRequestError) {
    if (error.status === 401) return "Sign in to the same account to recover this draft.";
    if (error.status === 404) return "The selected saved project is unavailable to this account.";
    if (error.status === 409) return "The saved draft or imported source changed. Your edits are retained; load the latest version after reviewing them.";
    if (error.status === 413) return "This draft is too large to save. Shorten it and try again.";
    if (error.status === 422) return "Some draft fields could not be saved. Review their values and lengths.";
    if (error.status === 503) return "Account workspaces are unavailable. Your draft is retained in this tab.";
    if (error.status === 502) return "The account response could not be verified. Your draft and pending save are retained.";
  }
  return "The account could not be reached. Your draft and any pending save are retained in this tab.";
}
