import {
  inspirationMutationSchema,
  inspirationOverviewSchema,
  type InspirationMutation,
  type InspirationOverview,
} from "@/domain/inspiration";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { z } from "zod";

export function createInspirationClient(
  account: VerifiedAccount,
  projectId: string,
  isCurrent: (account: VerifiedAccount) => boolean,
  expire: (account: VerifiedAccount) => void,
) {
  const base = `/api/projects/${z.uuid().parse(projectId).toLowerCase()}/inspiration`;
  const controllers = new Set<AbortController>();
  let closed = false;
  const current = () => !closed && isCurrent(account);
  async function request(referenceId?: string, input?: InspirationMutation): Promise<InspirationOverview | null> {
    if (!current()) return null;
    const controller = new AbortController();
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AccountRequestError(408));
        controller.abort();
      }, 15000);
    });
    const operation = async () => {
      const body = input ? JSON.stringify(inspirationMutationSchema.parse(input)) : undefined;
      const response = await fetch(base + (referenceId ? `/${z.uuid().parse(referenceId)}` : ""), {
        method: body ? "PATCH" : "GET",
        ...(body ? { body } : {}),
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      });
      if (!current() || controller.signal.aborted) return null;
      if (response.status === 401) {
        expire(account);
        return null;
      }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        throw new AccountRequestError(502);
      const reader = response.body?.getReader();
      if (!reader) throw new AccountRequestError(502);
      const bytes = new Uint8Array(131072);
      let size = 0;
      try {
        for (let chunks = 0; ; chunks++) {
          if (chunks > 4096) throw new AccountRequestError(502);
          const part = await reader.read();
          if (part.done) break;
          if (size + part.value.length > bytes.length || controller.signal.aborted) throw new AccountRequestError(502);
          bytes.set(part.value, size);
          size += part.value.length;
        }
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!current() || controller.signal.aborted) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
      } catch {
        throw new AccountRequestError(502);
      }
      const value = inspirationOverviewSchema.safeParse(raw);
      if (!value.success) throw new AccountRequestError(502);
      if (value.data.ownerId !== account.userId || value.data.projectId !== projectId) {
        expire(account);
        return null;
      }
      return value.data;
    };
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      clearTimeout(timer!);
      controllers.delete(controller);
      controller.abort();
    }
  }
  return {
    current,
    read: () => request(),
    save: (id: string, input: InspirationMutation) => request(id, input),
    activate() {
      closed = false;
    },
    dispose() {
      closed = true;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    },
  };
}
export function inspirationError(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 409)
      return "Saved choices or project details changed. Check the latest version before trying again.";
    if (error.status === 404) return "This project is no longer available to this account.";
    if (error.status === 503) return "Saving inspiration is unavailable. You can still explore the designs.";
    if (error.status === 408) return "The request timed out. Check saved choices before trying again.";
  }
  return "The saved choices could not be confirmed. Check your connection and try again.";
}
