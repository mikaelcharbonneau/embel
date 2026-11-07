import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { competitorIconHost, competitorIconHostOfUrl, createCompetitorIconFetcher, iconLinks, iconPixelSize, manifestIcons, pageIcons, sniffIconType, type PinnedRequest, type PinnedResponse } from "../../src/server/competitor-icons";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
/** A PNG header that declares its width and height. */
const sizedPng = (size: number, fill = 1) => { const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, fill)]); bytes.writeUInt32BE(size, 16); bytes.writeUInt32BE(size, 20); return bytes; };
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

  it("reads the pixel size of each icon format from its header", () => {
    expect(iconPixelSize(sizedPng(180), "image/png")).toBe(180);
    const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 2, 0]), Buffer.from([16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
    expect(iconPixelSize(ico, "image/x-icon")).toBe(256);
    const gif = Buffer.from("GIF89a\x30\x00\x20\x00\x00\x00", "latin1");
    expect(iconPixelSize(gif, "image/gif")).toBe(32);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x80, 0x00, 0xc0, 0x03]);
    expect(iconPixelSize(jpeg, "image/jpeg")).toBe(128);
    expect(iconPixelSize(Buffer.alloc(4), "image/png")).toBe(0);
  });

  it("finds the manifest and prefers its large, plain raster icons", () => {
    const base = new URL("https://shop.example.org/");
    expect(pageIcons('<link rel="manifest" href="/site.webmanifest">', base).manifest?.href).toBe("https://shop.example.org/site.webmanifest");
    const icons = manifestIcons(JSON.stringify({ icons: [
      { src: "/i-48.png", sizes: "48x48" }, { src: "/i-512-mask.png", sizes: "512x512", purpose: "maskable" },
      { src: "/i-192.png", sizes: "192x192", type: "image/png" }, { src: "/i.svg", sizes: "any", type: "image/svg+xml" }, { src: "http://shop.example.org/plain.png", sizes: "512x512" },
    ] }), new URL("https://shop.example.org/site.webmanifest"));
    expect(icons.map(url => url.pathname)).toEqual(["/i-192.png", "/i-48.png"]);
    expect(manifestIcons("not json", base)).toEqual([]);
  });

  it("keeps the sharpest icon instead of the first small one", async () => {
    const { fetch, requests } = fetcher({
      "https://shop.example.org/": { status: 200, location: null, contentType: "text/html", bytes: html('<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="manifest" href="/site.webmanifest">') },
      "https://shop.example.org/site.webmanifest": { status: 200, location: null, contentType: "application/manifest+json", bytes: Buffer.from(JSON.stringify({ icons: [{ src: "/icon-192.png", sizes: "192x192" }] })) },
      "https://shop.example.org/icon-192.png": { status: 200, location: null, contentType: "image/png", bytes: sizedPng(192, 2) },
      "https://shop.example.org/favicon-32.png": { status: 200, location: null, contentType: "image/png", bytes: sizedPng(32, 3) },
    });
    const icon = await fetch("shop.example.org");
    expect(icon && iconPixelSize(icon.bytes, icon.contentType)).toBe(192);
    expect(requests.map(request => request.url.pathname)).toEqual(["/", "/site.webmanifest", "/icon-192.png"]);
    // A site that only offers small icons still gets its largest one, from the conventional paths.
    const small = fetcher({
      "https://tiny.example.org/favicon.ico": { status: 200, location: null, contentType: "image/png", bytes: sizedPng(32, 4) },
      "https://tiny.example.org/apple-touch-icon.png": { status: 200, location: null, contentType: "image/png", bytes: sizedPng(16, 5) },
    });
    const fallback = await small.fetch("tiny.example.org");
    expect(fallback && iconPixelSize(fallback.bytes, fallback.contentType)).toBe(32);
  });

  it("does not accept SVG served as a favicon", async () => {
    const { fetch } = fetcher({ "https://shop.example.org/favicon.ico": { status: 200, location: null, contentType: "image/x-icon", bytes: svg } });
    await expect(fetch("shop.example.org")).resolves.toBeNull();
  });
});
