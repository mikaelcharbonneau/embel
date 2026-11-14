// Design-audit pass 3: measured accessibility probe. Read-only against the local app.
//
//   node design-audit/tools/a11y-probe.mjs                       every route state at 390 and 1440
//   node design-audit/tools/a11y-probe.mjs --only=home,plans     states whose slug contains one of these
//   node design-audit/tools/a11y-probe.mjs --widths=1440
//
// For every route state it records, without changing any data:
//   - document basics (lang, title, viewport meta, headings, landmarks, forms and their attributes)
//   - axe-core violations (WCAG 2.0/2.1/2.2 A and AA, best practice)
//   - contrast of every visible text run (computed colours, composited backgrounds, ratio calculated)
//   - contrast of form-control and button edges against what surrounds them (WCAG 1.4.11)
//   - pointer target sizes (WCAG 2.5.8: 24 px minimum, with the spacing exception)
//   - a keyboard walk with Tab: order, what changes on focus, the indicator's contrast, and whether
//     the focused control is hidden behind a fixed layer (WCAG 2.4.7, 2.4.11, 2.4.3)
//   - hover-state contrast for each distinct kind of control
//   - reflow at 320 px and at 200% zoom (a 720 x 450 viewport stands in for 1440 x 900 at 200%)
// Output: design-audit/evidence/a11y/<slug>__<width>.json, reflow screenshots, focus crops, summary.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, signIn } from "../seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.resolve(HERE, "..");
const ORIGIN = process.env.AUDIT_ORIGIN ?? "http://127.0.0.1:3105";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/u.test(ORIGIN)) throw new Error("Local addresses only.");
const OUT = path.join(AUDIT, "evidence/a11y");
for (const dir of ["", "reflow", "focus"]) mkdirSync(path.join(OUT, dir), { recursive: true });

const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const WIDTHS = flag("widths", "390,1440").split(",").map(Number);
const ONLY = flag("only", "");
const MAX_TABS = Number(flag("tabs", "160"));

const credentials = JSON.parse(readFileSync(path.join(AUDIT, ".audit-credentials"), "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(AUDIT, ".logs/last-seed.json"), "utf8")).results;
const id = (key) => seeded.find((r) => r.key === key).projectId;
const conv = (key) => `/brands/account/${id(key)}?view=strategy`;
const assets = (key) => `/brands/account/${id(key)}/logo/deliverables`;
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const MISSING = "00000000-0000-4000-8000-000000000000";

// slug, account (null = signed out), path
const STATES = [
  ["home__signed-out", null, "/"],
  ["sign-in__default", null, "/sign-in"],
  ["sign-up__default", null, "/sign-up"],
  ["forgot-password__default", null, "/forgot-password"],
  ["reset-password__no-recovery-session", null, "/reset-password"],
  ["not-found__default", null, "/this-page-does-not-exist"],
  ["projects__signed-out", null, "/brands"],
  ["library__signed-out", null, "/assets"],
  ["plans__signed-out", null, "/plans"],
  ["settings__signed-out", null, "/settings"],
  ["project-workspace__signed-out", null, `/brands/account/${MISSING}`],
  ["recover-project__signed-out", null, `/brands/${MISSING}`],
  ["home__empty-fresh", "audit-fresh", "/"],
  ["projects__empty-fresh", "audit-fresh", "/brands"],
  ["projects-deleted__empty-fresh", "audit-fresh", "/brands?state=deleted"],
  ["library__empty-fresh", "audit-fresh", "/assets"],
  ["plans__free-fresh", "audit-fresh", "/plans"],
  ["settings__account-fresh", "audit-fresh", "/settings"],
  ["home__recent-brands-free", "audit-free", "/"],
  ["projects__eight-brands-free", "audit-free", "/brands"],
  ["library__kept-assets-free", "audit-free", "/assets"],
  ["plans__free-0-credits-free", "audit-free", "/plans"],
  ["settings__account-free", "audit-free", "/settings"],
  ["brand-conversation__spokesmith-research-done-free", "audit-free", conv("spokesmith")],
  ["brand-conversation__brightsmile-strategy-done-free", "audit-free", conv("brightsmile")],
  ["brand-conversation__northernlights-voice-done-free", "audit-free", conv("northernlights")],
  ["brand-conversation__berenice-inspiration-chosen-free", "audit-free", conv("berenice")],
  ["brand-conversation__quill-logos-generated-free", "audit-free", conv("quill")],
  ["brand-conversation__tidewater-logos-partly-failed-free", "audit-free", conv("tidewater")],
  ["brand-conversation__mosswood-directions-generated-free", "audit-free", conv("mosswood")],
  ["brand-conversation__orchardlane-complete-free", "audit-free", conv("orchardlane")],
  ["brand-assets__orchardlane-ready-free", "audit-free", assets("orchardlane")],
  ["home__recent-brands-pro", "audit-pro", "/"],
  ["projects__three-brands-pro", "audit-pro", "/brands"],
  ["library__kept-assets-pro", "audit-pro", "/assets"],
  ["plans__pro-current-pro", "audit-pro", "/plans"],
  ["settings__account-pro", "audit-pro", "/settings"],
  ["brand-conversation__kestrel-complete-pro", "audit-pro", conv("kestrel")],
  ["brand-assets__kestrel-ready-pro", "audit-pro", assets("kestrel")],
  ["brand-identity__kestrel-pro", "audit-pro", `/brands/account/${id("kestrel")}/identity`],
  ["brand-recover__owner-none-pro", "audit-pro", `/brands/${MISSING}`],
  ["project-workspace__missing-project-pro", "audit-pro", `/brands/account/${MISSING}`],
].filter(([slug]) => !ONLY || ONLY.split(",").some((text) => slug.includes(text)));

// ---------------------------------------------------------------- in-page helpers (run in the browser)

function installHelpers() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  /** Any CSS colour string -> [r, g, b, a] via the browser's own parser. */
  const rgba = (text) => {
    if (cache.has(text)) return cache.get(text);
    const m = /^rgba?\(([^)]+)\)$/u.exec(text);
    let out;
    if (m) {
      const p = m[1]
        .split(/[\s,/]+/u)
        .filter(Boolean)
        .map(parseFloat);
      out = [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
    } else {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = text;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2], d[3] / 255];
    }
    cache.set(text, out);
    return out;
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const lum = ([r, g, b]) => {
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const hex = (c) =>
    `#${c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")}`;
  /** Opaque colour behind an element: composite every ancestor background, bottom-up. */
  const backdrop = (element) => {
    const layers = [];
    let image = false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage !== "none" && node !== document.body && node !== document.documentElement) image = true;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) {
        layers.push(c);
        if (c[3] === 1) break;
      }
    }
    let colour = [255, 255, 255, 1];
    for (const layer of layers.reverse()) colour = over(layer, colour);
    return { colour, image };
  };
  const opacityOf = (element) => {
    let value = 1;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement)
      value *= parseFloat(getComputedStyle(node).opacity);
    return value;
  };
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return "?";
    const cls = String(node.className?.baseVal ?? node.className ?? "")
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 3)
      .join(".");
    const name = (
      node.getAttribute("aria-label") ||
      node.getAttribute("name") ||
      node.getAttribute("placeholder") ||
      ""
    ).slice(0, 40);
    const text = node.matches("a,button,summary,label,h1,h2,h3,[role]")
      ? (node.innerText || "").trim().replace(/\s+/gu, " ").slice(0, 40)
      : "";
    return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${cls ? `.${cls}` : ""}${name ? `[${name}]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const where = (node) => {
    const parts = [];
    for (let n = node.parentElement, i = 0; n && i < 3 && n !== document.body; n = n.parentElement, i += 1) {
      const cls = String(n.className?.baseVal ?? n.className ?? "")
        .split(/\s+/u)
        .filter(Boolean)[0];
      parts.unshift(`${n.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`);
    }
    return parts.join(" > ");
  };
  const visible = (node) => {
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = node.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [role="button"], [role="tab"], [role="menuitem"], [role="link"], [contenteditable="true"]';
  window.__a11y = { rgba, over, ratio, hex, backdrop, opacityOf, describe, where, visible, FOCUSABLE };
}

function sweep() {
  const { rgba, over, ratio, hex, backdrop, opacityOf, describe, where, visible, FOCUSABLE } = window.__a11y;
  const doc = {
    url: location.pathname + location.search + location.hash,
    title: document.title,
    lang: document.documentElement.lang,
    viewportMeta: document.querySelector('meta[name="viewport"]')?.content ?? null,
    h1: [...document.querySelectorAll("h1")].filter(visible).map((h) => h.innerText.trim().slice(0, 80)),
    headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter(visible)
      .map((h) => `${h.tagName} ${h.innerText.trim().replace(/\s+/gu, " ").slice(0, 60)}`),
    landmarks: Object.fromEntries(
      [
        "main",
        "nav",
        "header",
        "footer",
        "aside",
        "form",
        '[role="search"]',
        "section[aria-label], section[aria-labelledby]",
      ].map((s) => [s, document.querySelectorAll(s).length]),
    ),
    navLabels: [...document.querySelectorAll("nav")].map(
      (n) => n.getAttribute("aria-label") || n.getAttribute("aria-labelledby") || "(unnamed)",
    ),
    skipLink: [...document.querySelectorAll('a[href^="#"]')]
      .filter((a) => /skip/iu.test(a.textContent))
      .map((a) => ({
        text: a.textContent.trim(),
        href: a.getAttribute("href"),
        targetExists: Boolean(document.querySelector(a.getAttribute("href"))),
      })),
    liveRegions: document.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length,
    dialogsOpen: [...document.querySelectorAll("dialog[open]")].map(describe),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    bodyText: document.body.innerText.replace(/\s+/gu, " ").slice(0, 300),
    focusableCount: [...document.querySelectorAll(FOCUSABLE)].filter(
      (n) => n.tabIndex >= 0 && !n.disabled && visible(n),
    ).length,
  };

  // ---- text contrast
  const combos = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest("script,style,noscript,svg") || !visible(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    const { colour: bg, image } = backdrop(el);
    const raw = rgba(cs.color);
    const opacity = opacityOf(el);
    const fg = over([raw[0], raw[1], raw[2], raw[3] * opacity], bg);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const disabled = Boolean(el.closest(":disabled, [aria-disabled='true']"));
    const key = [hex(fg), hex(bg), size, weight, disabled].join("|");
    const entry = combos.get(key) ?? {
      fg: hex(fg),
      bg: hex(bg),
      size,
      weight,
      ratio: ratio(fg, bg),
      required: large ? 3 : 4.5,
      disabled,
      bgImage: image,
      opacity: opacity < 1 ? Number(opacity.toFixed(2)) : undefined,
      count: 0,
      samples: [],
    };
    entry.count += 1;
    if (entry.samples.length < 3) entry.samples.push(`${describe(el)} «${text.slice(0, 50)}» in ${where(el)}`);
    combos.set(key, entry);
  }
  // placeholders
  for (const input of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
    if (!visible(input) || input.value) continue;
    const ph = getComputedStyle(input, "::placeholder");
    const { colour: bg } = backdrop(input);
    const raw = rgba(ph.color);
    const fg = over([raw[0], raw[1], raw[2], raw[3] * parseFloat(ph.opacity || "1") * opacityOf(input)], bg);
    const size = parseFloat(ph.fontSize);
    const key = ["placeholder", hex(fg), hex(bg), size].join("|");
    const entry = combos.get(key) ?? {
      fg: hex(fg),
      bg: hex(bg),
      size,
      weight: 400,
      ratio: ratio(fg, bg),
      required: 4.5,
      placeholder: true,
      disabled: input.disabled,
      count: 0,
      samples: [],
    };
    entry.count += 1;
    if (entry.samples.length < 3)
      entry.samples.push(`${describe(input)} placeholder «${input.placeholder.slice(0, 40)}»`);
    combos.set(key, entry);
  }
  const contrast = [...combos.values()]
    .map((c) => ({ ...c, pass: c.ratio >= c.required }))
    .sort((a, b) => a.ratio - b.ratio);

  // ---- non-text contrast: the edge that identifies a control (WCAG 1.4.11)
  const edges = new Map();
  for (const el of document.querySelectorAll(
    'input:not([type="hidden"]), textarea, select, button, [role="button"], [role="tab"], a.button, summary',
  )) {
    if (!visible(el) || el.disabled) continue;
    const cs = getComputedStyle(el);
    const outside = backdrop(el.parentElement ?? el).colour;
    const fill = over(rgba(cs.backgroundColor), outside);
    const borderWidth = parseFloat(cs.borderTopWidth);
    const border = borderWidth > 0 && cs.borderTopStyle !== "none" ? over(rgba(cs.borderTopColor), outside) : null;
    const fillRatio = ratio(fill, outside);
    const borderRatio = border ? ratio(border, outside) : null;
    const best = Math.max(fillRatio, borderRatio ?? 0);
    const isField = el.matches("input, textarea, select");
    const type = el.getAttribute("type") || "";
    if (!isField && !border && fillRatio < 1.05) continue; // text-only button: its text is its identity
    if (["checkbox", "radio", "range", "file"].includes(type)) continue; // native controls drawn by the browser
    const key = [el.tagName, hex(fill), border ? hex(border) : "-", hex(outside)].join("|");
    const entry = edges.get(key) ?? {
      kind: isField ? "field" : "button",
      fill: hex(fill),
      border: border ? hex(border) : null,
      outside: hex(outside),
      fillRatio,
      borderRatio,
      best,
      pass: best >= 3,
      count: 0,
      samples: [],
    };
    entry.count += 1;
    if (entry.samples.length < 3) entry.samples.push(describe(el));
    edges.set(key, entry);
  }

  // ---- pointer targets
  const targets = [...document.querySelectorAll(FOCUSABLE)]
    .filter((el) => !el.disabled && visible(el) && el.tabIndex >= 0)
    .map((el) => ({ el, r: el.getBoundingClientRect() }));
  const small = [];
  let under44 = 0;
  for (const { el, r } of targets) {
    if (r.width < 44 || r.height < 44) under44 += 1;
    if (r.width >= 24 && r.height >= 24) continue;
    const cs = getComputedStyle(el);
    const inline =
      cs.display === "inline" &&
      el.parentElement &&
      el.parentElement.innerText.trim().length > el.innerText.trim().length + 12;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let crowdedBy = null;
    for (const other of targets) {
      if (other.el === el || other.el.contains(el) || el.contains(other.el)) continue;
      const dx = Math.max(other.r.left - cx, 0, cx - other.r.right);
      const dy = Math.max(other.r.top - cy, 0, cy - other.r.bottom);
      const reach = other.r.width < 24 || other.r.height < 24 ? 24 : 12; // two undersized targets: both 24 px circles must clear
      const ox = other.r.left + other.r.width / 2;
      const oy = other.r.top + other.r.height / 2;
      const distance = reach === 24 ? Math.hypot(ox - cx, oy - cy) : Math.hypot(dx, dy);
      if (distance < reach) {
        crowdedBy = describe(other.el);
        break;
      }
    }
    small.push({
      target: describe(el),
      where: where(el),
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
      inline,
      crowdedBy,
      fails258: !inline && Boolean(crowdedBy),
    });
  }

  // ---- forms
  const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')]
    .filter(visible)
    .map((el) => ({
      field: describe(el),
      type: el.getAttribute("type") ?? el.tagName.toLowerCase(),
      label:
        (
          el.labels?.[0]?.innerText ||
          el.getAttribute("aria-label") ||
          (el.getAttribute("aria-labelledby")
            ? document.getElementById(el.getAttribute("aria-labelledby").split(" ")[0])?.innerText
            : "") ||
          ""
        )
          .trim()
          .slice(0, 50) || null,
      autocomplete: el.getAttribute("autocomplete"),
      inputmode: el.getAttribute("inputmode"),
      required: el.required || el.getAttribute("aria-required") === "true",
      ariaInvalid: el.getAttribute("aria-invalid"),
      describedBy: el.getAttribute("aria-describedby"),
      disabled: el.disabled,
      fontSize: parseFloat(getComputedStyle(el).fontSize),
    }));

  // ---- clipped text (a hint for 1.4.4 / 1.4.12): text boxes that hide overflow and overflow
  const clipped = [];
  for (const el of document.querySelectorAll("h1,h2,h3,p,span,a,button,label,li,td,th,strong,div")) {
    if (clipped.length >= 12) break;
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
    const cs = getComputedStyle(el);
    if (!/hidden|clip/u.test(cs.overflowX + cs.overflowY) || !visible(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      clipped.push(
        `${describe(el)} (${cs.textOverflow}, clamp ${cs.webkitLineClamp}) «${el.innerText.trim().slice(0, 50)}»`,
      );
  }

  return {
    doc,
    contrast,
    edges: [...edges.values()].sort((a, b) => a.best - b.best),
    targets: { total: targets.length, under44, under24: small },
    fields,
    clipped,
  };
}

/** Stores the unfocused look of every focusable element so the walk can tell what focus changes. */
function rememberUnfocused() {
  const { FOCUSABLE } = window.__a11y;
  const look = (node) => {
    const cs = getComputedStyle(node);
    return [
      cs.outlineStyle,
      cs.outlineWidth,
      cs.outlineColor,
      cs.boxShadow,
      cs.borderTopColor,
      cs.backgroundColor,
      cs.textDecorationLine,
      cs.color,
    ].join("§");
  };
  const map = new WeakMap();
  for (const el of document.querySelectorAll(FOCUSABLE))
    map.set(el, [
      look(el),
      el.parentElement ? look(el.parentElement) : "",
      el.parentElement?.parentElement ? look(el.parentElement.parentElement) : "",
    ]);
  window.__a11y.unfocused = map;
  window.__a11y.look = look;
  document.activeElement?.blur?.();
  window.scrollTo(0, 0);
}

function focusInfo() {
  const { rgba, over, ratio, hex, backdrop, describe, where, unfocused, look } = window.__a11y;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { end: true };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const before = unfocused.get(el);
  const names = [
    "outline-style",
    "outline-width",
    "outline-color",
    "box-shadow",
    "border-color",
    "background",
    "text-decoration",
    "color",
  ];
  const diff = (a, b) =>
    a && b
      ? a
          .split("§")
          .map((v, i) => (v !== b.split("§")[i] ? names[i] : null))
          .filter(Boolean)
      : ["(new element)"];
  const self = before ? diff(before[0], look(el)) : ["(new element)"];
  const parent = before && el.parentElement ? diff(before[1], look(el.parentElement)) : [];
  const grand = before && el.parentElement?.parentElement ? diff(before[2], look(el.parentElement.parentElement)) : [];
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
  const behind = backdrop(el.parentElement ?? el).colour;
  let indicator = "none";
  let indicatorRatio = null;
  if (outline) {
    indicator = `outline ${cs.outlineWidth} ${cs.outlineStyle} offset ${cs.outlineOffset}`;
    indicatorRatio = ratio(over(rgba(cs.outlineColor), behind), behind);
  } else if (self.includes("box-shadow")) {
    indicator = `box-shadow ${cs.boxShadow.slice(0, 80)}`;
  } else if (self.includes("border-color")) {
    indicator = "border-color only";
    indicatorRatio = ratio(over(rgba(cs.borderTopColor), behind), behind);
  } else if (self.includes("background")) {
    indicator = "background only";
  } else if (parent.length || grand.length) {
    indicator = `on ancestor: ${[...new Set([...parent, ...grand])].join(", ")}`;
  }
  // Is the focused control covered by something fixed or sticky?
  const points = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + 3, r.top + 3],
    [r.right - 3, r.top + 3],
    [r.left + 3, r.bottom - 3],
    [r.right - 3, r.bottom - 3],
  ];
  let covered = 0;
  let outside = 0;
  let coveredBy = null;
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      outside += 1;
      continue;
    }
    const top = document.elementFromPoint(x, y);
    if (
      top &&
      top !== el &&
      !el.contains(top) &&
      !top.contains(el) &&
      !(el.labels && [...el.labels].some((l) => l.contains(top)))
    ) {
      covered += 1;
      let layer = top;
      while (layer && !/fixed|sticky/u.test(getComputedStyle(layer).position)) layer = layer.parentElement;
      coveredBy = `${describe(layer ?? top)}${layer ? ` (${getComputedStyle(layer).position})` : " (not fixed)"}`;
    }
  }
  const tiny = r.width < 2 || r.height < 2;
  return {
    el: describe(el),
    where: where(el),
    x: Math.round(r.left),
    y: Math.round(r.top + window.scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
    focusVisible: el.matches(":focus-visible"),
    indicator,
    indicatorRatio,
    behind: hex(behind),
    changed: self,
    invisible: tiny,
    covered,
    outside,
    coveredBy,
    key: `${describe(el)}@${Math.round(r.left)},${Math.round(r.top + window.scrollY)}`,
  };
}

function hoverContrast() {
  const { rgba, over, ratio, hex, backdrop, opacityOf } = window.__a11y;
  const el = window.__a11y.hoverTarget;
  const cs = getComputedStyle(el);
  const { colour: bg } = backdrop(el);
  const raw = rgba(cs.color);
  const fg = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(el)], bg);
  return {
    fg: hex(fg),
    bg: hex(bg),
    ratio: ratio(fg, bg),
    cursor: cs.cursor,
    size: parseFloat(cs.fontSize),
    weight: Number(cs.fontWeight),
  };
}

// ---------------------------------------------------------------- driver

const browser = await launchBrowser();
const sessions = new Map();
async function session(account) {
  if (!account) return undefined;
  if (sessions.has(account)) return sessions.get(account);
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const entry = credentials.find((a) => a.email.startsWith(account));
  await signIn(page, entry.email, entry.password);
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const state = await context.storageState();
  await context.close();
  sessions.set(account, state);
  return state;
}

async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800);
}

const SIGNED_OUT_WALL = /Sign in to (see|edit|choose)/u;

async function probe([slug, account, route], width) {
  const mobile = width < 700;
  const context = await browser.newContext({
    baseURL: ORIGIN,
    viewport: { width, height: mobile ? 844 : 900 },
    hasTouch: mobile,
    isMobile: mobile,
    storageState: await session(account),
    reducedMotion: "reduce",
    locale: "en-CA",
    timezoneId: "America/Toronto",
  });
  await context.addInitScript(installHelpers);
  const page = await context.newPage();
  const result = { slug, account, route, width };
  try {
    await page.goto(route);
    await settle(page);
    await page.evaluate(installHelpers);
    const text = await page.evaluate(() => document.body.innerText);
    if (account && SIGNED_OUT_WALL.test(text))
      throw new Error(`LOGIN WALL: ${slug} shows the signed-out state for ${account}`);
    Object.assign(result, await page.evaluate(sweep));

    // axe-core
    await page.evaluate(`${axeSource}; void 0`);
    const axe = await page.evaluate(async () => {
      const run = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
        resultTypes: ["violations", "incomplete"],
      });
      const pick = (list) =>
        list.map((v) => ({
          id: v.id,
          impact: v.impact,
          tags: v.tags.filter((t) => /^wcag\d|best/u.test(t)),
          help: v.help,
          count: v.nodes.length,
          nodes: v.nodes.slice(0, 4).map((n) => ({
            target: n.target.join(" "),
            html: n.html.slice(0, 160),
            why: (n.failureSummary || "").replace(/\s+/gu, " ").slice(0, 220),
          })),
        }));
      return {
        violations: pick(run.violations),
        incomplete: pick(run.incomplete).map(({ id, count, help }) => ({ id, count, help })),
      };
    });
    result.axe = axe;

    // keyboard walk
    await page.evaluate(rememberUnfocused);
    const walk = [];
    const seen = new Set();
    let crops = 0;
    const cropped = new Set();
    for (let i = 0; i < MAX_TABS; i += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(focusInfo);
      if (info.end) {
        if (i > 0) break;
        continue;
      }
      if (seen.has(info.key)) {
        result.walkLooped = true;
        break;
      }
      seen.add(info.key);
      walk.push(info);
      const signature = `${info.indicator.replace(/[\d.]+px/gu, "N")}|${info.covered >= 3 ? "covered" : ""}`;
      if (width === 1440 && crops < 8 && !cropped.has(signature) && !info.invisible) {
        cropped.add(signature);
        crops += 1;
        const box = await page.evaluate(() => {
          const r = document.activeElement.getBoundingClientRect();
          return {
            x: Math.max(0, r.left - 40),
            y: Math.max(0, r.top - 40),
            width: Math.min(window.innerWidth, r.width + 80),
            height: Math.min(window.innerHeight, r.height + 80),
          };
        });
        info.crop = `focus/${slug}__${width}__${String(walk.length).padStart(3, "0")}.png`;
        await page
          .screenshot({
            path: path.join(OUT, info.crop),
            clip: {
              x: box.x,
              y: box.y,
              width: Math.min(box.width, width - box.x),
              height: Math.min(box.height, (mobile ? 844 : 900) - box.y),
            },
          })
          .catch(() => delete info.crop);
      }
    }
    result.walk = walk;
    result.walkTruncated = walk.length >= MAX_TABS;

    // hover contrast: one sample per distinct kind of control
    const kinds = await page.evaluate(() => {
      const { FOCUSABLE, visible } = window.__a11y;
      const seenKinds = new Map();
      for (const el of document.querySelectorAll(FOCUSABLE)) {
        if (el.disabled || !visible(el) || !el.innerText?.trim()) continue;
        const kind = `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className ?? "")
          .split(/\s+/u)
          .filter(Boolean)
          .slice(0, 3)
          .join(".")}`;
        if (!seenKinds.has(kind)) seenKinds.set(kind, el);
        if (seenKinds.size >= 24) break;
      }
      window.__a11y.hoverKinds = [...seenKinds.values()];
      return [...seenKinds.keys()];
    });
    result.hover = [];
    if (!mobile) {
      for (let i = 0; i < kinds.length; i += 1) {
        const ok = await page.evaluate((index) => {
          const el = window.__a11y.hoverKinds[index];
          if (!el?.isConnected) return null;
          el.scrollIntoView({ block: "center" });
          window.__a11y.hoverTarget = el;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, i);
        if (!ok) continue;
        await page.mouse.move(0, 0);
        const rest = await page.evaluate(hoverContrast);
        await page.mouse.move(ok.x, ok.y);
        await page.waitForTimeout(220);
        const hovered = await page.evaluate(hoverContrast);
        result.hover.push({ kind: kinds[i], rest, hovered, changes: rest.fg !== hovered.fg || rest.bg !== hovered.bg });
      }
      await page.mouse.move(0, 0);
    }

    // reflow at 320 px and 200% zoom (1440 only, once per state)
    if (width === 1440) {
      result.reflow = {};
      for (const [name, size] of [
        ["320", { width: 320, height: 640 }],
        ["zoom200", { width: 720, height: 450 }],
      ]) {
        await page.setViewportSize(size);
        await page.goto(route);
        await settle(page);
        await page.evaluate(installHelpers);
        const data = await page.evaluate(() => {
          const { describe, visible } = window.__a11y;
          const vw = window.innerWidth;
          const offenders = [];
          for (const el of document.body.querySelectorAll("*")) {
            if (offenders.length >= 8) break;
            if (!visible(el)) continue;
            const r = el.getBoundingClientRect();
            if ((r.right > vw + 2 || r.left < -2) && r.width > 8) {
              if (el.parentElement && offenders.some((o) => o.node.contains(el))) continue;
              let scrollerAncestor = false;
              for (let n = el.parentElement; n && n !== document.body; n = n.parentElement)
                if (/auto|scroll/u.test(getComputedStyle(n).overflowX)) scrollerAncestor = true;
              offenders.push({
                node: el,
                text: `${describe(el)} left ${Math.round(r.left)} right ${Math.round(r.right)}${scrollerAncestor ? " (inside a horizontal scroller)" : ""}`,
              });
            }
          }
          const fixed = [...document.body.querySelectorAll("*")]
            .filter((el) => /fixed|sticky/u.test(getComputedStyle(el).position) && visible(el))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return {
                layer: describe(el),
                top: Math.round(r.top),
                height: Math.round(r.height),
                width: Math.round(r.width),
                shareOfViewport: Math.round(
                  (Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)) / window.innerHeight) * 100,
                ),
              };
            });
          return {
            viewport: `${vw}x${window.innerHeight}`,
            overflowX: document.documentElement.scrollWidth - vw,
            bodyScrollWidth: document.body.scrollWidth,
            offenders: offenders.map((o) => o.text),
            fixedLayers: fixed.slice(0, 5),
            minFontSize: Math.min(
              ...[...document.querySelectorAll("p,span,a,button,label,li,td,th,h1,h2,h3")]
                .filter(visible)
                .map((el) => parseFloat(getComputedStyle(el).fontSize)),
            ),
          };
        });
        data.screenshot = `reflow/${slug}__${name}.png`;
        await page.screenshot({ path: path.join(OUT, data.screenshot) });
        result.reflow[name] = data;
      }
    }
  } catch (error) {
    result.error = String(error.message ?? error).slice(0, 400);
  }
  await context.close();
  writeFileSync(path.join(OUT, `${slug}__${width}.json`), `${JSON.stringify(result, null, 1)}\n`);
  return result;
}

const queue = STATES.flatMap((state) => WIDTHS.map((width) => [state, width]));
const summary = [];
const total = queue.length;
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const [state, width] = job;
    const r = await probe(state, width);
    summary.push({
      slug: r.slug,
      width,
      error: r.error,
      title: r.doc?.title,
      axe: r.axe?.violations.map((v) => `${v.id}(${v.count})`).join(" "),
      contrastFails: r.contrast?.filter((c) => !c.pass && !c.disabled).length,
      edgeFails: r.edges?.filter((e) => !e.pass).length,
      under24: r.targets?.under24.length,
      fails258: r.targets?.under24.filter((t) => t.fails258).length,
      tabStops: r.walk?.length,
      noIndicator: r.walk?.filter((w) => w.indicator === "none" && !w.invisible).length,
      invisibleStops: r.walk?.filter((w) => w.invisible).length,
      covered: r.walk?.filter((w) => w.covered >= 3).length,
      overflow320: r.reflow?.["320"]?.overflowX,
      overflowZoom: r.reflow?.zoom200?.overflowX,
    });
    console.log(`[${total - queue.length}/${total}] ${r.slug} @${width}${r.error ? `  ERROR ${r.error}` : ""}`);
  }
}
await Promise.all(Array.from({ length: Number(flag("workers", "3")) }, worker));
await browser.close();
summary.sort((a, b) => a.slug.localeCompare(b.slug) || a.width - b.width);
const summaryFile = ONLY ? `summary-${ONLY.replace(/[^a-z0-9]+/giu, "-")}.json` : "summary.json";
writeFileSync(path.join(OUT, summaryFile), `${JSON.stringify(summary, null, 1)}\n`);
console.table(summary.map(({ title, ...rest }) => rest));
if (summary.some((s) => /LOGIN WALL/u.test(s.error ?? ""))) process.exit(2);
