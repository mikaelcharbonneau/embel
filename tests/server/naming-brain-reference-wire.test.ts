import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { RequestOptions } from "node:https";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: wire.request }));
import { requestPinnedReferencePage } from "../../src/server/ai/naming-brain/source-reader";

describe("Naming pinned HTTPS boundary (inert socket)", () => {
  function responseFixture() {
    wire.request.mockImplementation((_options: RequestOptions, callback: (response: unknown) => void) => {
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = () => { const response = Readable.from([Buffer.from("reference fixture")]) as Readable & { headers: Record<string, string>; statusCode: number }; response.headers = { "content-type": "text/plain" }; response.statusCode = 200; callback(response); };
      return request;
    });
  }
  it("pins connection address while retaining approved Host and TLS hostname", async () => {
    responseFixture();
    const response = await requestPinnedReferencePage({ url: "https://www.merriam-webster.com/dictionary/ember", hostname: "www.merriam-webster.com", address: "93.184.216.34", family: 4, signal: new AbortController().signal });
    expect(await response.text()).toBe("reference fixture");
    const options = wire.request.mock.calls.at(-1)![0];
    expect(options).toMatchObject({ hostname: "93.184.216.34", servername: "www.merriam-webster.com", port: 443, family: 4, path: "/dictionary/ember", agent: false, rejectUnauthorized: true, method: "GET", headers: { host: "www.merriam-webster.com", "accept-encoding": "identity" } });
    expect(options.headers).not.toHaveProperty("authorization");
    expect(options.headers).not.toHaveProperty("cookie");
    expect(options.checkServerIdentity("93.184.216.34", { subjectaltname: "DNS:www.merriam-webster.com" })).toBeUndefined();
    expect(options.checkServerIdentity("93.184.216.34", { subjectaltname: "DNS:attacker.example" })).toBeInstanceOf(Error);
  });

  it("refuses unsafe direct helper inputs before constructing a socket", async () => {
    responseFixture(); wire.request.mockClear();
    await expect(requestPinnedReferencePage({ url: "https://www.merriam-webster.com/dictionary/ember", hostname: "www.merriam-webster.com", address: "127.0.0.1", family: 4, signal: new AbortController().signal })).rejects.toThrow("invalid_reference_destination");
    expect(wire.request).not.toHaveBeenCalled();
  });
});
