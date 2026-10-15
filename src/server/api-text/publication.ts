import "server-only";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { apiTextDispatchMessageSchema } from "../../domain/api-text-dispatch";
import { getApiTextPublicationOrigin } from "./config";

const replySchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("published"), messageId: z.string().min(1).max(300) }),
  z.strictObject({ state: z.literal("dispatch_pending") }),
  z.strictObject({ state: z.literal("already_processing") }),
]);
export type ApiTextPublicationResult = z.infer<typeof replySchema>;

/** Best effort transport after durable admission. Any uncertainty remains in the outbox. */
export async function publishApiTextDispatch(message: unknown): Promise<ApiTextPublicationResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([publish(message, controller.signal), new Promise<ApiTextPublicationResult>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ state: "dispatch_pending" }); }, 12_000);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
}
async function publish(message: unknown, signal: AbortSignal): Promise<ApiTextPublicationResult> {
  try {
    const parsed = apiTextDispatchMessageSchema.parse(message);
    const origin = getApiTextPublicationOrigin();
    if (!origin) throw new Error("Unconfigured publisher");
    const token = await getVercelOidcToken();
    if (!token) throw new Error("OIDC unavailable");
    signal.throwIfAborted();
    const response = await fetch(`${origin}/api/enqueue`, {
      method: "POST", cache: "no-store", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-vercel-trusted-oidc-idp-token": token },
      body: JSON.stringify(parsed),
    });
    if (!response.ok || !response.body) throw new Error("Publication unconfirmed");
    const reader = response.body.getReader();
    let text = ""; let size = 0;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 1_024) { await reader.cancel(); throw new Error("Invalid publication reply"); }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    return replySchema.parse(JSON.parse(text));
  } catch {
    // Never log an OIDC token, origin query, private DB detail, or caller prompt.
    return { state: "dispatch_pending" };
  }
}
