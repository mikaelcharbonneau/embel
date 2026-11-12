#!/usr/bin/env node
// Inventories the visual assets on each route at 390, 768 and 1440: <img>/<picture>, CSS background images,
// inline <svg>, <video>/<canvas>, favicon/app icons and og:/twitter: images. Read-only: it only opens pages.
//
//   node design-audit/scan-assets.mjs [outDir]       (default design-audit/evidence/assets/)
//
// Output: assets.json (every record) and assets.md (readable tables). File weight comes from the network
// responses seen while the page loaded (transferred body size); data: URIs count their own length.
// Local only. Needs the audit stack, a seed and saved sessions in design-audit/.auth/ (run capture.mjs first).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.AUDIT_ORIGIN ?? "http://127.0.0.1:3105";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/u.test(ORIGIN)) throw new Error("Refusing to run: local app only.");
const outDir = path.resolve(process.argv[2] ?? path.join(HERE, "evidence/assets"));
mkdirSync(outDir, { recursive: true });
const seeded = JSON.parse(readFileSync(path.join(HERE, ".logs/last-seed.json"), "utf8")).results;
const id = (key) => seeded.find((r) => r.key === key).projectId;
const WIDTHS = [390, 768, 1440];
const HEIGHT = { 390: 844, 768: 1024, 1440: 900 };

// [route label, account, path, matching screenshot stem (in evidence/screens/)]
const PAGES = [
  ["/ (signed out)", null, "/", "home__signed-out"],
  ["/sign-in", null, "/sign-in", "sign-in__default"],
  ["/sign-up", null, "/sign-up", "sign-up__default"],
  ["/forgot-password", null, "/forgot-password", "forgot-password__default"],
  ["/reset-password", null, "/reset-password", "reset-password__no-recovery-session"],
  ["/this-page-does-not-exist (404)", null, "/this-page-does-not-exist", "not-found__default"],
  ["/ (new account)", "audit-fresh", "/", "home__empty-fresh"],
  ["/brands (empty)", "audit-fresh", "/brands", "projects__empty-fresh"],
  ["/assets (empty)", "audit-fresh", "/assets", "library__empty-fresh"],
  ["/ (with brands)", "audit-pro", "/", "home__recent-brands-pro"],
  ["/brands (3 brands)", "audit-pro", "/brands", "projects__three-brands-pro"],
  ["/assets (kept assets)", "audit-pro", "/assets", "library__kept-assets-pro"],
  ["/plans", "audit-pro", "/plans", "plans__pro-current-pro"],
  ["/settings", "audit-pro", "/settings", "settings__account-pro"],
  [
    "/brands/account/<id> (Kestrel, complete)",
    "audit-pro",
    `/brands/account/${id("kestrel")}?view=strategy`,
    "brand-conversation__kestrel-complete-showcase-pro",
  ],
  [
    "…/logo/deliverables (Kestrel)",
    "audit-pro",
    `/brands/account/${id("kestrel")}/logo/deliverables`,
    "brand-assets__kestrel-ready-pro",
  ],
  ["…/identity (Kestrel)", "audit-pro", `/brands/account/${id("kestrel")}/identity`, "brand-identity__kestrel-pro"],
  [
    "/brands/account/<id> (Quill, six logos)",
    "audit-free",
    `/brands/account/${id("quill")}?view=strategy`,
    "brand-conversation__quill-logos-generated-free",
  ],
  [
    "/brands/account/<id> (Mosswood, directions)",
    "audit-free",
    `/brands/account/${id("mosswood")}?view=strategy`,
    "brand-conversation__mosswood-directions-generated-free",
  ],
];

/** Runs inside the page. Returns plain records (no DOM nodes). */
function scan() {
  const label = (el) => {
    const hit = el.closest(
      "button, a, summary, [role=button], [aria-label], h1, h2, h3, li, section, article, header, nav, main",
    );
    if (!hit) return el.tagName.toLowerCase();
    const text = hit.getAttribute("aria-label") ?? (hit.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${hit.tagName.toLowerCase()}${hit.getAttribute("role") ? `[role=${hit.getAttribute("role")}]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden",
    };
  };
  const out = [];
  for (const img of document.images)
    out.push({
      kind: img.closest("picture") ? "picture/img" : "img",
      where: label(img),
      src: img.currentSrc || img.src,
      alt: img.hasAttribute("alt") ? (img.alt === "" ? 'alt=""' : `"${img.alt}"`) : "missing",
      natural: img.complete ? `${img.naturalWidth}x${img.naturalHeight}` : "not loaded",
      rendered: box(img),
      loading: img.getAttribute("loading") ?? "-",
      fetchpriority: img.getAttribute("fetchpriority") ?? "-",
      decoding: img.getAttribute("decoding") ?? "-",
      srcset: img.getAttribute("srcset") ? "yes" : "-",
    });
  const svgs = new Map();
  for (const svg of document.querySelectorAll("svg")) {
    const b = box(svg);
    const key = `${svg.getAttribute("viewBox") ?? "-"}|${b.w}x${b.h}|${svg.getAttribute("aria-hidden") ?? "-"}|${svg.getAttribute("role") ?? "-"}`;
    const entry = svgs.get(key) ?? {
      kind: "inline svg",
      count: 0,
      where: [],
      viewBox: svg.getAttribute("viewBox") ?? "-",
      rendered: b,
      ariaHidden: svg.getAttribute("aria-hidden") ?? "-",
      role: svg.getAttribute("role") ?? "-",
      title: svg.querySelector("title")?.textContent ?? "-",
      paths: svg.querySelectorAll("path,circle,rect,line,polyline").length,
    };
    entry.count++;
    if (entry.where.length < 3) entry.where.push(label(svg));
    svgs.set(key, entry);
  }
  out.push(...svgs.values());
  const bg = new Map();
  for (const el of document.querySelectorAll("body *")) {
    for (const pseudo of [null, "::before", "::after"]) {
      const v = getComputedStyle(el, pseudo).backgroundImage;
      if (!v || v === "none") continue;
      const urls = [...v.matchAll(/url\(["']?(.*?)["']?\)/g)].map((m) => m[1]);
      const gradient = /gradient/.test(v);
      const keyed = `${urls.join(",") || v.slice(0, 60)}|${pseudo}`;
      const entry = bg.get(keyed) ?? {
        kind: urls.length ? "css background-image" : "css gradient",
        count: 0,
        where: [],
        src:
          urls.map((u) => (u.startsWith("data:") ? `data:${u.slice(5, 24)}… (${u.length} chars)` : u)).join(", ") ||
          v.slice(0, 80),
        rendered: box(el),
        pseudo: pseudo ?? "-",
        gradient,
      };
      entry.count++;
      if (entry.where.length < 2) entry.where.push(label(el));
      bg.set(keyed, entry);
    }
  }
  out.push(...bg.values());
  for (const el of document.querySelectorAll("video, canvas, object, embed, iframe, lottie-player, dotlottie-player"))
    out.push({ kind: el.tagName.toLowerCase(), where: label(el), rendered: box(el) });
  const head = [];
  for (const el of document.querySelectorAll(
    'link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"], meta[property^="og:image"], meta[name="twitter:image"], meta[name="twitter:card"], meta[property="og:type"]',
  ))
    head.push({
      tag: el.tagName.toLowerCase(),
      rel: el.getAttribute("rel") ?? el.getAttribute("property") ?? el.getAttribute("name"),
      href: el.getAttribute("href") ?? el.getAttribute("content"),
      sizes: el.getAttribute("sizes") ?? "-",
      type: el.getAttribute("type") ?? "-",
    });
  return { assets: out, head };
}

const browser = await launchBrowser();
const records = [];
for (const [route, account, url, screen] of PAGES) {
  for (const width of WIDTHS) {
    const file = path.join(HERE, ".auth", `${account}.json`);
    const context = await browser.newContext({
      baseURL: ORIGIN,
      viewport: { width, height: HEIGHT[width] },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      ...(account && existsSync(file) ? { storageState: file } : {}),
    });
    const page = await context.newPage();
    const weights = new Map();
    page.on("response", async (r) => {
      try {
        const type = r.request().resourceType();
        if (!["image", "media", "font", "other", "fetch"].includes(type)) return;
        const body = await r.body();
        weights.set(r.url(), { bytes: body.length, type: r.headers()["content-type"] ?? "" });
      } catch {}
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      if (account) await page.getByLabel("Account menu").first().waitFor({ timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(3500);
      // Scroll every tall container so lazy images load, then return to the top.
      await page.evaluate(async () => {
        const tall = [...document.querySelectorAll("body *")].filter(
          (e) => e.scrollHeight > e.clientHeight + 40 && ["auto", "scroll"].includes(getComputedStyle(e).overflowY),
        );
        for (const el of tall)
          for (let y = 0; y <= el.scrollHeight; y += 500) {
            el.scrollTop = y;
            await new Promise((r) => setTimeout(r, 120));
          }
        for (const el of tall) el.scrollTop = 0;
      });
      await page.waitForTimeout(1500);
      const { assets, head } = await page.evaluate(scan);
      for (const a of assets) {
        if (a.src) {
          const w = weights.get(a.src) ?? weights.get(new URL(a.src, ORIGIN).href);
          a.kb = w
            ? Math.round((w.bytes / 1024) * 10) / 10
            : a.src.startsWith("data:")
              ? Math.round((a.src.length / 1024) * 10) / 10
              : null;
          a.mime = w?.type?.split(";")[0] ?? (a.src.startsWith("data:") ? a.src.slice(5, a.src.indexOf(";")) : "");
        }
      }
      records.push({ route, account: account ?? "signed-out", url, screen, width, assets, head });
      console.log(`  ok   ${route} @${width}: ${assets.length} asset groups`);
    } catch (e) {
      records.push({ route, account, url, screen, width, error: e.message.split("\n")[0] });
      console.log(`  FAIL ${route} @${width}: ${e.message.split("\n")[0]}`);
    }
    await context.close();
  }
}

// favicon / app icon / og image weights, fetched directly
const metaFiles = [];
const first = records.find((r) => r.route === "/ (signed out)" && r.width === 1440);
for (const h of first?.head ?? []) {
  if (!h.href || !/^(\/|https?:)/u.test(h.href) || !/(image|icon)/u.test(h.rel ?? "")) continue;
  let href = new URL(h.href, ORIGIN);
  // The app writes absolute social-image URLs with its own metadataBase (localhost); fetch them from the audit origin.
  if (["localhost", "127.0.0.1"].includes(href.hostname)) href = new URL(href.pathname + href.search, ORIGIN);
  if (href.origin !== new URL(ORIGIN).origin) continue; // never leave the local app
  const res = await fetch(href).catch(() => null);
  const buf = res ? Buffer.from(await res.arrayBuffer()) : null;
  let size = "-";
  if (buf && buf.readUInt32BE(0) === 0x89504e47) size = `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  metaFiles.push({
    ...h,
    status: res?.status,
    kb: buf ? Math.round((buf.length / 1024) * 10) / 10 : null,
    mime: res?.headers.get("content-type"),
    pixels: size,
  });
}
await browser.close();
writeFileSync(
  path.join(outDir, "assets.json"),
  JSON.stringify({ origin: ORIGIN, scannedAt: new Date().toISOString(), meta: metaFiles, pages: records }, null, 2),
);

// ---- readable tables
const lines = [
  "# Visual assets (generated by scan-assets.mjs)",
  "",
  `Scanned ${new Date().toISOString()} against ${ORIGIN}. Sizes are width x height in CSS px; KB is transferred body size.`,
  "",
];
lines.push(
  "## Head: favicon, app icons, social images",
  "",
  "| tag | rel/name | href | sizes | status | KB | type | pixels |",
  "|---|---|---|---|---|---|---|---|",
);
for (const m of metaFiles)
  lines.push(`| ${m.tag} | ${m.rel} | ${m.href} | ${m.sizes} | ${m.status} | ${m.kb} | ${m.mime} | ${m.pixels} |`);
lines.push(
  "",
  "Head tags found on `/` (signed out): " + (first?.head.map((h) => `${h.tag}[${h.rel}]`).join(", ") || "none"),
  "",
);
const routes = [...new Set(records.map((r) => r.route))];
for (const route of routes) {
  const rows = records.filter((r) => r.route === route);
  lines.push(`## ${route}`, "", `Account: ${rows[0].account}. Screenshot: \`${rows[0].screen}__<width>.png\``, "");
  const keyOf = (a) => `${a.kind}|${a.src ?? a.viewBox ?? ""}|${a.where?.[0] ?? ""}`;
  const groups = new Map();
  for (const r of rows)
    for (const a of r.assets ?? []) {
      const k = keyOf(a);
      (groups.get(k) ?? groups.set(k, []).get(k)).push({ width: r.width, a });
    }
  if (!groups.size) {
    lines.push("_No assets found (or scan failed)._", "");
    continue;
  }
  lines.push(
    "| kind | where | file / source | format | natural | rendered 390 / 768 / 1440 | KB | alt | loading / fetchpriority / decoding |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const [, list] of groups) {
    const a = list[0].a;
    const rend = [390, 768, 1440]
      .map((w) => {
        const hit = list.find((l) => l.width === w)?.a;
        return hit
          ? hit.count > 1
            ? `${hit.rendered.w}x${hit.rendered.h} (x${hit.count})`
            : hit.rendered.visible
              ? `${hit.rendered.w}x${hit.rendered.h}`
              : "hidden"
          : "-";
      })
      .join(" / ");
    const src = (a.src ?? (a.viewBox ? `viewBox ${a.viewBox}, ${a.paths} shapes` : ""))
      .replace(ORIGIN, "")
      .slice(0, 70);
    const where = (Array.isArray(a.where) ? a.where.join("; ") : (a.where ?? "")).slice(0, 60);
    lines.push(
      `| ${a.kind}${a.count ? ` x${a.count}` : ""} | ${where} | ${src} | ${a.mime ?? ""} | ${a.natural ?? "-"} | ${rend} | ${a.kb ?? "-"} | ${a.alt ?? (a.kind === "inline svg" ? `aria-hidden=${a.ariaHidden}` : "-")} | ${a.loading ?? "-"} / ${a.fetchpriority ?? "-"} / ${a.decoding ?? "-"} |`,
    );
  }
  lines.push("");
}
writeFileSync(path.join(outDir, "assets.md"), lines.join("\n"));
console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, "assets.md"))}`);
