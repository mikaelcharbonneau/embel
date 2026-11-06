import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { isPublicReferenceAddress } from "./ai/naming-brain/source-reader";

/** A competitor's own site icon, fetched by the server so the browser never
 * contacts competitor sites. Every hop is HTTPS to a public address that is
 * resolved, checked and pinned before connecting; only small raster images are
 * accepted, identified by their bytes rather than the server's content type. */
export const COMPETITOR_ICON_LIMITS = Object.freeze({ pageBytes: 524_288, manifestBytes: 65_536, iconBytes: 262_144, redirects: 3, candidates: 4, attempts: 8, sharpPixels: 96, deadlineMs: 8_000 });

export type CompetitorIcon = { bytes: Buffer; contentType: string };
type Address = { address: string; family: number };
export type PinnedRequest = { url: URL; address: string; family: 4 | 6; accept: string; maxBytes: number; signal: AbortSignal };
export type PinnedResponse = { status: number; location: string | null; contentType: string; bytes: Buffer };
export type CompetitorIconDependencies = {
  resolveHost?: (hostname: string) => Promise<Address[]>;
  request?: (input: PinnedRequest) => Promise<PinnedResponse>;
};

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/u;

/** A bare public DNS name, never an address literal, port or credential. */
export function competitorIconHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/u, "");
  return HOST.test(host) && !isIP(host) && !/\.(local|localhost|internal|lan|home|arpa|test|invalid|example)$/u.test(host) ? host : null;
}

export function competitorIconHostOfUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") ? competitorIconHost(url.hostname) : null;
  } catch { return null; }
}

/** Identify the image by its leading bytes. SVG is never accepted: it can carry script. */
export function sniffIconType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && bytes[4]! > 0) return "image/x-icon";
  return null;
}

/** The icon's pixel size (its shorter side; for an .ico, its largest image), read
 * from the header bytes. 0 when unknown. Used only to prefer the sharpest icon. */
export function iconPixelSize(bytes: Buffer, type: string): number {
  const cap = (value: number) => Math.max(0, Math.min(value, 4096));
  try {
    if (type === "image/png") return bytes.length >= 24 ? cap(Math.min(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) : 0;
    if (type === "image/gif") return bytes.length >= 10 ? cap(Math.min(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) : 0;
    if (type === "image/x-icon") {
      let best = 0;
      for (let index = 0, count = Math.min(bytes.readUInt16LE(4), 64); index < count && 8 + 16 * index <= bytes.length; index += 1) {
        best = Math.max(best, Math.min(bytes[6 + 16 * index] || 256, bytes[7 + 16 * index] || 256));
      }
      return best;
    }
    if (type === "image/webp") {
      const chunk = bytes.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X" && bytes.length >= 30) return cap(Math.min(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)));
      if (chunk === "VP8L" && bytes.length >= 25) { const bits = bytes.readUInt32LE(21); return cap(Math.min((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)); }
      if (chunk === "VP8 " && bytes.length >= 30) return cap(Math.min(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff));
      return 0;
    }
    if (type === "image/jpeg") {
      for (let offset = 2; offset + 9 < bytes.length;) {
        if (bytes[offset] !== 0xff) return 0;
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) { offset += 1; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return cap(Math.min(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 7)));
        offset += 2 + bytes.readUInt16BE(offset + 2);
      }
    }
  } catch { return 0; }
  return 0;
}

function allowedUrl(raw: string, base?: URL): URL | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !competitorIconHost(url.hostname)) return null;
    url.hash = "";
    return url;
  } catch { return null; }
}

/** Connect to the checked address; TLS and Host stay bound to the hostname. */
async function pinnedRequest(input: PinnedRequest): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: input.address, family: input.family, port: 443, servername: input.url.hostname,
      path: input.url.pathname + input.url.search, method: "GET", agent: false, signal: input.signal, rejectUnauthorized: true,
      checkServerIdentity: (_host, certificate) => checkServerIdentity(input.url.hostname, certificate),
      headers: { host: input.url.hostname, accept: input.accept, "accept-encoding": "identity", "user-agent": "EmbelCompetitorIcon/1" },
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      const location = typeof response.headers.location === "string" ? response.headers.location : null;
      const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : "";
      const status = response.statusCode ?? 500;
      if (status >= 300 && status < 400) { response.destroy(); resolve({ status, location, contentType, bytes: Buffer.alloc(0) }); return; }
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") { response.destroy(); reject(new Error("encoded_response")); return; }
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > input.maxBytes) { response.destroy(); reject(new Error("too_large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, location, contentType, bytes: Buffer.concat(chunks, size) }));
      response.on("error", () => reject(new Error("transport")));
    });
    request.on("error", () => reject(new Error("transport")));
    request.end();
  });
}

export function createCompetitorIconFetcher(dependencies: CompetitorIconDependencies = {}) {
  const resolveHost = dependencies.resolveHost ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const send = dependencies.request ?? pinnedRequest;

  async function get(start: URL, accept: string, maxBytes: number, signal: AbortSignal): Promise<{ url: URL; response: PinnedResponse } | null> {
    let url: URL | null = start;
    for (let hop = 0; url && hop <= COMPETITOR_ICON_LIMITS.redirects; hop += 1) {
      const addresses = await resolveHost(url.hostname);
      if (!addresses.length || addresses.length > 16 || addresses.some(item => isIP(item.address) !== item.family || !isPublicReferenceAddress(item.address))) return null;
      if (signal.aborted) return null;
      const response = await send({ url, address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6, accept, maxBytes, signal });
      if (response.status >= 300 && response.status < 400) { url = response.location ? allowedUrl(response.location, url) : null; continue; }
      return response.status === 200 ? { url, response } : null;
    }
    return null;
  }

  async function image(url: URL, signal: AbortSignal): Promise<(CompetitorIcon & { pixels: number }) | null> {
    try {
      const result = await get(url, "image/png,image/x-icon,image/webp,image/jpeg,image/gif;q=0.9", COMPETITOR_ICON_LIMITS.iconBytes, signal);
      const contentType = result ? sniffIconType(result.response.bytes) : null;
      return result && contentType ? { bytes: result.response.bytes, contentType, pixels: iconPixelSize(result.response.bytes, contentType) } : null;
    } catch { return null; }
  }

  /** The web app manifest's own icons, which are usually the largest a site has. */
  async function manifest(url: URL, signal: AbortSignal): Promise<URL[]> {
    try {
      const result = await get(url, "application/manifest+json,application/json;q=0.9", COMPETITOR_ICON_LIMITS.manifestBytes, signal);
      return result ? manifestIcons(result.response.bytes.toString("utf8"), result.url) : [];
    } catch { return []; }
  }

  return async function fetchCompetitorIcon(host: string, signal: AbortSignal): Promise<CompetitorIcon | null> {
    const checked = competitorIconHost(host);
    if (!checked) return null;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(COMPETITOR_ICON_LIMITS.deadlineMs)]);
    const home = new URL(`https://${checked}/`);
    let page: { url: URL; response: PinnedResponse } | null = null;
    try { page = await get(home, "text/html", COMPETITOR_ICON_LIMITS.pageBytes, deadline); } catch { page = null; }
    const declared = page && /^text\/html/iu.test(page.response.contentType) ? pageIcons(page.response.bytes.toString("utf8"), page.url) : { icons: [], manifest: null };
    const fromManifest = declared.manifest && !deadline.aborted ? await manifest(declared.manifest, deadline) : [];
    // Largest first: manifest icons, declared icons, then the conventional touch icon and favicon.
    const origins = [...new Set([page?.url.origin, home.origin].filter((origin): origin is string => Boolean(origin)))];
    const candidates: URL[] = [];
    for (const candidate of [...fromManifest, ...declared.icons, ...origins.map(origin => new URL("/apple-touch-icon.png", origin)), ...origins.map(origin => new URL("/favicon.ico", origin))]) {
      if (!candidates.some(item => item.href === candidate.href)) candidates.push(candidate);
    }
    // Keep the sharpest icon found; stop as soon as one is large enough to stay crisp.
    let best: (CompetitorIcon & { pixels: number }) | null = null;
    for (const candidate of candidates.slice(0, COMPETITOR_ICON_LIMITS.attempts)) {
      if (deadline.aborted) break;
      const icon = await image(candidate, deadline);
      if (icon && (!best || icon.pixels > best.pixels)) best = icon;
      if (best && best.pixels >= COMPETITOR_ICON_LIMITS.sharpPixels) break;
    }
    return best && { bytes: best.bytes, contentType: best.contentType };
  };
}

type HtmlNode = DefaultTreeAdapterMap["node"];
const childNodes = (node: HtmlNode): HtmlNode[] => "childNodes" in node ? node.childNodes : [];
const attribute = (node: HtmlNode, name: string) => "attrs" in node ? node.attrs.find(item => item.name === name)?.value : undefined;

const declaredSize = (sizes: string | undefined) => Math.max(0, ...((sizes ?? "").match(/\d+/gu) ?? []).map(Number).filter(value => value <= 1024));

/** Declared icons, best first: touch icons are larger than favicons. */
export function iconLinks(html: string, base: URL): URL[] {
  return pageIcons(html, base).icons;
}

/** The page's declared icons, best first, and its web app manifest, if any. */
export function pageIcons(html: string, base: URL): { icons: URL[]; manifest: URL | null } {
  const found: { url: URL; score: number }[] = [];
  let manifest: URL | null = null;
  const visit = (node: HtmlNode, depth: number) => {
    if (depth > 64 || found.length > 32) return;
    if ("tagName" in node && node.tagName === "link") {
      const rel = (attribute(node, "rel") ?? "").toLowerCase().split(/\s+/u);
      const href = attribute(node, "href");
      if (href && !manifest && rel.includes("manifest")) manifest = allowedUrl(href, base);
      const type = (attribute(node, "type") ?? "").toLowerCase();
      if (href && rel.some(value => value === "icon" || value.startsWith("apple-touch-icon")) && !type.includes("svg") && !/\.svg(\?|$)/iu.test(href)) {
        const url = allowedUrl(href, base);
        const size = declaredSize(attribute(node, "sizes"));
        if (url) found.push({ url, score: (rel.some(value => value.startsWith("apple-touch-icon")) ? 400 : 0) + Math.min(size, 256) });
      }
    }
    for (const child of childNodes(node)) visit(child, depth + 1);
    if ("content" in node && node.content) for (const child of childNodes(node.content as HtmlNode)) visit(child, depth + 1);
  };
  visit(parse(html.slice(0, COMPETITOR_ICON_LIMITS.pageBytes)), 0);
  const icons = found.sort((a, b) => b.score - a.score).map(item => item.url)
    .filter((url, index, all) => all.findIndex(other => other.href === url.href) === index).slice(0, COMPETITOR_ICON_LIMITS.candidates);
  return { icons, manifest };
}

/** A web app manifest's raster icons, largest first. Maskable icons carry extra
 * padding and monochrome ones lose colour, so plain icons come first. */
export function manifestIcons(json: string, base: URL): URL[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const entries = parsed && typeof parsed === "object" && Array.isArray((parsed as { icons?: unknown }).icons) ? (parsed as { icons: unknown[] }).icons.slice(0, 32) : [];
  const found: { url: URL; score: number }[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { src, sizes, type, purpose } = entry as Record<string, unknown>;
    if (typeof src !== "string" || (typeof type === "string" && type.toLowerCase().includes("svg")) || /\.svg(\?|$)/iu.test(src)) continue;
    const purposes = typeof purpose === "string" ? purpose.toLowerCase().split(/\s+/u) : ["any"];
    if (!purposes.includes("any") && !purposes.includes("maskable")) continue;
    const url = allowedUrl(src, base);
    if (url) found.push({ url, score: Math.min(declaredSize(typeof sizes === "string" ? sizes : undefined), 512) - (purposes.includes("any") ? 0 : 1000) });
  }
  return found.sort((a, b) => b.score - a.score).map(item => item.url)
    .filter((url, index, all) => all.findIndex(other => other.href === url.href) === index).slice(0, 2);
}
