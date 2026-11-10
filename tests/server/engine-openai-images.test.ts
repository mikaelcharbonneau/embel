import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { syntheticPng } from "../features/logo-vector/raster-fixtures";
import { EngineProviderError } from "../../src/server/engine/openai";
import { createEngineImages, EngineImageRejectedError, ENGINE_LOGO_IMAGE, imageCostMicrousd } from "../../src/server/engine/openai-images";

// Synthetic Images API replies only; no live inference.
const usage = { input_tokens: 100, output_tokens: 6_000, total_tokens: 6_100, input_tokens_details: { text_tokens: 100, image_tokens: 0 } };
const reply = (bytes: Uint8Array, status = 200, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(bytes).toString("base64") }], usage, ...extra }),
  { status, headers: { "content-type": "application/json", "x-request-id": "req_synthetic" } });
function client(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return answer(); });
  return { calls, images: createEngineImages({ apiKey: "sk-synthetic-engine-images-key", fetch: fetch as unknown as typeof globalThis.fetch }) };
}
const draw = (images: ReturnType<typeof client>["images"]) => images.draw({ prompt: "Create exactly one original logo concept.", images: [] }, "logo-run-image.0-1");

describe("the engine's Logo image request", () => {
  it("is #212's request: gpt-image-2.6-sunburst at the highest quality on a transparent PNG", async () => {
    expect(ENGINE_LOGO_IMAGE).toEqual({ model: "gpt-image-2.6-sunburst", quality: "max", background: "transparent" });
    const png = syntheticPng(1024, 1024, () => [0, 0, 0, 255]);
    const { calls, images } = client(() => reply(png));
    const result = await draw(images);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: "gpt-image-2.6-sunburst", prompt: "Create exactly one original logo concept.", n: 1, output_format: "png",
      size: "1024x1024", quality: "max", background: "transparent", moderation: "auto" });
    expect(calls[0]!.init.headers).toMatchObject({ "X-Client-Request-Id": "logo-run-image.0-1" });
    expect(result).toMatchObject({ kind: "image", providerRequestId: "req_synthetic", costMicrousd: imageCostMicrousd(usage) });
    expect(imageCostMicrousd(usage)).toBe(100 * 5 + 6_000 * 30);
    expect(imageCostMicrousd(null)).toBe(0);
  });
  it.each([429, 500, 502, 503])("asks to retry a %i: nothing was drawn", async status => {
    const error = await draw(client(() => new Response("{}", { status, headers: { "retry-after": "3" } })).images).catch(caught => caught);
    expect(error).toBeInstanceOf(EngineProviderError);
    expect(error).toMatchObject({ disposition: "retry", retryAfterMs: 3_000 });
  });
  it("asks to retry when no connection was ever made", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    await expect(draw(client(() => { throw refused; }).images)).rejects.toMatchObject({ disposition: "retry" });
  });
  it.each([408, 409, 504])("treats a %i as an unknown outcome, never to be sent again", async status => {
    await expect(draw(client(() => new Response("{}", { status })).images)).rejects.toMatchObject({ disposition: "uncertain" });
  });
  it("treats a dropped connection after sending as an unknown outcome", async () => {
    await expect(draw(client(() => { throw new TypeError("terminated"); }).images)).rejects.toMatchObject({ disposition: "uncertain" });
  });
  it("reports a refusal with the usage it carried", async () => {
    const error = await draw(client(() => new Response(JSON.stringify({ error: { code: "moderation_blocked" }, usage }), { status: 400, headers: { "x-request-id": "req_refused" } })).images).catch(caught => caught);
    expect(error).toBeInstanceOf(EngineImageRejectedError);
    expect(error).toMatchObject({ disposition: "rejected", providerRequestId: "req_refused", costMicrousd: imageCostMicrousd(usage) });
  });
  it("keeps a paid reply without a readable image as unusable, not as a retry", async () => {
    const result = await draw(client(() => new Response(JSON.stringify({ data: [], usage }), { headers: { "content-type": "application/json" } })).images);
    expect(result).toMatchObject({ kind: "unusable", code: "invalid_output", costMicrousd: imageCostMicrousd(usage) });
  });
});
