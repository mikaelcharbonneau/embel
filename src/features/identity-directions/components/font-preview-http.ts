import { fontRecordSchema } from "@/domain/logo-directions";
import { logoUuidSchema } from "@/domain/logo-vector";
import { isAccountLogoClientCurrent, type AccountLogoClient } from "@/components/identity/account-logo-client";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { canonicalIdentityInput } from "../model/font-check-binding";
import { fontPurposeAllowed } from "../model/font-rights";
import { FONT_PREVIEW_REQUEST_BYTES, FONT_PREVIEW_RESPONSE_BYTES, fontPreviewInputSchema, fontPreviewResponseSchema, validateFontPreviewGeometry, type FontPreviewReader } from "../model/font-preview";

export function createFontPreviewHttpReader(options: { client: AccountLogoClient; account: VerifiedAccount; projectId: string; isCurrent(account: VerifiedAccount): boolean; expire(account: VerifiedAccount): void; fetcher?: typeof fetch }): FontPreviewReader {
  const account = Object.freeze({ ...options.account }), projectId = logoUuidSchema.parse(options.projectId), fetcher = options.fetcher ?? fetch;
  const current = () => options.isCurrent(account) && isAccountLogoClientCurrent(options.client, account, projectId);
  let active = 0;
  const waiters = new Set<() => void>();
  return async (rawFont, rawInput, signal) => {
    if (!current() || signal.aborted) return null;
    const font = fontRecordSchema.safeParse(rawFont), parsed = fontPreviewInputSchema.safeParse(rawInput);
    if (!font.success || !parsed.success || font.data.asset.ownerId !== account.userId || font.data.asset.projectId !== projectId || font.data.asset.contentHash !== parsed.data.fontContentHash || font.data.rights.id !== parsed.data.rightsEvidenceId) throw new AccountRequestError(422);
    if (!fontPurposeAllowed(font.data, "render") || !fontPurposeAllowed(font.data, "outline")) return { status: "unavailable", reason: "outline_permission_required" };
    const input = parsed.data, body = JSON.stringify(input);
    if (new TextEncoder().encode(body).byteLength > FONT_PREVIEW_REQUEST_BYTES) throw new AccountRequestError(413);
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, 30_000); let acquired = false;
    try {
      while (active >= 2 && current() && !controller.signal.aborted) await new Promise<void>(resolve => {
        const wake = () => { waiters.delete(wake); controller.signal.removeEventListener("abort", wake); resolve(); };
        waiters.add(wake); controller.signal.addEventListener("abort", wake, { once: true });
      });
      if (!current() || signal.aborted) return null;
      if (controller.signal.aborted) throw new AccountRequestError(503);
      active++; acquired = true;
      const response = await fetcher(`/api/projects/${projectId}/logo/fonts/${font.data.id}/preview`, { method: "POST", body, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal, headers: { "Content-Type": "application/json", Accept: "application/json" } });
      if (!current() || signal.aborted) return null;
      if (controller.signal.aborted) throw new AccountRequestError(503);
      if (response.status === 401) { options.client.dispose(); options.expire(account); return null; }
      if (!response.ok) throw new AccountRequestError(response.status);
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new AccountRequestError(502);
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > FONT_PREVIEW_RESPONSE_BYTES)) throw new AccountRequestError(502);
      const reader = response.body?.getReader();
      if (!reader) throw new AccountRequestError(502);
      const chunks: Uint8Array[] = []; let length = 0;
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          if (!current() || signal.aborted) return null;
          if (controller.signal.aborted) throw new AccountRequestError(503);
          const chunk = await reader.read();
          if (!current() || signal.aborted) return null;
          if (controller.signal.aborted) throw new AccountRequestError(503);
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > FONT_PREVIEW_RESPONSE_BYTES) throw new AccountRequestError(502);
          chunks.push(chunk.value);
        }
      } finally { controller.signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = fontPreviewResponseSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (value.ownerId !== account.userId || value.projectId !== projectId || value.fontVersionId !== font.data.id || canonicalIdentityInput(value.input) !== canonicalIdentityInput(input)) throw new AccountRequestError(502);
      if (value.result.status === "ready") value.result.document = validateFontPreviewGeometry(value.result.document);
      return current() && !controller.signal.aborted ? value.result : null;
    } catch (error) {
      if (!current() || signal.aborted) return null;
      throw error instanceof AccountRequestError ? error : new AccountRequestError(controller.signal.aborted ? 503 : 502);
    } finally {
      clearTimeout(deadline); signal.removeEventListener("abort", abort); controller.abort();
      if (acquired) { active--; [...waiters].forEach(wake => wake()); }
    }
  };
}
