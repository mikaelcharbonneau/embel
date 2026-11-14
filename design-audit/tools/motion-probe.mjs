#!/usr/bin/env node
// Design-audit pass 2: interaction-state probe. Read-only: it hovers with the real mouse and forces
// :active / :focus-visible through the DevTools protocol, so nothing is ever clicked or changed.
//
//   node design-audit/tools/motion-probe.mjs [--widths=1440,390] [--only=<text>]
//
// For every route it groups the interactive elements by "signature" (tag + class), takes one sample
// of each, and records what visibly changes on hover, press and keyboard focus, plus the element's
// transition, the animations running at rest, and what is left of them under prefers-reduced-motion.
// Output: design-audit/evidence/motion/probe.json and probe-summary.md.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, signIn } from "../seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.resolve(HERE, "..");
const ORIGIN = "http://127.0.0.1:3105";
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const WIDTHS = flag("widths", "1440,390").split(",").map(Number);
const ONLY = flag("only", "");
const HEIGHT = { 390: 844, 768: 1024, 1440: 900 };

const credentials = JSON.parse(readFileSync(path.join(AUDIT, ".audit-credentials"), "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(AUDIT, ".logs/last-seed.json"), "utf8")).results;
const brand = (key) => seeded.find((r) => r.key === key).projectId;
const conversation = (key) => `/brands/account/${brand(key)}?view=strategy`;

const ROUTES = [
  ["signed-out", "home", "/"],
  ["signed-out", "sign-in", "/sign-in"],
  ["signed-out", "sign-up", "/sign-up"],
  ["signed-out", "forgot-password", "/forgot-password"],
  ["signed-out", "reset-password", "/reset-password"],
  ["signed-out", "not-found", "/this-page-does-not-exist"],
  ["signed-out", "plans", "/plans"],
  ["audit-fresh", "home-empty", "/"],
  ["audit-fresh", "projects-empty", "/brands"],
  ["audit-fresh", "library-empty", "/assets"],
  ["audit-free", "home", "/"],
  ["audit-free", "projects", "/brands"],
  ["audit-free", "plans", "/plans"],
  ["audit-free", "settings", "/settings"],
  ["audit-free", "brand-spokesmith", conversation("spokesmith")],
  ["audit-free", "brand-brightsmile", conversation("brightsmile")],
  ["audit-free", "brand-northernlights", conversation("northernlights")],
  ["audit-free", "brand-berenice", conversation("berenice")],
  ["audit-free", "brand-quill", conversation("quill")],
  ["audit-free", "brand-tidewater", conversation("tidewater")],
  ["audit-free", "brand-mosswood", conversation("mosswood")],
  ["audit-pro", "library", "/assets"],
  ["audit-pro", "plans", "/plans"],
  ["audit-pro", "settings", "/settings"],
  ["audit-pro", "brand-kestrel", conversation("kestrel")],
  ["audit-pro", "assets-kestrel", `/brands/account/${brand("kestrel")}/logo/deliverables`],
].filter(([account, slug]) => !ONLY || ONLY.split(",").some((t) => `${account}/${slug}`.includes(t)));

// ---- in-page helpers -------------------------------------------------------------------------
const PROPS = [
  "color",
  "background-color",
  "border-top-color",
  "border-top-width",
  "box-shadow",
  "opacity",
  "transform",
  "text-decoration-line",
  "outline-style",
  "outline-width",
  "outline-color",
  "outline-offset",
  "filter",
  "fill",
  "stroke",
  "scale",
  "translate",
];

/** Tags one visible sample per interactive signature with data-probe="<n>" and describes it. */
function discover() {
  const selector =
    'a[href], button, summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], [tabindex="0"]';
  const seen = new Map();
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/u).slice(0, 3).join(".") : "";
    const disabled = el.matches(':disabled, [aria-disabled="true"]');
    const signature = `${el.tagName.toLowerCase()}${el.type && el.tagName === "INPUT" ? `[${el.type}]` : ""}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${cls ? `.${cls}` : ""}${disabled ? ":disabled" : ""}`;
    const entry = seen.get(signature);
    if (entry) {
      entry.count += 1;
      continue;
    }
    el.setAttribute("data-probe", String(seen.size));
    seen.set(signature, {
      id: seen.size,
      signature,
      count: 1,
      name: (
        el.getAttribute("aria-label") ||
        el.innerText ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        ""
      )
        .trim()
        .replace(/\s+/gu, " ")
        .slice(0, 60),
      disabled,
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      cursor: style.cursor,
      transition:
        style.transitionDuration === "0s" || style.transitionProperty === "none"
          ? "none"
          : `${style.transitionProperty} ${style.transitionDuration} ${style.transitionTimingFunction}`,
    });
  }
  return [...seen.values()];
}

/** Computed style of the sample, three ancestors and its first descendants, as one flat record. */
function snapshot([id, props]) {
  const el = document.querySelector(`[data-probe="${id}"]`);
  if (!el) return null;
  const nodes = [["self", el]];
  let up = el.parentElement;
  for (let i = 1; up && i <= 3; i++, up = up.parentElement) nodes.push([`ancestor${i}`, up]);
  [...el.querySelectorAll("*")].slice(0, 14).forEach((node, i) => nodes.push([`child${i}`, node]));
  const out = {};
  for (const [label, node] of nodes) {
    const style = getComputedStyle(node);
    const tag = `${label}<${node.tagName.toLowerCase()}>`;
    for (const prop of props) out[`${tag} ${prop}`] = style.getPropertyValue(prop);
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(node, pseudo);
      if (ps.content && ps.content !== "none")
        for (const prop of ["background-color", "opacity", "transform", "border-top-color"])
          out[`${tag}${pseudo} ${prop}`] = ps.getPropertyValue(prop);
    }
  }
  return out;
}

const diff = (before, after) =>
  !before || !after
    ? ["(element gone)"]
    : Object.keys(after)
        .filter((key) => before[key] !== after[key])
        .map((key) => `${key}: ${before[key]} → ${after[key]}`);

function runningAnimations() {
  return document.getAnimations().map((a) => {
    const timing = a.effect?.getComputedTiming?.() ?? {};
    const target = a.effect?.target;
    return {
      name: a.animationName ?? a.transitionProperty ?? a.constructor.name,
      kind: a.constructor.name,
      duration: timing.duration,
      iterations: timing.iterations === Infinity ? "infinite" : timing.iterations,
      easing: timing.easing,
      target: target
        ? `${target.tagName.toLowerCase()}.${String(target.className?.baseVal ?? target.className).split(/\s+/u)[0]}`
        : "?",
    };
  });
}

// ---- run ---------------------------------------------------------------------------------------
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page
    .waitForFunction(
      () =>
        !/(Loading (your )?(projects|project|library|saved preview)|Checking account…)/u.test(document.body.innerText),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1500);
}

async function probeRoute(context, account, slug, route, width) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: HEIGHT[width] });
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await settle(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const samples = await page.evaluate(discover);
  const animationsAtRest = await page.evaluate(runningAnimations);

  for (const sample of samples.slice(0, 80)) {
    const handle = await page.$(`[data-probe="${sample.id}"]`);
    if (!handle) continue;
    await page.mouse.move(1, 1);
    await handle.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(60);
    const base = await page.evaluate(snapshot, [sample.id, PROPS]);
    try {
      await handle.hover({ timeout: 1500 });
      await page.waitForTimeout(320);
      const hovered = await page.evaluate(snapshot, [sample.id, PROPS]);
      sample.hover = diff(base, hovered);
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: `[data-probe="${sample.id}"]`,
      });
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
      await page.waitForTimeout(260);
      sample.press = diff(hovered, await page.evaluate(snapshot, [sample.id, PROPS]));
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      await page.mouse.move(1, 1);
      await page.waitForTimeout(260);
      const rest = await page.evaluate(snapshot, [sample.id, PROPS]);
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
      await page.waitForTimeout(260);
      sample.focus = diff(rest, await page.evaluate(snapshot, [sample.id, PROPS]));
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    } catch (error) {
      sample.error = String(error.message).split("\n")[0].slice(0, 120);
    }
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(400);
  const animationsReduced = await page.evaluate(runningAnimations);
  await page.close();
  return { account, slug, route, width, samples, animationsAtRest, animationsReduced };
}

const browser = await launchBrowser();
const results = [];
const accounts = [...new Set(ROUTES.map(([account]) => account))];
for (const account of accounts) {
  const context = await browser.newContext({ baseURL: ORIGIN, locale: "en-US", timezoneId: "America/Toronto" });
  if (account !== "signed-out") {
    const page = await context.newPage();
    const { email, password } = credentials.find((c) => c.account === account);
    await signIn(page, email, password);
    await page.close();
  }
  for (const [, slug, route] of ROUTES.filter(([a]) => a === account))
    for (const width of WIDTHS) {
      const started = Date.now();
      try {
        const result = await probeRoute(context, account, slug, route, width);
        results.push(result);
        console.log(
          `${account}/${slug}@${width}: ${result.samples.length} signatures, ${result.animationsAtRest.length} animations at rest (${Date.now() - started} ms)`,
        );
      } catch (error) {
        console.log(`${account}/${slug}@${width}: FAILED ${String(error.message).split("\n")[0]}`);
      }
    }
  await context.close();
}
await browser.close();

const outDir = path.join(AUDIT, "evidence/motion");
mkdirSync(outDir, { recursive: true });
const suffix = ONLY ? `-${ONLY.replace(/[^a-z0-9]+/giu, "_")}` : "";
writeFileSync(path.join(outDir, `probe${suffix}.json`), JSON.stringify(results, null, 1));

// Summary: one line per signature across all routes, with what hover / press / focus changed.
const merged = new Map();
for (const result of results)
  for (const s of result.samples) {
    const key = `${s.signature}@${result.width}`;
    const entry = merged.get(key) ?? { ...s, width: result.width, routes: new Set(), total: 0 };
    entry.routes.add(`${result.account}/${result.slug}`);
    entry.total += s.count;
    merged.set(key, entry);
  }
const short = (list) =>
  list === undefined
    ? "n/a"
    : list.length === 0
      ? "**nothing**"
      : list.slice(0, 4).join("; ").replace(/\|/gu, "/") + (list.length > 4 ? ` (+${list.length - 4})` : "");
const lines = [
  "# Interaction-state probe (generated by tools/motion-probe.mjs)",
  "",
  "| Width | Signature | Example | Seen | Cursor | Transition | Hover changes | Press changes (on top of hover) | Keyboard-focus changes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...[...merged.values()].map(
    (s) =>
      `| ${s.width} | \`${s.signature}\` | ${s.name || "(no name)"} | ${s.total} on ${s.routes.size} route(s) | ${s.cursor} | ${s.transition} | ${s.error ? `(not hoverable: ${s.error})` : short(s.hover)} | ${short(s.press)} | ${short(s.focus)} |`,
  ),
];
writeFileSync(path.join(outDir, `probe-summary${suffix}.md`), `${lines.join("\n")}\n`);
console.log(`Wrote ${results.length} route probes to ${outDir}`);
