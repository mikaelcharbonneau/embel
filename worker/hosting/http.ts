import { apiTextDispatchMessageSchema, type ApiTextDispatchMessage } from "../../src/domain/api-text-dispatch";
import { cronAuthFailure } from "./auth";
import type { PublicationResult } from "./publication";
import { bounded } from "./timing";
import { diagnose, diagnosticErrorClass, type DiagnosticSink } from "./diagnostics";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function readBody(request: Request, signal: AbortSignal) {
  if (!request.body) throw new Error("Invalid request");
  const reader = request.body.getReader(); let size = 0; let text = ""; let accepted = false;
  try {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new Error("Invalid request");
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2_048)) throw new Error("Invalid request");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      signal.throwIfAborted();
      const next = await bounded(reader.read(), signal, 3_000); if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_048) throw new Error("Invalid request");
      text += decoder.decode(next.value, { stream: true });
    }
    signal.throwIfAborted();
    text += decoder.decode();
    const message = apiTextDispatchMessageSchema.parse(JSON.parse(text));
    accepted = true;
    return message;
  } finally {
    // Cancellation itself can fail or never settle. Observe its rejection without
    // letting untrusted stream cleanup delay or replace the bounded response.
    if (!accepted) { try { void reader.cancel().catch(() => {}); } catch { /* Preserve the original rejection. */ } }
    reader.releaseLock();
  }
}
export async function handleEnqueue(request: Request, dependencies: {
  diagnostics?: DiagnosticSink;
  verify(authorization: string | null): Promise<void>;
  publish(message: ApiTextDispatchMessage, signal: AbortSignal): Promise<PublicationResult>;
}): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const signal = AbortSignal.timeout(20_000);
  try { await bounded(dependencies.verify(request.headers.get("authorization")), signal, 4_000); }
  catch { return json({ error: "unauthorized" }, 401); }
  let message: ApiTextDispatchMessage;
  try { message = await readBody(request, AbortSignal.any([request.signal, signal])); }
  catch { return json({ error: "invalid_input" }, 400); }
  const started = Date.now();
  try {
    const result = await bounded(dependencies.publish(message, signal), signal, 15_000);
    diagnose("enqueue", result.state === "dispatch_pending" ? "pending" : "ok", started, "none", dependencies.diagnostics);
    return json(result, result.state === "dispatch_pending" ? 202 : 200);
  } catch (error) {
    diagnose("enqueue", "error", started, diagnosticErrorClass(error, "handler"), dependencies.diagnostics);
    return json({ state: "dispatch_pending" }, 503);
  }
}
export async function handleRepair(request: Request, dependencies: {
  secret: string | undefined;
  repair(signal: AbortSignal): Promise<{ errors: number; [key: string]: unknown }>;
}): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const reason = cronAuthFailure(request.headers.get("authorization"), dependencies.secret);
  if (reason) {
    try { console.warn(JSON.stringify({ event: "api_text_cron_auth_failed", phase: "authentication", reason })); }
    catch { /* Diagnostics must not change the authentication response. */ }
    return json({ error: "unauthorized" }, 401);
  }
  const signal = AbortSignal.timeout(45_000);
  try {
    const result = await bounded(dependencies.repair(signal), signal, 45_000);
    return json(result, result.errors ? 503 : 200);
  } catch { return json({ error: "repair_incomplete", backlogMayRemain: true }, 503); }
}
