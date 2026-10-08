import { apiTextDispatchMessageSchema, type ApiTextDispatchMessage } from "../../src/domain/api-text-dispatch";
import { cronAuthFailure } from "./auth";
import type { PublicationResult } from "./publication";
import { bounded } from "./timing";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function readBody(request: Request, signal: AbortSignal) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !request.body) throw new Error("Invalid request");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2_048)) throw new Error("Invalid request");
  const reader = request.body.getReader(); let size = 0; let text = "";
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const next = await bounded(reader.read(), signal, 3_000); if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_048) { void reader.cancel(); throw new Error("Invalid request"); }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  return apiTextDispatchMessageSchema.parse(JSON.parse(text));
}
export async function handleEnqueue(request: Request, dependencies: {
  verify(authorization: string | null): Promise<void>;
  publish(message: ApiTextDispatchMessage, signal: AbortSignal): Promise<PublicationResult>;
}): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const signal = AbortSignal.timeout(20_000);
  try { await bounded(dependencies.verify(request.headers.get("authorization")), signal, 4_000); }
  catch { return json({ error: "unauthorized" }, 401); }
  let message: ApiTextDispatchMessage;
  try { message = await readBody(request, signal); }
  catch { return json({ error: "invalid_input" }, 400); }
  try {
    const result = await bounded(dependencies.publish(message, signal), signal, 15_000);
    return json(result, result.state === "dispatch_pending" ? 202 : 200);
  } catch { return json({ state: "dispatch_pending" }, 503); }
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
