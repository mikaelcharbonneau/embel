import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOpenAIImageTransport, IMAGE_INPUT_LIMITS, type OpenAIImageRequest } from "../../src/server/logo-creation/openai-image-transport";
import { IMAGE_MODEL } from "../../src/domain/providers";
import type { VerifiedAssetBytes } from "../../src/domain/logo-deliverables";
let png: Uint8Array<ArrayBuffer>;
beforeAll(async () => { png = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()); });
const usage = { input_tokens: 50, output_tokens: 25, input_tokens_details: { text_tokens: 10, image_tokens: 40 } };
const request = (images: VerifiedAssetBytes[] = []): OpenAIImageRequest => ({ model: IMAGE_MODEL, prompt: "Synthetic original black and white logo", size: "1024x1024", quality: "medium", images });
const response = (data: unknown = { data: [{ b64_json: Buffer.from(png).toString("base64") }], usage }) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "x-request-id": "req_observed" } });
function image(): VerifiedAssetBytes {
  const hash = createHash("sha256").update(png).digest("hex"), id = "00000000-0000-4000-8000-000000000001";
  return { reference: { ownerId: id, projectId: id, assetId: id, versionId: id, contentHash: hash }, bytes: png, mimeType: "image/png",
    verification: { status: "verified", checkedAt: "2026-10-06T12:00:00Z", contentHash: hash, mimeType: "image/png", byteLength: png.length } };
}

describe("bounded Images API transport with mocked network only", () => {
  it("pins one PNG generation and diagnostic identity without default retries or external idempotency claims", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const transport = createOpenAIImageTransport({ apiKey: "synthetic-credential", fetch: fetcher });
    const result = await transport.createImage(request(), "saved-attempt-trace", new AbortController().signal);
    expect(result).toMatchObject({ bytes: png, mimeType: "image/png", usage, providerRequestId: "req_observed" });
    expect(result.responseHash).toMatch(/^[a-f0-9]{64}$/); expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/generations"); expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ model: IMAGE_MODEL, prompt: request().prompt, n: 1, output_format: "png", size: "1024x1024", quality: "medium", background: "opaque", moderation: "auto" });
    expect(init?.headers).toHaveProperty("X-Client-Request-Id", "saved-attempt-trace"); expect(init?.headers).not.toHaveProperty("Idempotency-Key");
  });
  it("sends exact verified reference bytes as multipart images without response_format or input_fidelity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request([image()]), "saved-attempt", new AbortController().signal);
    const [url, init] = fetcher.mock.calls[0]!, form = init?.body as FormData;
    expect(url).toBe("https://api.openai.com/v1/images/edits"); expect(form.get("model")).toBe(IMAGE_MODEL);
    expect(form.get("n")).toBe("1"); expect(form.get("output_format")).toBe("png"); expect(form.has("response_format")).toBe(false); expect(form.has("input_fidelity")).toBe(false);
    const file = form.getAll("image[]")[0] as File; expect(new Uint8Array(await file.arrayBuffer())).toEqual(png); expect(file.type).toBe("image/png");
  });
  it.each([400, 401, 403, 404, 413, 422, 429])("retains definite HTTP %s rejection without claiming free billing", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_MESSAGE" } }), { status, headers: { "content-type": "application/json", "x-request-id": "req_rejected" } }));
    await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected", usage: null, providerRequestId: "req_rejected", message: "request_rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([408, 409, 500, 502, 503])("preserves uncertain HTTP %s without retries", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private error", { status }));
    await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("a hanging response body after headers aborts with its original provider ID", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 10); } }), { headers: { "content-type": "application/json", "x-request-id": "req_observed" } }));
    await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", controller.signal)).rejects.toMatchObject({ code: "outcome_unknown", providerRequestId: "req_observed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    () => ({ data: [{ url: "https://untrusted.example/image.png" }] }),
    () => ({ data: [{ b64_json: "!!!!" }] }),
    () => ({ data: [{ b64_json: "AAAA" }] }),
    () => ({ data: [{ b64_json: Buffer.from(png).toString("base64") }, { b64_json: Buffer.from(png).toString("base64") }] }),
    () => ({ data: [{ b64_json: Buffer.from(png).toString("base64"), url: "https://untrusted.example/image.png" }] }),
  ])("rejects invalid output without fetching external URLs or retrying", async data => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(data()));
    await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal)).rejects.toMatchObject({ code: "invalid_response", providerRequestId: "req_observed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds advertised and actual response lengths", async () => {
    for (const result of [new Response("{}", { headers: { "content-type": "application/json", "content-length": String(IMAGE_INPUT_LIMITS.responseBytes + 1) } }), new Response(" ".repeat(IMAGE_INPUT_LIMITS.responseBytes + 1), { headers: { "content-type": "application/json" } })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result);
      await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal)).rejects.toMatchObject({ code: "invalid_response" }); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("snapshots Buffer-backed reference bytes before decoding yields", async () => {
    const original = Buffer.from(png), source = { ...image(), bytes: original };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const attempt = createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request([source]), "trace", new AbortController().signal);
    original.fill(0);
    await attempt;
    const form = fetcher.mock.calls[0]![1]!.body as FormData, sent = form.get("image[]") as File;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(png);
    expect(new Uint8Array(await sent.arrayBuffer())).not.toEqual(original);
  });
  it("valid output without usage preserves bytes and unknown usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ b64_json: Buffer.from(png).toString("base64") }] }));
    const result = await createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal);
    expect(result.bytes).toEqual(png); expect(result.usage).toBeNull();
  });
  it("retains consistent optional totals and image-only output details for billing", async () => {
    const completeUsage = { ...usage, total_tokens: 75, output_tokens_details: { text_tokens: 0, image_tokens: 25 } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ b64_json: Buffer.from(png).toString("base64") }], usage: completeUsage }));
    const result = await createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal);
    expect(result.usage).toEqual(completeUsage);
  });
  it.each([
    { ...usage, total_tokens: 74 },
    { ...usage, total_tokens: null },
    { ...usage, total_tokens: 75.5 },
    { ...usage, output_tokens_details: { text_tokens: 1, image_tokens: 24 } },
    { ...usage, output_tokens_details: { text_tokens: 0, image_tokens: 24 } },
    { ...usage, output_tokens_details: { image_tokens: 25 } },
    { ...usage, output_tokens_details: null },
  ])("contradictory or malformed optional usage stays unknown while retaining valid bytes (%j)", async invalidUsage => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ b64_json: Buffer.from(png).toString("base64") }], usage: invalidUsage }));
    const result = await createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal);
    expect(result.bytes).toEqual(png); expect(result.usage).toBeNull();
    expect(result.providerRequestId).toBe("req_observed"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("validates optional usage before retaining a private HTTP error observation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_MESSAGE" }, usage: { ...usage, total_tokens: 999 } }), { status: 429, headers: { "content-type": "application/json", "x-request-id": "req_rejected" } }));
    await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected", usage: null, providerRequestId: "req_rejected", message: "request_rejected" });
  });
  it("rejects invalid model, reference count, renamed HTML, corrupted hashes and pre-abort before dispatch", async () => {
    const invalids = [ { ...request(), model: "other-model" }, request([image(), image(), image(), image(), image()]), request([{ ...image(), bytes: new TextEncoder().encode("<svg/>") }]), request([{ ...image(), reference: { ...image().reference, contentHash: "a".repeat(64) } }]) ];
    const fetcher = vi.fn<typeof fetch>();
    for (const invalid of invalids) await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(invalid as OpenAIImageRequest, "trace", new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    await expect(createOpenAIImageTransport({ apiKey: "synthetic", fetch: fetcher }).createImage(request(), "trace", AbortSignal.abort())).rejects.toMatchObject({ code: "request_rejected" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
