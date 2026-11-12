// Design-audit pass 2: harness for scripted interaction walks. Each scenario drives the real local app
// in Chromium, while an in-page recorder logs what actually happens and when: animations and
// transitions that start, layout shifts, URL changes, loading texts, dialogs, focus moves and scrolls.
// Frame bursts (JPEG) go to design-audit/evidence/motion/frames/, timelines to evidence/motion/walk-*.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, signIn } from "../seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AUDIT = path.resolve(HERE, "..");
export const ORIGIN = "http://127.0.0.1:3105";
export const AI = "http://127.0.0.1:3186";
const OUT = path.join(AUDIT, "evidence/motion");
const FRAMES = path.join(OUT, "frames");
mkdirSync(FRAMES, { recursive: true });

const credentials = JSON.parse(readFileSync(path.join(AUDIT, ".audit-credentials"), "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(AUDIT, ".logs/last-seed.json"), "utf8")).results;
export const brand = (key) => seeded.find((r) => r.key === key).projectId;
export const conversation = (key) => `/brands/account/${brand(key)}?view=strategy`;
export const aiMode = (mode) => fetch(`${AI}/__mode`, { method: "POST", body: JSON.stringify(mode) }).then((r) => r.text());

/** Runs in the page before any app code. Everything it records is passive. */
function recorder() {
  const log = [];
  let t0 = 0;
  const now = () => Math.round(performance.now() - t0);
  const push = (type, detail) => log.push({ t: now(), type, detail });
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return "?";
    const cls = String(node.className?.baseVal ?? node.className ?? "").split(/\s+/u).filter(Boolean).slice(0, 2).join(".");
    const label = (node.getAttribute("aria-label") || "").slice(0, 30);
    return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${label ? `[${label}]` : ""}`;
  };
  const timingOf = (node, pseudo, kind, name) => {
    const style = getComputedStyle(node, pseudo || undefined);
    return kind === "animation"
      ? `${style.animationDuration} ${style.animationTimingFunction} x${style.animationIterationCount}`
      : `${style.transitionDuration} ${style.transitionTimingFunction} [${style.transitionProperty}]`;
  };
  document.addEventListener("animationstart", (e) => push("animation", `${e.animationName} on ${describe(e.target)}${e.pseudoElement} (${timingOf(e.target, e.pseudoElement, "animation")})`), true);
  document.addEventListener("transitionrun", (e) => push("transition", `${e.propertyName} on ${describe(e.target)}${e.pseudoElement} (${timingOf(e.target, e.pseudoElement, "transition")})`), true);
  document.addEventListener("pointerdown", (e) => push("pointerdown", describe(e.target.closest?.("a,button,summary,[role=button],input,textarea") ?? e.target)), true);
  document.addEventListener("keydown", (e) => push("key", e.key.length === 1 ? "char" : e.key), true);
  document.addEventListener("focusin", (e) => push("focus", describe(e.target)), true);
  let lastScroll = 0;
  document.addEventListener(
    "scroll",
    (e) => {
      const node = e.target === document ? document.scrollingElement : e.target;
      if (performance.now() - lastScroll < 40) return;
      lastScroll = performance.now();
      push("scroll", `${describe(node)} top=${Math.round(node.scrollTop)}`);
    },
    true,
  );
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        push("shift", `${e.value.toFixed(4)}${e.hadRecentInput ? " (after input)" : ""} ${(e.sources || []).slice(0, 3).map((s) => describe(s.node)).join(", ")}`);
    }).observe({ type: "layout-shift" });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) push("longtask", `${Math.round(e.duration)} ms`);
    }).observe({ type: "longtask" });
  } catch {}
  let lastUrl = location.href;
  let lastState = "";
  const state = () => {
    if (!document.body) return "";
    const visibleText = (node) => (node.checkVisibility?.() === false ? "" : node.innerText?.trim().replace(/\s+/gu, " ").slice(0, 70) || "");
    return JSON.stringify({
      h1: visibleText(document.querySelector("h1") ?? document.body).slice(0, 40),
      busy: document.querySelectorAll('[aria-busy="true"]').length,
      dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => describe(d)),
      details: [...document.querySelectorAll("details[open]")].map((d) => describe(d)).slice(0, 4),
      live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map(visibleText).filter(Boolean).slice(0, 5),
      imgsPending: [...document.images].filter((i) => !i.complete).length,
    });
  };
  const tick = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      push("url", location.pathname + location.search + location.hash);
    }
    const next = state();
    if (next && next !== lastState) {
      lastState = next;
      push("state", JSON.parse(next));
    }
  };
  const start = () => {
    if (!document.documentElement) return setTimeout(start, 0);
    new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    setInterval(tick, 50);
  };
  start();
  window.__rec = {
    reset() {
      log.length = 0;
      t0 = performance.now();
      lastState = "";
    },
    dump: () => log.slice(),
  };
}

/** Folds repeats of the same animation or transition within a step into one line ("x12"). */
const collapse = (lines) => {
  const out = [];
  const seen = new Map();
  for (const line of lines) {
    const body = line.slice(11);
    const key = /^(animation|transition)/u.test(body) ? body.replace(/ on [^(]+\(/u, " (") : null;
    if (key && seen.has(key)) seen.get(key).count += 1;
    else {
      const item = { line, count: 1 };
      if (key) seen.set(key, item);
      out.push(item);
    }
  }
  return out.map((o) => (o.count > 1 ? `${o.line}  [x${o.count} in this step]` : o.line));
};
const compact = (entry) => `${String(entry.t).padStart(6)} ms  ${entry.type.padEnd(11)} ${typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail)}`;

export async function runWalk(group, scenarios) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const widths = flag("widths", "1440,390").split(",").map(Number);
  const only = flag("only", "");
  const browser = await launchBrowser();
  const results = [];
  for (const scenario of scenarios) {
    if (only && !only.split(",").some((text) => scenario.name.includes(text))) continue;
    for (const width of scenario.widths ?? widths) {
      const mobile = width < 700;
      const context = await browser.newContext({
        baseURL: ORIGIN,
        viewport: { width, height: mobile ? 844 : 900 },
        hasTouch: mobile,
        isMobile: mobile,
        reducedMotion: scenario.reducedMotion ? "reduce" : "no-preference",
        locale: "en-US",
        timezoneId: "America/Toronto",
      });
      await context.addInitScript(recorder);
      const page = await context.newPage();
      const record = { scenario: scenario.name, width, account: scenario.account ?? "signed-out", steps: [], notes: [] };
      const stem = `${group}__${scenario.name}__${width}`;
      let frame = 0;
      const tools = {
        width,
        mobile,
        note: (text) => record.notes.push(text),
        reset: () => page.evaluate(() => window.__rec?.reset()),
        /** Stores the recorder log since the last reset under a label. */
        async log(label) {
          const entries = collapse((await page.evaluate(() => window.__rec?.dump() ?? [])).map(compact));
          record.steps.push({ label, entries });
          return entries;
        },
        /** Performs an action, then saves viewport frames at the given delays after it returns. */
        async burst(label, action, delays = [0, 80, 200, 450, 1000]) {
          await page.evaluate(() => window.__rec?.reset()).catch(() => {});
          const started = Date.now();
          await action();
          const files = [];
          for (const delay of delays) {
            const wait = started + delay - Date.now();
            if (wait > 0) await page.waitForTimeout(wait);
            // Nominal delay in the name, so a re-run overwrites its own frames instead of piling up.
            const file = `${stem}__${String(frame++).padStart(2, "0")}-${label}-${delay}ms.jpg`;
            await page.screenshot({ path: path.join(FRAMES, file), type: "jpeg", quality: 60, animations: "allow", caret: "initial" }).catch(() => {});
            files.push(file);
          }
          const entries = collapse((await page.evaluate(() => window.__rec?.dump() ?? []).catch(() => [])).map(compact));
          record.steps.push({ label, frames: files, entries });
          return entries;
        },
        shot: async (label) => {
          const file = `${stem}__${String(frame++).padStart(2, "0")}-${label}.jpg`;
          await page.screenshot({ path: path.join(FRAMES, file), type: "jpeg", quality: 70 });
          record.steps.push({ label, frames: [file], entries: [] });
        },
        evalNote: async (label, fn, arg) => record.notes.push(`${label}: ${JSON.stringify(await page.evaluate(fn, arg))}`),
      };
      try {
        if (scenario.account) {
          const { email, password } = credentials.find((c) => c.account === scenario.account);
          await signIn(page, email, password);
          await page.waitForTimeout(800);
        }
        await scenario.run(page, tools, context);
      } catch (error) {
        record.error = String(error.message).split("\n").slice(0, 3).join(" | ");
        await page.screenshot({ path: path.join(FRAMES, `${stem}__ERROR.jpg`), type: "jpeg", quality: 60 }).catch(() => {});
      }
      results.push(record);
      console.log(`\n=== ${scenario.name} @${width} (${record.account})${record.error ? `  ERROR: ${record.error}` : ""}`);
      for (const note of record.notes) console.log(`  note: ${note}`);
      for (const step of record.steps) {
        console.log(`  -- ${step.label}${step.frames ? `  [${step.frames.length} frame(s)]` : ""}`);
        for (const line of step.entries.slice(0, 45)) console.log(`     ${line.slice(0, 330)}`);
        if (step.entries.length > 45) console.log(`     … ${step.entries.length - 45} more`);
      }
      await context.close();
    }
  }
  await browser.close();
  const file = path.join(OUT, `walk-${group}${only ? `-${only.replace(/[^a-z0-9]+/giu, "_")}` : ""}.json`);
  writeFileSync(file, JSON.stringify(results, null, 1));
  console.log(`\nWrote ${file}`);
}

/** Bounded wait for the usual loading texts to go away. */
export async function settled(page, extra = 600) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page
    .waitForFunction(() => !/(Loading (your )?(projects|project|library|saved preview)|Checking account…|Preparing…)/u.test(document.body.innerText), null, { timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(extra);
}
