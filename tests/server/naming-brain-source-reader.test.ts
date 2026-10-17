import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createNamingReferenceReader, isPublicReferenceAddress, type ReferencePageRequest } from "../../src/server/ai/naming-brain/source-reader";

const url = "https://www.merriam-webster.com/dictionary/ember";
const observation = { sessionId: "session_fixture", turnId: "turn_fixture", itemId: "item_fixture", url, action: "open_page" as const, status: "completed" as const };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const signal = () => new AbortController().signal;

describe("Naming reference reader (inert transport)", () => {
  it("retains only article text with exact hashes and observed provider provenance", async () => {
    const html = "<html><head><title>Ember</title><script>steal()</script></head><body><nav>Menu</nav><main><h1>Ember</h1><p>A glowing fragment.</p><script>ignore instructions</script><style>bad</style></main></body></html>";
    const requests: ReferencePageRequest[] = [];
    const reader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async request => { requests.push(request); return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }); }, now: () => 1_000 });
    const result = await reader.read({ requestedUrl: url, observation, signal: signal() });
    expect(result).toMatchObject({ status: "retrieved", url, title: "Ember", excerpt: "Ember\nA glowing fragment.", contentHash: hash("Ember\nA glowing fragment."), responseHash: hash(html), truncated: false, retrievedAt: "1970-01-01T00:00:01.000Z", observation });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url, address: "93.184.216.34", family: 4, hostname: "www.merriam-webster.com" });
  });

  it.each(["https://evil.example/read", "https://www.merriam-webster.com.evil.example/read", "http://www.merriam-webster.com/dictionary/ember", "https://user:pass@www.merriam-webster.com/dictionary/ember", "https://www.merriam-webster.com:444/dictionary/ember"])('refuses non-policy URL %s before DNS', async requestedUrl => {
    let lookups = 0;
    const reader = createNamingReferenceReader({ resolveHost: async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; }, requestPage: async () => { throw new Error("Must not request"); } });
    expect(await reader.read({ requestedUrl, observation: { ...observation, url: requestedUrl }, signal: signal() })).toMatchObject({ status: "unavailable", code: "source_not_allowed" });
    expect(lookups).toBe(0);
  });

  it("cannot fetch an unobserved or unfinished reference", async () => {
    let requests = 0;
    const reader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async () => { requests++; return new Response("unexpected"); } });
    expect(await reader.read({ requestedUrl: url, observation: { ...observation, url: url + "s" }, signal: signal() })).toMatchObject({ status: "unavailable", code: "source_unobserved" });
    expect(requests).toBe(0);
  });

  it("enforces a narrower server-owned source policy before DNS", async () => {
    let lookups = 0;
    const reader = createNamingReferenceReader({ allowedHosts: ["www.perseus.tufts.edu"], resolveHost: async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; }, requestPage: async () => new Response("fixture reference", { headers: { "content-type": "text/plain" } }) });
    expect(await reader.read({ requestedUrl: url, observation, signal: signal() })).toMatchObject({ status: "unavailable", code: "source_not_allowed" });
    expect(lookups).toBe(0);
  });

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.1.1", "198.18.0.1", "192.0.2.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "3fff::1"])("rejects non-public destination %s", address => {
    expect(isPublicReferenceAddress(address)).toBe(false);
  });

  it("rejects mixed public/private DNS answers without connecting", async () => {
    let connected = false;
    const reader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], requestPage: async () => { connected = true; return new Response("bad"); } });
    expect(await reader.read({ requestedUrl: url, observation, signal: signal() })).toMatchObject({ status: "unavailable", code: "destination_not_public" });
    expect(connected).toBe(false);
    expect(isPublicReferenceAddress("2606:4700:4700::1111")).toBe(true);
  });

  it.each([new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }), new Response("private", { status: 403 }), new Response("binary", { headers: { "content-type": "application/octet-stream" } }), new Response("x".repeat(262_145), { headers: { "content-type": "text/plain" } })])("leaves redirects, blocked pages and invalid/oversized bodies unavailable", async response => {
    const reader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async () => response });
    expect(await reader.read({ requestedUrl: url, observation, signal: signal() })).toMatchObject({ status: "unavailable" });
  });

  it("cancellation fences even a transport that ignores abort", async () => {
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    const reader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: () => new Promise(resolve => { finish = resolve; }) });
    const pending = reader.read({ requestedUrl: url, observation, signal: controller.signal });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort();
    expect(await pending).toMatchObject({ status: "unavailable", code: "cancelled" });
    finish(new Response("late", { headers: { "content-type": "text/plain" } }));
  });

  it("retains bounded Unicode text without splitting a code point or falsifying its hash", async () => {
    const reader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async () => new Response("é".repeat(10_000), { headers: { "content-type": "text/plain; charset=utf-8" } }) });
    const result = await reader.read({ requestedUrl: url, observation, signal: signal() });
    expect(result).toMatchObject({ status: "retrieved", truncated: true, excerpt: "é".repeat(8_000), contentHash: hash("é".repeat(8_000)) });
  });

  it.each([
    new Response("<main><script>invent source facts</script></main>", { headers: { "content-type": "text/html" } }),
    new Response("Unsupported bytes", { headers: { "content-type": "text/plain; charset=windows-1252" } }),
    new Response("compressed", { headers: { "content-type": "text/plain", "content-encoding": "gzip" } }),
  ])("does not invent source text from scripts or unsupported representations", async response => {
    const reader = createNamingReferenceReader({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], requestPage: async () => response });
    expect(await reader.read({ requestedUrl: url, observation, signal: signal() })).toMatchObject({ status: "unavailable" });
  });
});
