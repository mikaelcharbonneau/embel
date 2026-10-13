import type { z } from "zod";
import { screeningCheckResponseSchema, screeningOverviewSchema, screeningRecordSchema, type ScreeningCursor, type ScreeningRecordInput } from "@/domain/project-screening";
import type { StandaloneLookupInput } from "@/domain/standalone-live-checks";
import { AccountRequestError } from "@/components/workspace/account-api";

/** Bound bytes and the complete HTTP wait; late responses cannot republish after account changes. */
export function createProjectScreeningClient(binding: { ownerId: string; projectId: string; isCurrent: () => boolean; expire: () => void }) {
  const base = `/api/projects/${binding.projectId}/screening`;
  async function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    if (!binding.isCurrent() || signal.aborted) throw new AccountRequestError(401);
    const child = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectStopped!: (reason: AccountRequestError) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const stop = (status: number) => { rejectStopped(new AccountRequestError(status)); child.abort(); void reader?.cancel().catch(() => {}); };
    const abort = () => stop(408), timer = setTimeout(abort, 25000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const work = async () => {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        if (encoded && new TextEncoder().encode(encoded).length > 32768) throw new AccountRequestError(413);
        const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { Accept: "application/json", ...(encoded ? { "Content-Type": "application/json" } : {}) },
          ...(encoded ? { body: encoded } : {}), signal: child.signal, cache: "no-store", mode: "same-origin", credentials: "same-origin", redirect: "error" });
        if (child.signal.aborted || !binding.isCurrent()) { void response.body?.cancel().catch(() => {}); throw new AccountRequestError(408); }
        if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") { void response.body?.cancel().catch(() => {}); throw new AccountRequestError(response.ok ? 502 : response.status); }
        reader = response.body?.getReader(); if (!reader) throw new AccountRequestError(502);
        const bytes = new Uint8Array(1048576); let size = 0;
        for (let chunks = 0; ; chunks++) {
          if (child.signal.aborted || chunks >= 8192) throw new AccountRequestError(502);
          const next = await reader.read(); if (next.done) break;
          if (size + next.value.byteLength > bytes.length) throw new AccountRequestError(502);
          bytes.set(next.value, size); size += next.value.byteLength;
        }
        try { return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)))); }
        catch { throw new AccountRequestError(502); }
      };
      const result = await Promise.race([work(), stopped]);
      if (!binding.isCurrent() || signal.aborted) throw new AccountRequestError(401);
      return result;
    } catch (error) {
      if (error instanceof AccountRequestError && error.status === 401 && binding.isCurrent()) binding.expire();
      throw error;
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort); child.abort(); void reader?.cancel().catch(() => {}); try { reader?.releaseLock(); } catch {}
    }
  }
  function owned(value: { ownerId: string; projectId: string }) { if (value.ownerId !== binding.ownerId || value.projectId !== binding.projectId) throw new AccountRequestError(502); }
  return {
    async read(signal: AbortSignal, cursor?: ScreeningCursor) {
      const result = await request(base + (cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ""), screeningOverviewSchema, signal); owned(result); return result;
    },
    async record(input: ScreeningRecordInput, signal: AbortSignal) {
      const result = await request(base, screeningRecordSchema, signal, input); owned(result.basis);
      if (result.requestId !== input.requestId || result.basis.selectionId !== input.selectionId || result.basis.projectRevision !== input.expectedProjectRevision
        || JSON.stringify(result.criteria) !== JSON.stringify(input.criteria) || result.notes !== input.notes || JSON.stringify(result.sourceUrls) !== JSON.stringify(input.sourceUrls) || Date.parse(result.observedAt) !== Date.parse(input.observedAt)) throw new AccountRequestError(502);
      return result;
    },
    async check(input: { selectionId: string; expectedProjectRevision: number; criteria: StandaloneLookupInput }, signal: AbortSignal) {
      const result = await request(`${base}/check`, screeningCheckResponseSchema, signal, input); owned(result.basis);
      if (result.basis.selectionId !== input.selectionId || result.basis.projectRevision !== input.expectedProjectRevision || JSON.stringify(result.criteria) !== JSON.stringify(input.criteria)) throw new AccountRequestError(502);
      return result;
    },
  };
}
