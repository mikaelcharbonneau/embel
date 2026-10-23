import "server-only";
import { z } from "zod";
import { apiTextDispatchMessageSchema } from "../../domain/api-text-dispatch";
import { getApiTextPublicationOrigin } from "./config";
import { getApiTextPublisherToken } from "./publisher-token";

const replySchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("published"), messageId: z.string().min(1).max(300) }),
  z.strictObject({ state: z.literal("dispatch_pending") }),
  z.strictObject({ state: z.literal("already_processing") }),
]);
export type ApiTextPublicationResult = z.infer<typeof replySchema>;
type PublicationPhase = "descriptor" | "configuration" | "authentication" | "transport" | "http" | "response" | "worker_pending" | "deadline";

/** Fixed classifications only; never log a descriptor, URL, token or error. */
function unconfirmed(phase: PublicationPhase, started: number, status: number | null = null): void {
  try {
    console.warn(JSON.stringify({ event: "api_text_publication_unconfirmed", phase,
      httpStatus: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      durationMs: Math.max(0, Math.min(60_000, Math.round(Date.now() - started))),
    }));
  } catch { /* Logging must not change the admitted request or its response. */ }
}

/** Best effort transport after durable admission. Any uncertainty remains in the outbox. */
export async function publishApiTextDispatch(message: unknown): Promise<ApiTextPublicationResult> {
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([publish(message, controller.signal), new Promise<ApiTextPublicationResult>(resolve => {
      timer = setTimeout(() => { unconfirmed("deadline", started); controller.abort(); resolve({ state: "dispatch_pending" }); }, 12_000);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
}
async function publish(message: unknown, signal: AbortSignal): Promise<ApiTextPublicationResult> {
  const started = Date.now();
  let phase: PublicationPhase = "descriptor";
  let status: number | null = null;
  try {
    const parsed = apiTextDispatchMessageSchema.parse(message);
    phase = "configuration";
    const origin = getApiTextPublicationOrigin();
    if (!origin) throw new Error("Unconfigured publisher");
    phase = "authentication";
    const token = await getApiTextPublisherToken();
    if (!token) throw new Error("OIDC unavailable");
    signal.throwIfAborted();
    phase = "transport";
    const response = await fetch(`${origin}/api/enqueue`, {
      method: "POST", cache: "no-store", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-vercel-trusted-oidc-idp-token": token },
      body: JSON.stringify(parsed),
    });
    phase = "http";
    status = response.status;
    if (!response.ok) throw new Error("Publication unconfirmed");
    phase = "response";
    if (!response.body) throw new Error("Publication unconfirmed");
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
    signal.throwIfAborted();
    const result = replySchema.parse(JSON.parse(text));
    if (result.state === "dispatch_pending") unconfirmed("worker_pending", started, status);
    return result;
  } catch {
    // Never log an OIDC token, origin query, private DB detail, or caller prompt.
    // The outer deadline already records a timed-out attempt. A late token or
    // rejected fetch must not add a second event after that response is settled.
    if (!signal.aborted) unconfirmed(phase, started, status);
    return { state: "dispatch_pending" };
  }
}
