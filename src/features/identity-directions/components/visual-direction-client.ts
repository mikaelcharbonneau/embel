import { z } from "zod";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { reviewVisualDirectionSchema, visualDirectionOverviewSchema, type ReviewVisualDirection } from "@/domain/visual-direction";

export function createVisualDirectionClient(account: VerifiedAccount, rawProjectId: string, isCurrent: (account: VerifiedAccount) => boolean, expire: (account: VerifiedAccount) => void) {
  const projectId = z.uuid().parse(rawProjectId).toLowerCase(), path = `/api/projects/${projectId}/visual-direction`;
  let closed = false;
  const controllers = new Set<AbortController>();
  const current = () => !closed && isCurrent(account);
  async function request(input?: ReviewVisualDirection) {
    if (!current()) return null;
    const controller = new AbortController(); controllers.add(controller);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new AccountRequestError(408)); controller.abort(); }, 15000); });
    const operation = async () => {
      const response = await fetch(path, { method: input ? "POST" : "GET", ...(input ? { body: JSON.stringify(reviewVisualDirectionSchema.parse(input)) } : {}),
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", ...(input ? { "Content-Type": "application/json" } : {}) } });
      if (!current() || controller.signal.aborted) return null;
      if (response.status === 401) { expire(account); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new AccountRequestError(502);
      const reader = response.body?.getReader(); if (!reader) throw new AccountRequestError(502);
      const bytes = new Uint8Array(786432); let size = 0;
      try {
        for (let chunks = 0; ; chunks++) {
          if (chunks > 16384) throw new AccountRequestError(502);
          const part = await reader.read(); if (part.done) break;
          if (size + part.value.length > bytes.length || controller.signal.aborted) throw new AccountRequestError(502);
          bytes.set(part.value, size); size += part.value.length;
        }
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!current() || controller.signal.aborted) return null;
      let raw: unknown; try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))); } catch { throw new AccountRequestError(502); }
      const parsed = visualDirectionOverviewSchema.safeParse(raw); if (!parsed.success) throw new AccountRequestError(502);
      if (parsed.data.inspiration.ownerId !== account.userId || parsed.data.inspiration.projectId !== projectId) { expire(account); return null; }
      return parsed.data;
    };
    try { return await Promise.race([operation(), timeout]); }
    finally { clearTimeout(timer!); controllers.delete(controller); controller.abort(); }
  }
  return { current, read: () => request(), save: (input: ReviewVisualDirection) => request(input),
    activate() { closed = false; }, dispose() { closed = true; controllers.forEach(controller => controller.abort()); controllers.clear(); } };
}
export function visualDirectionError(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 409) return "The saved direction, project details or inspiration changed. Check the latest version before saving.";
    if (error.status === 404) return "This project is no longer available to this account.";
    if (error.status === 503) return "Visual direction saving is not connected. Your written guidance is kept here.";
    if (error.status === 408) return "The request timed out. Check the saved direction before trying again.";
  }
  return "The saved visual direction could not be confirmed. Check the connection before trying again.";
}
