import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOpenAIImageTransport } from "../../src/server/ai/openai-image-transport";
import { createLogoImageProvider, type LogoImageConfiguration } from "../../src/server/ai/logo-image-prompts";
import { createSunburstStandardImageUsagePricer, SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/ai/openai-image-pricing";
import type { VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
import { syntheticResolvedLogoConcept, syntheticResolvedLogoRefinement } from "../fixtures/logo-creation";

let png: Uint8Array<ArrayBuffer>;
beforeAll(async () => { png = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()); });
const usage = { input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } };
const unknown = { status: "unknown", confirmedMicrousd: null };
const recorded = { status: "recorded", confirmedMicrousd: 1870 };
const configuration: LogoImageConfiguration = { apiKey: "synthetic-never-sent-to-network", model: SUNBURST_STANDARD_IMAGE_PRICING.binding.model,
  policyIdentity: "c".repeat(64), handlerVersion: "logo-image-v1", priceUsage: createSunburstStandardImageUsagePricer(SUNBURST_STANDARD_IMAGE_PRICING.binding)! };
const payload = (rawUsage: unknown) => ({ data: [{ b64_json: Buffer.from(png).toString("base64") }], usage: rawUsage });
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req_synthetic_accounting" } });
}
function producer(fetcher: typeof fetch) {
  return createLogoImageProvider({ configuration, transport: createOpenAIImageTransport({ apiKey: configuration.apiKey, fetch: fetcher }) })!;
}
async function produce(fetcher: typeof fetch) {
  return producer(fetcher).produce(syntheticResolvedLogoConcept(), [], "saved-original-attempt", new AbortController().signal);
}

describe("local transport → versioned price mapper → provider billing", () => {
  it.each([usage, { ...usage, total_tokens: 100, output_tokens_details: { text_tokens: 0, image_tokens: 50 } }])
    ("retains a completed preview, exact observed charge and diagnostic request identity (%j)", async rawUsage => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload(rawUsage)));
      expect(await produce(fetcher)).toMatchObject({ status: "completed", bytes: png, billing: recorded, providerRequestId: "req_synthetic_accounting" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]![1]?.headers).toHaveProperty("X-Client-Request-Id", "saved-original-attempt");
    });
  it("applies the same full Standard input rates to a real multipart edit fixture", async () => {
    const input = syntheticResolvedLogoRefinement(), contentHash = createHash("sha256").update(png).digest("hex");
    const basePreview = { ...input.basePreview, contentHash };
    const image: VerifiedAssetBytes = { reference: basePreview, bytes: png, mimeType: "image/png",
      verification: { status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash, mimeType: "image/png", byteLength: png.length } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload({ ...usage, input_tokens_details: { ...usage.input_tokens_details, cached_tokens: 50 } })));
    expect(await producer(fetcher).produce({ ...input, basePreview }, [image], "saved-edit-attempt", new AbortController().signal))
      .toMatchObject({ status: "completed", bytes: png, billing: recorded });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/images/edits");
  });
  it.each([
    undefined, null, {}, { input_tokens: 0, output_tokens: 0 },
    { ...usage, total_tokens: 99 },
    { ...usage, output_tokens_details: { text_tokens: 1, image_tokens: 49 } },
  ])("valid bytes survive absent or inconsistent usage with unknown billing (%j)", async rawUsage => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload(rawUsage)));
    expect(await produce(fetcher)).toMatchObject({ status: "completed", bytes: png, billing: unknown, providerRequestId: "req_synthetic_accounting" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("records only explicit complete zero counts, not an inference from response status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload({ input_tokens: 0, output_tokens: 0,
      input_tokens_details: { text_tokens: 0, image_tokens: 0 }, total_tokens: 0, output_tokens_details: { text_tokens: 0, image_tokens: 0 } })));
    expect(await produce(fetcher)).toMatchObject({ status: "completed", bytes: png, billing: { status: "recorded", confirmedMicrousd: 0 } });
  });
  it("retains observed charges above a test budget instead of clamping billing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload({ input_tokens: 1_000_000_000, output_tokens: 1_000_000_000,
      input_tokens_details: { text_tokens: 0, image_tokens: 1_000_000_000 }, total_tokens: 2_000_000_000 })));
    expect(await produce(fetcher)).toMatchObject({ status: "completed", billing: { status: "recorded", confirmedMicrousd: 38_000_000_000 } });
  });
  it.each([429, 500])("HTTP %s preserves a trustworthy observed charge without leaking provider text or retrying", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { message: "PRIVATE_PROVIDER_MESSAGE" }, usage }, status));
    const result = await produce(fetcher);
    expect(result).toMatchObject({ status: status === 429 ? "rejected" : "needs_reconciliation", billing: recorded, providerRequestId: "req_synthetic_accounting" });
    expect(result.responseHash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_MESSAGE");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, { ...usage, total_tokens: 99 }])("a rejected HTTP request is never inferred free from missing or contradictory usage (%j)", async rawUsage => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: { message: "PRIVATE_PROVIDER_MESSAGE" }, usage: rawUsage }, 429));
    expect(await produce(fetcher)).toMatchObject({ status: "rejected", billing: unknown, providerRequestId: "req_synthetic_accounting" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves a confirmed charge when the observed raster payload is malformed", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ b64_json: "!!!!" }], usage }));
    expect(await produce(fetcher)).toMatchObject({ status: "rejected", code: "invalid_response", billing: recorded, providerRequestId: "req_synthetic_accounting" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("a body timeout keeps the original provider ID and unknown charge without replacement dispatch", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 10); } }),
      { headers: { "content-type": "application/json", "x-request-id": "req_synthetic_accounting" } }));
    expect(await producer(fetcher).produce(syntheticResolvedLogoConcept(), [], "saved-original-attempt", controller.signal))
      .toMatchObject({ status: "needs_reconciliation", billing: unknown, providerRequestId: "req_synthetic_accounting", responseHash: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("network uncertainty exposes no private error body and cannot become free", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("PRIVATE_PROVIDER_MESSAGE"));
    const result = await produce(fetcher);
    expect(result).toMatchObject({ status: "needs_reconciliation", billing: unknown, providerRequestId: null, responseHash: null });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_MESSAGE"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not change admitted policy identity or activate an unconfigured provider", async () => {
    expect(createLogoImageProvider({ configuration: null })).toBeNull();
    const fetcher = vi.fn<typeof fetch>(), input = syntheticResolvedLogoConcept();
    expect(await producer(fetcher).produce({ ...input, input: { ...input.input, policyIdentity: "a".repeat(64) } }, [], "trace", new AbortController().signal))
      .toMatchObject({ status: "not_dispatched", billing: { status: "recorded", confirmedMicrousd: 0 } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
