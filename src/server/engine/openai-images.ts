import "server-only";
import { z } from "zod";
import { IMAGE_MODEL } from "@/domain/providers";
import type { VerifiedAssetBytes } from "@/domain/logo-deliverables";
import { createSunburstStandardImageUsagePricer, SUNBURST_STANDARD_IMAGE_PRICING } from "../logo-creation/openai-image-pricing";
import { decodeLogoImageReply, logoImageReplyUsage, logoImageRequestBody, readLogoImageReply, safeProviderRequestId, validateLogoImageInputs,
  type LogoImageUsage } from "../logo-creation/openai-image-transport";
import { LOGO_IMAGE_REQUESTS } from "../logo-creation/openai-logo-provider";
import { EngineProviderError } from "./openai";
import { engineOpenAIOrigin, OPENAI_ORIGIN } from "./provider-origin";

// Logo images on the generation engine: the Images API request #212 configures
// (gpt-image-2.6-sunburst, low quality and low complexity, transparent PNG, 1024 x 1024), one
// attempt per call. The Images API has no background mode and no lookup by id,
// so an outcome that is unknown can't be recovered: the caller fails that one
// image instead of sending it again. Calls never retry here.

/** The engine's Logo image profile. */
export const ENGINE_LOGO_IMAGE = Object.freeze({ model: IMAGE_MODEL, ...LOGO_IMAGE_REQUESTS[IMAGE_MODEL] });
/** A Creative direction board: the shared worker's board request (producer.board),
 * unchanged: same model, medium quality, opaque background, 1024 x 1024. */
export const ENGINE_BOARD_IMAGE = Object.freeze({ model: IMAGE_MODEL, quality: "medium", background: "opaque" } as const);
/** The only profiles a request may name; Logo images by default. */
export type EngineImageProfile = typeof ENGINE_LOGO_IMAGE | typeof ENGINE_BOARD_IMAGE;
/** A low-quality image usually takes well under a minute; this bounds a stalled call. */
const IMAGE_TIMEOUT_MS = 300_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503]);
const UNCERTAIN_STATUSES = new Set([408, 409, 504]);
const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const pricer = createSunburstStandardImageUsagePricer(SUNBURST_STANDARD_IMAGE_PRICING.binding)!;

/** A reply that came back. `image` is a usable PNG; `unusable` was paid for but
 * carries no readable image, so it is never sent again either. */
export type EngineImageReply =
  | { kind: "image"; bytes: Uint8Array; providerRequestId: string | null; responseHash: string; usage: LogoImageUsage | null; costMicrousd: number }
  | { kind: "unusable"; code: "invalid_output"; providerRequestId: string | null; responseHash: string | null; usage: LogoImageUsage | null; costMicrousd: number };
/** A refused request: nothing usable was drawn; its reported usage is kept. */
export class EngineImageRejectedError extends EngineProviderError {
  constructor(status: number, readonly providerRequestId: string | null, readonly costMicrousd: number) { super("rejected", status); }
}

/** Estimated from reported usage at the published rates; zero when OpenAI reported none. */
export function imageCostMicrousd(usage: LogoImageUsage | null): number {
  if (!usage) return 0;
  const billing = pricer(usage);
  return billing.status === "recorded" ? billing.confirmedMicrousd : 0;
}

export interface EngineImages {
  /** One drawing (no images) or edit (base preview first, then references), with the
   * Logo profile unless the request names the board profile. */
  draw(input: { prompt: string; images: readonly VerifiedAssetBytes[]; profile?: EngineImageProfile }, clientRequestId: string): Promise<EngineImageReply>;
}

function connectFailure(error: unknown): boolean {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && CONNECT_ERRORS.has(code);
}
function retryAfter(headers: Headers): number | null {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 60_000);
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60_000) : null;
}

/**
 * Dispositions, as for text (src/server/engine/openai.ts):
 * - retry: 429, 500, 502, 503 or a connection that never opened. Nothing was drawn.
 * - rejected: any other 4xx (for example moderation). Sending it again won't help.
 * - uncertain: a timeout, a dropped connection, 408/409/504. OpenAI may have drawn
 *   (and charged) it, and there is no way to look it up.
 */
export function createEngineImages(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; origin?: string }): EngineImages {
  const fetcher = options.fetch ?? fetch, timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS, origin = options.origin ?? OPENAI_ORIGIN;
  return { async draw(raw, clientRequestId) {
    const signal = AbortSignal.timeout(timeoutMs);
    let request;
    try {
      if (!/^[a-zA-Z0-9._:-]{1,200}$/u.test(clientRequestId)) throw new Error("Invalid request id");
      const profile = raw.profile ?? ENGINE_LOGO_IMAGE;
      if (profile !== ENGINE_LOGO_IMAGE && profile !== ENGINE_BOARD_IMAGE) throw new Error("Invalid image profile");
      request = await validateLogoImageInputs({ ...profile, prompt: raw.prompt, size: "1024x1024", images: raw.images }, signal);
    } catch { throw new EngineProviderError("rejected", null); }
    const { endpoint, body, contentType } = logoImageRequestBody(request);
    let response: Response;
    try {
      response = await fetcher(`${origin}/v1/images/${endpoint}`, { method: "POST", redirect: "error", signal, body,
        headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json", "X-Client-Request-Id": clientRequestId, ...(contentType ? { "Content-Type": contentType } : {}) } });
    } catch (error) {
      throw new EngineProviderError(connectFailure(error) ? "retry" : "uncertain", null);
    }
    const providerRequestId = safeProviderRequestId(response.headers.get("x-request-id"));
    if (!response.ok && (RETRY_STATUSES.has(response.status) || UNCERTAIN_STATUSES.has(response.status))) {
      await response.body?.cancel().catch(() => {});
      throw new EngineProviderError(RETRY_STATUSES.has(response.status) ? "retry" : "uncertain", response.status, retryAfter(response.headers));
    }
    let reply: Awaited<ReturnType<typeof readLogoImageReply>>;
    try { reply = await readLogoImageReply(response, signal); }
    catch {
      // A refusal whose body we couldn't read is still a refusal; a success whose
      // body was cut off may have been drawn and charged.
      if (!response.ok) throw new EngineImageRejectedError(response.status, providerRequestId, 0);
      throw new EngineProviderError("uncertain", response.status);
    }
    const usage = logoImageReplyUsage(reply.value), costMicrousd = imageCostMicrousd(usage);
    if (!response.ok) throw new EngineImageRejectedError(response.status, providerRequestId, costMicrousd);
    try {
      if ((response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") throw new Error("Invalid media type");
      return { kind: "image", bytes: decodeLogoImageReply(reply.value), providerRequestId, responseHash: reply.hash, usage, costMicrousd };
    } catch {
      return { kind: "unusable", code: "invalid_output", providerRequestId, responseHash: reply.hash, usage, costMicrousd };
    }
  } };
}

let shared: EngineImages | null = null;
/** The engine's image client from OPENAI_API_KEY; a missing key is a configuration error. */
export function engineImages(): EngineImages {
  if (shared) return shared;
  const key = z.string().trim().min(16).max(500).regex(/^[^\s]+$/u).safeParse(process.env.OPENAI_API_KEY);
  if (!key.success) throw new Error("provider_unconfigured");
  shared = createEngineImages({ apiKey: key.data, origin: engineOpenAIOrigin() });
  return shared;
}
