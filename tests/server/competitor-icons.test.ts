import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { competitorIconHost, competitorIconHostOfUrl, createCompetitorIconFetcher, iconLinks, sniffIconType, type PinnedRequest, type PinnedResponse } from "../../src/server/competitor-icons";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const html = (head: string) => Buffer.from(`<!doctype html><html><head>${head}</head><body></body></html>`);
const publicAddress = [{ address: "93.184.216.34", family: 4 }];

function fetcher(pages: Record<string, PinnedResponse>, addresses: Record<string, { address: string; family: number }[]> = {}) {
  const requests: PinnedRequest[] = [];
  const fetch = createCompetitorIconFetcher({
    resolveHost: async host => addresses[host] ?? publicAddress,
    request: async input => { requests.push(input); return pages[input.url.href] ?? { status: 404, location: null, contentType: "text/plain", bytes: Buffer.alloc(0) }; },
  });
  return { fetch: (host: string) => fetch(host, new AbortController().signal), requests };
}

describe("competitor icons", () => {
  it("accepts only public DNS names", () => {
    expect(competitorIconHost("Example.COM")).toBe("example.com");
    for (const value of ["127.0.0.1", "localhost", "printer.local", "[::1]", "a..b", "-bad.com", "example", "x.internal"]) expect(competitorIconHost(value)).toBeNull();
    expect(competitorIconHostOfUrl("https://www.abelandcole.co.uk/veg")).toBe("www.abelandcole.co.uk");
    expect(competitorIconHostOfUrl("http://example.com")).toBeNull();
    expect(competitorIconHostOfUrl("https://user:pw@example.com")).toBeNull();
    expect(competitorIconHostOfUrl("https://example.com:8443")).toBeNull();
  });

  it("identifies raster images by their bytes and never accepts SVG", () => {
    expect(sniffIconType(png)).toBe("image/png");
    expect(sniffIconType(Buffer.concat([Buffer.from([0, 0, 1, 0, 1]), Buffer.alloc(16)]))).toBe("image/x-icon");
    expect(sniffIconType(svg)).toBeNull();
  });

  it("prefers declared touch icons and ignores SVG and insecure links", () => {
    const base = new URL("https://shop.example.org/");
    const links = iconLinks(`<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="icon" href="http://shop.example.org/plain.png">`, base);
    expect(links.map(url => url.pathname)).toEqual(["/touch.png", "/favicon-32.png"]);
  });

  it("fetches the declared icon from the competitor's own site", async () => {
    const { fetch } = fetcher({
      "https://shop.example.org/": { status: 200, location: null, contentType: "text/html; charset=utf-8", bytes: html('<link rel="apple-touch-icon" href="/touch.png">') },
      "https://shop.example.org/touch.png": { status: 200, location: null, contentType: "application/octet-stream", bytes: png },
    });
    await expect(fetch("shop.example.org")).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("refuses private addresses, including after a redirect", async () => {
    const privateHost = fetcher({}, { "shop.example.org": [{ address: "10.0.0.5", family: 4 }] });
    await expect(privateHost.fetch("shop.example.org")).resolves.toBeNull();
    expect(privateHost.requests).toHaveLength(0);
    const redirected = fetcher({
      "https://shop.example.org/": { status: 302, location: "https://internal.example.net/", contentType: "", bytes: Buffer.alloc(0) },
      "https://shop.example.org/favicon.ico": { status: 302, location: "https://internal.example.net/favicon.ico", contentType: "", bytes: Buffer.alloc(0) },
    }, { "internal.example.net": [{ address: "192.168.1.10", family: 4 }] });
    await expect(redirected.fetch("shop.example.org")).resolves.toBeNull();
    expect(redirected.requests.every(request => request.url.hostname === "shop.example.org")).toBe(true);
  });

  it("does not accept SVG served as a favicon", async () => {
    const { fetch } = fetcher({ "https://shop.example.org/favicon.ico": { status: 200, location: null, contentType: "image/x-icon", bytes: svg } });
    await expect(fetch("shop.example.org")).resolves.toBeNull();
  });
});
