import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createEngineOpenAI } from "../../src/server/engine/openai";
import { createEngineImages } from "../../src/server/engine/openai-images";
import { engineOpenAIOrigin, OPENAI_ORIGIN } from "../../src/server/engine/provider-origin";

const FAKE = "http://127.0.0.1:3176";

describe("engine OpenAI origin", () => {
  it("is exactly the official origin by default", () => {
    expect(OPENAI_ORIGIN).toBe("https://api.openai.com");
    expect(engineOpenAIOrigin({})).toBe("https://api.openai.com");
    expect(engineOpenAIOrigin({ EMBEL_OPENAI_BASE_URL: "" })).toBe("https://api.openai.com");
  });

  it("ignores the test override in production", () => {
    expect(engineOpenAIOrigin({ VERCEL_ENV: "production", EMBEL_OPENAI_BASE_URL: FAKE })).toBe("https://api.openai.com");
    // Even a value that would otherwise be refused cannot break or redirect production.
    expect(engineOpenAIOrigin({ VERCEL_ENV: "production", EMBEL_OPENAI_BASE_URL: "https://attacker.example" })).toBe("https://api.openai.com");
  });

  it("uses a loopback stand-in outside production", () => {
    expect(engineOpenAIOrigin({ EMBEL_OPENAI_BASE_URL: FAKE })).toBe(FAKE);
    expect(engineOpenAIOrigin({ EMBEL_OPENAI_BASE_URL: `${FAKE}/` })).toBe(FAKE);
    expect(engineOpenAIOrigin({ VERCEL_ENV: "preview", EMBEL_OPENAI_BASE_URL: "http://localhost:9000" })).toBe("http://localhost:9000");
  });

  it.each(["https://api.example.com", "http://10.0.0.5:3176", `${FAKE}/v1`, `${FAKE}?x=1`, "http://user:pw@127.0.0.1:3176", "ftp://127.0.0.1", "not a url"])(
    "refuses %s outside production", value => {
      expect(() => engineOpenAIOrigin({ EMBEL_OPENAI_BASE_URL: value })).toThrow("provider_unconfigured");
    });

  it("sends text and image requests to the given origin only", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: "resp_test1", status: "queued" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await createEngineOpenAI({ apiKey: "sk-test-0000000000000000", fetch: fetcher, origin: FAKE }).create({ model: "m", input: "hi" }, "key");
    await createEngineOpenAI({ apiKey: "sk-test-0000000000000000", fetch: fetcher }).retrieve("resp_test1");
    await createEngineImages({ apiKey: "sk-test-0000000000000000", fetch: fetcher, origin: FAKE }).draw({ prompt: "a mark", images: [] }, "req-1").catch(() => null);
    expect(urls[0]).toBe(`${FAKE}/v1/responses`);
    expect(urls[1]).toMatch(/^https:\/\/api\.openai\.com\/v1\/responses\/resp_test1\?/u);
    expect(urls[2]).toBe(`${FAKE}/v1/images/generations`);
  });
});
