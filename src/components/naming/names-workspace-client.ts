import type { z } from "zod";
import { AccountRequestError } from "@/components/workspace/account-api";
import { NAMES_WORKSPACE_MUTATION_MAX_BYTES, NAMES_WORKSPACE_RESPONSE_MAX_BYTES } from "@/domain/names-workspace";

/** Bound save acknowledgements and streamed payload bytes. */
export async function namesWorkspaceRequest<T>(path: string, schema: z.ZodType<T>, options: {
  signal: AbortSignal; method?: "GET" | "PUT"; body?: unknown; expectedOwnerId?: string;
}): Promise<T> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body && new TextEncoder().encode(body).byteLength > NAMES_WORKSPACE_MUTATION_MAX_BYTES) throw new AccountRequestError(413);
  if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(new DOMException("Aborted", "AbortError")); controller.abort(); };
    options.signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => { reject(new AccountRequestError(408)); controller.abort(); }, 30_000);
  });
  const read = async () => {
    const response = await fetch(path, { method: options.method ?? "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.expectedOwnerId ? { "X-Embel-Account": options.expectedOwnerId } : {}) }, ...(body === undefined ? {} : { body }) });
    const limit = NAMES_WORKSPACE_RESPONSE_MAX_BYTES;
    if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || Number(response.headers.get("content-length")) > limit || controller.signal.aborted) {
      void response.body?.cancel().catch(() => {}); throw new AccountRequestError(response.ok ? 502 : response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AccountRequestError(502);
    try {
      const pieces: Uint8Array[] = []; let size = 0;
      for (let chunks = 0; ; chunks++) {
        if (chunks > 4096 || controller.signal.aborted) throw new AccountRequestError(502);
        const next = await reader.read();
        if (next.done) break;
        if (size + next.value.byteLength > limit) throw new AccountRequestError(502);
        pieces.push(next.value); size += next.value.byteLength;
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
      const parsed = schema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (!parsed.success || controller.signal.aborted) throw new AccountRequestError(502);
      return parsed.data;
    } catch (error) {
      if (error instanceof AccountRequestError) throw error;
      throw new AccountRequestError(502);
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  try { return await Promise.race([read(), stopped]); }
  finally { if (timeout) clearTimeout(timeout); options.signal.removeEventListener("abort", abort); }
}
