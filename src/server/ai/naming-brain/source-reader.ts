import "server-only";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { boundedProviderWork } from "../../standalone-providers/bounded-request";

export const NAMING_REFERENCE_HOSTS = Object.freeze([
  "www.merriam-webster.com", "dictionary.cambridge.org", "en.wiktionary.org", "en.wikipedia.org", "www.britannica.com",
  "www.perseus.tufts.edu", "logeion.uchicago.edu", "www.cnrtl.fr",
] as const);
export const NAMING_REFERENCE_LIMITS = Object.freeze({ responseBytes: 262_144, textBytes: 16_384, textCharacters: 8_000, chunks: 2_048, deadlineMs: 15_000 });
export const NAMING_REFERENCE_EXTRACTOR = "embel-reference-text-v1";
export type ReferenceObservation = { sessionId: string; turnId: string; itemId: string; url: string; action: "open_page" | "find_in_page"; status: "completed" };
export type ReferencePageRequest = { url: string; hostname: string; address: string; family: 4 | 6; signal: AbortSignal };
type Address = { address: string; family: number };
type UnavailableCode = "source_not_allowed" | "source_unobserved" | "destination_not_public" | "unavailable" | "invalid_response" | "source_too_large" | "source_text_unavailable" | "cancelled" | "timeout";
export type NamingReferenceRead = { status: "unavailable"; code: UnavailableCode } | {
  status: "retrieved"; url: string; title: string; excerpt: string; contentHash: string; responseHash: string;
  retrievedAt: string; extractorVersion: typeof NAMING_REFERENCE_EXTRACTOR; truncated: boolean; observation: ReferenceObservation;
};

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** Deliberately conservative: no mapped IPv4, transition networks, scoped or non-global IPv6. */
export function isPublicReferenceAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

function allowedUrl(value: string): URL | null {
  if (typeof value !== "string" || value.length > 2_000 || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !NAMING_REFERENCE_HOSTS.some(host => host === url.hostname)) return null;
    const path = decodeURIComponent(url.pathname);
    if (/[\u0000-\u001f\u007f]/u.test(path)) return null;
    const host = url.hostname;
    const allowed = host === "www.merriam-webster.com" ? /^\/dictionary\/[^/]+\/?$/u.test(path)
      : host === "dictionary.cambridge.org" ? /^\/dictionary\/[a-z-]+\/[^/]+\/?$/u.test(path)
      : host === "en.wiktionary.org" || host === "en.wikipedia.org" ? path.startsWith("/wiki/") && !path.slice(6).includes(":")
      : host === "www.perseus.tufts.edu" ? path === "/hopper/text"
      : host === "logeion.uchicago.edu" ? /^\/[^/]+\/?$/u.test(path)
      : host === "www.cnrtl.fr" ? /^\/(definition|etymologie|lexicographie)\/[^/]+\/?$/u.test(path)
      : /^\/(topic|science|animal|plant|place|biography|art|event|technology|sports)\/[^/]+\/?$/u.test(path);
    if (!allowed) return null;
    if (host === "www.perseus.tufts.edu") {
      if (!url.searchParams.get("doc") || [...url.searchParams.keys()].some(key => !["doc", "lang", "highlight"].includes(key))) return null;
    } else if ([...url.searchParams.keys()].some(key => key !== "oldid" || !/^\d{1,20}$/.test(url.searchParams.get(key) ?? ""))) return null;
    url.hash = "";
    return url;
  } catch { return null; }
}

/** Connect directly to the validated IP; TLS verification and Host remain bound to the approved hostname. */
export async function requestPinnedReferencePage(input: ReferencePageRequest): Promise<Response> {
  const url = allowedUrl(input.url);
  if (!url || url.hostname !== input.hostname || isIP(input.address) !== input.family || !isPublicReferenceAddress(input.address)) throw new Error("invalid_reference_destination");
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: input.address, family: input.family, port: 443, servername: input.hostname,
      path: url.pathname + url.search, method: "GET", agent: false, signal: input.signal, rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(input.hostname, certificate),
      headers: { host: input.hostname, accept: "text/html, text/plain", "accept-encoding": "identity", "user-agent": "EmbelReferenceReader/1" },
    }, response => {
      if (input.signal.aborted) { response.destroy(); reject(new Error("cancelled")); return; }
      const headers = new Headers();
      for (const name of ["content-type", "content-length", "content-encoding", "location"]) {
        const value = response.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      try { resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers })); }
      catch { response.destroy(); reject(new Error("invalid_response")); }
    });
    request.on("error", () => reject(new Error("reference_transport")));
    request.end();
  });
}

type HtmlNode = DefaultTreeAdapterMap["node"];
const children = (node: HtmlNode): HtmlNode[] => "childNodes" in node ? node.childNodes : [];
const tag = (node: HtmlNode) => "tagName" in node ? node.tagName : "";
const ignored = new Set(["script", "style", "template", "nav", "header", "footer", "form", "button", "input", "select", "textarea", "iframe", "noscript", "svg"]);
function attr(node: HtmlNode, name: string): string | undefined { return "attrs" in node ? node.attrs.find(value => value.name === name)?.value : undefined; }
function textOf(node: HtmlNode): string {
  const result: string[] = [];
  const walk = (current: HtmlNode, depth: number) => {
    if (depth > 80 || ignored.has(tag(current)) || attr(current, "aria-hidden") === "true" || attr(current, "hidden") !== undefined) return;
    if (current.nodeName === "#text" && "value" in current) { result.push(current.value); return; }
    const block = /^(p|div|li|h[1-6]|section|article|main|br|dt|dd|tr)$/u.test(tag(current));
    if (block) result.push("\n");
    for (const child of children(current)) walk(child, depth + 1);
    if (block) result.push("\n");
  };
  walk(node, 0);
  return result.join("").replace(/[\t\r\f\v \u00a0]+/gu, " ").split("\n").map(line => line.trim()).filter(Boolean).join("\n");
}
function extractHtml(html: string): { title: string; text: string } | null {
  const document = parse(html, { scriptingEnabled: false });
  const nodes: HtmlNode[] = [];
  const queue: HtmlNode[] = [document];
  while (queue.length && nodes.length < 20_000) { const node = queue.shift()!; nodes.push(node); if (!ignored.has(tag(node))) queue.push(...children(node)); }
  if (queue.length) return null;
  const contentIds = new Set(["mw-content-text", "dictionary-entry-1", "article-content", "lexicontent", "centertext"]);
  const root = nodes.find(node => contentIds.has(attr(node, "id") ?? "")) ?? nodes.find(node => tag(node) === "article") ?? nodes.find(node => tag(node) === "main") ?? nodes.find(node => (attr(node, "class") ?? "").split(/\s+/u).includes("entry-body"));
  if (!root) return null;
  const text = textOf(root);
  if (text.length < 16) return null;
  const titleNode = nodes.find(node => tag(node) === "title") ?? nodes.find(node => tag(node) === "h1");
  return { title: titleNode ? textOf(titleNode).slice(0, 300) : "Reference", text };
}
function retainText(text: string): { excerpt: string; truncated: boolean } {
  let excerpt = "", bytes = 0;
  for (const character of text) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > NAMING_REFERENCE_LIMITS.textBytes || excerpt.length + character.length > NAMING_REFERENCE_LIMITS.textCharacters) break;
    bytes += next; excerpt += character;
  }
  return { excerpt, truncated: excerpt.length !== text.length };
}
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const unavailable = (code: UnavailableCode): NamingReferenceRead => ({ status: "unavailable", code });

export function createNamingReferenceReader(dependencies: {
  allowedHosts?: readonly string[];
  resolveHost?: (hostname: string) => Promise<Address[]>;
  requestPage?: (request: ReferencePageRequest) => Promise<Response>;
  now?: () => number;
} = {}) {
  const resolveHost = dependencies.resolveHost ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const requestPage = dependencies.requestPage ?? requestPinnedReferencePage;
  const now = dependencies.now ?? Date.now;
  const allowedHosts = new Set(dependencies.allowedHosts ?? NAMING_REFERENCE_HOSTS);
  if (!allowedHosts.size || [...allowedHosts].some(host => !NAMING_REFERENCE_HOSTS.some(allowed => allowed === host))) throw new Error("invalid_reference_policy");
  return { async read(input: { requestedUrl: string; observation: ReferenceObservation; signal: AbortSignal }): Promise<NamingReferenceRead> {
    const url = allowedUrl(input.requestedUrl);
    if (!url || !allowedHosts.has(url.hostname)) return unavailable("source_not_allowed");
    const observed = allowedUrl(input.observation.url);
    if (!observed || observed.href !== url.href || input.observation.status !== "completed" || !["open_page", "find_in_page"].includes(input.observation.action) || !input.observation.sessionId || !input.observation.turnId || !input.observation.itemId) return unavailable("source_unobserved");
    const result = await boundedProviderWork<NamingReferenceRead>(async child => {
      const addresses = await resolveHost(url.hostname);
      if (!addresses.length || addresses.length > 16 || addresses.some(value => isIP(value.address) !== value.family || !isPublicReferenceAddress(value.address))) return unavailable("destination_not_public");
      if (child.aborted) return unavailable("cancelled");
      const address = addresses[0]!;
      const response = await requestPage({ url: url.href, hostname: url.hostname, address: address.address, family: address.family as 4 | 6, signal: child });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => { if (reader) void reader.cancel().catch(() => {}); else void response.body?.cancel().catch(() => {}); };
      child.addEventListener("abort", cancel, { once: true });
      try {
        if (!response.ok || response.redirected || response.url && response.url !== url.href || response.status >= 300 && response.status < 400 || !response.body) return unavailable("unavailable");
        const media = response.headers.get("content-type") ?? "";
        if (!/^(text\/html|text\/plain)(?:\s*;|$)/iu.test(media) || /charset\s*=\s*(?!["']?utf-8(?:["']?\s*(?:;|$)))[^;]+/iu.test(media) || ![null, "identity"].includes(response.headers.get("content-encoding"))) return unavailable("invalid_response");
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/u.test(length) || Number(length) > NAMING_REFERENCE_LIMITS.responseBytes)) return unavailable("source_too_large");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        while (!child.aborted) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > NAMING_REFERENCE_LIMITS.responseBytes || chunks.length >= NAMING_REFERENCE_LIMITS.chunks) return unavailable("source_too_large"); chunks.push(chunk.value); }
        if (child.aborted) return unavailable("cancelled");
        const bytes = Buffer.concat(chunks, size);
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return unavailable("invalid_response"); }
        const extracted = /^text\/html/iu.test(media) ? extractHtml(text) : { title: url.hostname, text: text.trim() };
        if (!extracted?.text) return unavailable("source_text_unavailable");
        const retained = retainText(extracted.text);
        return { status: "retrieved" as const, url: url.href, title: extracted.title || url.hostname, ...retained, contentHash: digest(retained.excerpt), responseHash: digest(bytes),
          retrievedAt: new Date(now()).toISOString(), extractorVersion: NAMING_REFERENCE_EXTRACTOR, observation: { ...input.observation } };
      } finally { child.removeEventListener("abort", cancel); cancel(); try { reader?.releaseLock(); } catch {} }
    }, now, input.signal, NAMING_REFERENCE_LIMITS.deadlineMs);
    return result.status === "done" ? result.value : unavailable(result.code === "cancelled" || result.code === "timeout" ? result.code : "unavailable");
  } };
}
