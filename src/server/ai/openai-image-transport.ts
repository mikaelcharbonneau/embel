import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CAPPED_LOGO_IMAGE_MODEL, IMAGE_MODEL, type LogoImageModel } from "../../domain/providers";
import { IMAGE_INPUT_LIMITS } from "../../domain/logo-image-limits";
import { verifiedAssetBytesSchema, type VerifiedAssetBytes } from "../../domain/logo-deliverables";
import { inspectIdentityRaster } from "../../features/logo-vector/server/converter";
import { logoImageUsageSchema, type LogoImageUsage } from "./openai-image-usage";

export { IMAGE_INPUT_LIMITS } from "../../domain/logo-image-limits";
export type { LogoImageUsage } from "./openai-image-usage";
/** "max" is the highest quality level; a transparent background requires PNG output. */
export type OpenAIImageQuality = "low" | "medium" | "max";
/** How much gpt-image-2.6 plans before drawing ("high" when omitted). It adds no separate fee. */
export type OpenAIImageComplexity = "low" | "medium" | "high";
export type OpenAIImageBackground = "opaque" | "transparent";
export type OpenAIImageRequest = { model: LogoImageModel; prompt: string; size: "1024x1024"; quality: OpenAIImageQuality; complexity?: OpenAIImageComplexity; background: OpenAIImageBackground; images: readonly VerifiedAssetBytes[] };
export type OpenAIImageResponse = { bytes: Uint8Array; mimeType: "image/png"; providerRequestId: string | null; responseHash: string; usage: LogoImageUsage | null };
export interface OpenAIImageTransport { createImage(input: OpenAIImageRequest, clientRequestId: string, signal: AbortSignal): Promise<OpenAIImageResponse> }
export class OpenAIImageTransportError extends Error {
  constructor(readonly code: "request_rejected" | "outcome_unknown" | "invalid_response", readonly providerRequestId: string | null = null,
    readonly responseHash: string | null = null, readonly usage: LogoImageUsage | null = null) { super(code); this.name = "OpenAIImageTransportError"; }
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const safeProviderRequestId = (value: string | null) => value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;
function aborted(signal: AbortSignal) { if (signal.aborted) throw new Error("Aborted"); }
async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  aborted(signal); let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new Error("Aborted")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); } finally { signal.removeEventListener("abort", abort); }
}

/** Bounded while streaming; cancellation also handles a transport whose body
 * ignores the original fetch signal. Raw provider text never escapes this file. */
async function readResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > IMAGE_INPUT_LIMITS.responseBytes)) { void response.body?.cancel().catch(() => undefined); throw new Error("Response limit"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await untilAbort(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength; if (size > IMAGE_INPUT_LIMITS.responseBytes) throw new Error("Response limit");
      chunks.push(item.value);
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Reusable preflight for the producer: limits, actual owned hashes and decoding
 * happen before dispatch. No URL input, implicit upload, or image truncation. */
export async function validateLogoImageInputs(input: OpenAIImageRequest, signal: AbortSignal): Promise<OpenAIImageRequest> {
  aborted(signal);
  if (input.model !== IMAGE_MODEL && input.model !== CAPPED_LOGO_IMAGE_MODEL || input.size !== "1024x1024" || !["low", "medium", "max"].includes(input.quality)
    || input.complexity !== undefined && !["low", "medium", "high"].includes(input.complexity)
    || input.background !== "opaque" && input.background !== "transparent" || typeof input.prompt !== "string"
    || !input.prompt.trim() || input.prompt.length > IMAGE_INPUT_LIMITS.promptCharacters || !Array.isArray(input.images) || input.images.length > IMAGE_INPUT_LIMITS.images) throw new Error("Invalid image request");
  const images = input.images.map(image => ({ ...image, reference: { ...image.reference }, verification: { ...image.verification }, bytes: Uint8Array.from(image.bytes) }));
  if (images.reduce((size, image) => size + image.bytes.byteLength, 0) > IMAGE_INPUT_LIMITS.inputBytes) throw new Error("Input limit");
  for (const image of images) {
    if (!verifiedAssetBytesSchema.safeParse(image).success || sha256(image.bytes) !== image.reference.contentHash) throw new Error("Invalid image reference");
    await inspectIdentityRaster(image.bytes, image.mimeType, signal); aborted(signal);
  }
  return { model: input.model, prompt: input.prompt, size: "1024x1024", quality: input.quality, ...(input.complexity ? { complexity: input.complexity } : {}), background: input.background, images };
}

/** The exact Images API request for one logo image: JSON for a new drawing,
 * multipart with image[] when it edits supplied images. */
export function logoImageRequestBody(input: OpenAIImageRequest): { endpoint: "generations" | "edits"; body: string | FormData; contentType: string | null } {
  const fields = { model: input.model, prompt: input.prompt, n: 1, output_format: "png", size: input.size, quality: input.quality, ...(input.complexity ? { complexity: input.complexity } : {}), background: input.background, moderation: "auto" };
  if (!input.images.length) return { endpoint: "generations", body: JSON.stringify(fields), contentType: "application/json" };
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  input.images.forEach((image, index) => form.append("image[]", new Blob([Uint8Array.from(image.bytes)], { type: image.mimeType }), `input-${index + 1}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png"}`));
  return { endpoint: "edits", body: form, contentType: null };
}
/** The one PNG of a successful Images API reply, or an error when it carries none. */
export function decodeLogoImageReply(value: unknown): Uint8Array {
  const parsed = z.object({ data: z.array(z.object({ b64_json: z.string().min(4), url: z.never().optional() })).length(1) }).safeParse(value);
  if (!parsed.success) throw new Error("Invalid response");
  const encoded = parsed.data.data[0]!.b64_json;
  if (encoded.length > Math.ceil(IMAGE_INPUT_LIMITS.outputBytes / 3) * 4 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Invalid base64");
  const output = new Uint8Array(Buffer.from(encoded, "base64"));
  if (output.byteLength > IMAGE_INPUT_LIMITS.outputBytes || Buffer.from(output).toString("base64") !== encoded) throw new Error("Invalid image bytes");
  return output;
}
/** Usage reported by any Images API reply, or null when absent or contradictory. */
export function logoImageReplyUsage(value: unknown): LogoImageUsage | null {
  if (!value || typeof value !== "object" || !("usage" in value)) return null;
  const parsed = logoImageUsageSchema.safeParse(value.usage); return parsed.success ? parsed.data : null;
}
/** Bounded body read of one Images API reply; raw provider text never escapes. */
export async function readLogoImageReply(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; hash: string; value: unknown }> {
  const bytes = await readResponse(response, signal); aborted(signal);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { value = null; }
  return { bytes, hash: sha256(bytes), value };
}

/** Official Images API contract checked 2026-10-07 (quality "max" and a
 * transparent background rechecked for gpt-image-2.6-sunburst on 2026-11-09;
 * quality "low" and the complexity field checked on 2026-11-10, see
 * https://developers.openai.com/api/docs/guides/image-generation):
 * https://developers.openai.com/api/reference/resources/images/methods/generate
 * https://developers.openai.com/api/reference/resources/images/methods/edit
 * Uses native fetch for exactly one attempt. Multipart image[] preserves local
 * bytes; response_format and input_fidelity are deliberately omitted. */
export function createOpenAIImageTransport(options: { apiKey: string; fetch?: typeof fetch }): OpenAIImageTransport {
  const fetcher = options.fetch ?? fetch;
  return { async createImage(raw, clientRequestId, signal) {
    let input: OpenAIImageRequest;
    try {
      if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || !/^[a-zA-Z0-9._:-]{1,200}$/.test(clientRequestId)) throw new Error("Invalid configuration");
      input = await validateLogoImageInputs(raw, signal); aborted(signal);
    } catch { throw new OpenAIImageTransportError("request_rejected"); }
    const { endpoint, body, contentType } = logoImageRequestBody(input);
    const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json", "X-Client-Request-Id": clientRequestId, ...(contentType ? { "Content-Type": contentType } : {}) };
    let providerRequestId: string | null = null, responseHash: string | null = null, usage: LogoImageUsage | null = null;
    let status: number | null = null;
    try {
      const response = await untilAbort(fetcher(`https://api.openai.com/v1/images/${endpoint}`, { method: "POST", redirect: "error", headers, body, signal }), signal);
      providerRequestId = safeProviderRequestId(response.headers.get("x-request-id")); status = response.status;
      const reply = await readLogoImageReply(response, signal); responseHash = reply.hash;
      const value = reply.value;
      usage = logoImageReplyUsage(value);
      if (!response.ok) throw new OpenAIImageTransportError([400, 401, 403, 404, 413, 422, 429].includes(status) ? "request_rejected" : "outcome_unknown", providerRequestId, responseHash, usage);
      if ((response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") throw new Error("Invalid media type");
      const output = decodeLogoImageReply(value);
      const raster = await inspectIdentityRaster(output, "image/png", signal); aborted(signal);
      if (raster.width !== 1024 || raster.height !== 1024) throw new Error("Unexpected dimensions");
      return { bytes: output, mimeType: "image/png", providerRequestId, responseHash, usage };
    } catch (error) {
      if (error instanceof OpenAIImageTransportError) throw error;
      // A dispatch followed by cancellation, transport or server uncertainty is
      // never a failed-only retry. Successful but malformed bytes are retained
      // as invalid_response with their observed usage/hash when available.
      const code = signal.aborted || status === null || status >= 500 || [408, 409].includes(status) ? "outcome_unknown"
        : status >= 200 && status < 300 ? "invalid_response" : [400, 401, 403, 404, 413, 422, 429].includes(status) ? "request_rejected" : "outcome_unknown";
      throw new OpenAIImageTransportError(code, providerRequestId, responseHash, usage);
    }
  } };
}
