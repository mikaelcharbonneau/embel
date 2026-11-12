#!/usr/bin/env node
// Pass 2 walk, group 3: live states that CHANGE seeded data (run last; reseed afterwards, as the audit
// README says). Every AI request here is answered by the local stand-in AI, never a real model.
//   node design-audit/tools/walk-3-live.mjs [--only=<text>] [--widths=1440]
import { aiMode, brand, conversation, runWalk, settled } from "./walk-lib.mjs";

/** Counts animation frames for a while and reports the frame rate and the worst frame gap. */
const frameRate = (ms) =>
  new Promise((resolve) => {
    const gaps = [];
    let last = performance.now();
    const start = last;
    const tick = (now) => {
      gaps.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else {
        gaps.shift();
        const sorted = [...gaps].sort((a, b) => a - b);
        resolve({ fps: Math.round((gaps.length / (now - start)) * 1000), worstGapMs: Math.round(sorted.at(-1)), p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]), over33ms: gaps.filter((g) => g > 33).length, frames: gaps.length });
      }
    };
    requestAnimationFrame(tick);
  });
const animations = () =>
  document.getAnimations().map((a) => {
    const timing = a.effect?.getComputedTiming?.() ?? {};
    const target = a.effect?.target;
    return `${a.animationName ?? a.transitionProperty} ${timing.duration}ms ${timing.easing} x${timing.iterations === Infinity ? "inf" : timing.iterations} on ${target?.tagName?.toLowerCase()}.${String(target?.className?.baseVal ?? target?.className).split(" ")[0]}`;
  });
const throttle = async (page, context, rate) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
};

const researchLive = (reduced) => ({
  name: reduced ? "research-live-reduced-motion" : "research-live",
  account: "audit-pro",
  reducedMotion: reduced,
  async run(page, t) {
    await aiMode({ text: "hold", images: "normal" });
    await page.goto("/");
    await settled(page, 1200);
    await page.getByRole("textbox", { name: "Your prompt" }).fill(reduced ? "A pottery studio that runs evening classes for beginners." : "A mobile bike repair service that comes to your office.");
    await t.burst("send-brief", () => page.getByRole("button", { name: "Send prompt", exact: true }).click(), [0, 80, 200, 450, 900, 1600, 2600, 4000, 6000]);
    await page.getByText(/Researching your competitors/u).waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1200);
    await t.evalNote("animations while researching", animations);
    await t.evalNote("frame rate while researching", frameRate, 2500);
    await t.burst("research-running", () => page.waitForTimeout(10), [0, 700, 1400, 2100, 2800]);
    await t.evalNote("pill while researching", () => [...document.querySelectorAll("header *")].filter((n) => n.children.length === 0 && n.innerText?.trim()).map((n) => n.innerText.trim()).slice(0, 14));
    const cancel = page.getByRole("button", { name: /Cancel research/u });
    await t.burst("cancel-research", () => cancel.click(), [0, 80, 250, 700, 1500, 3000, 5000]);
    await t.evalNote("after cancel", () => ({ url: location.pathname, text: document.querySelector("main")?.innerText.trim().replace(/\s+/gu, " ").slice(0, 260) }));
    await aiMode({ text: "normal", images: "normal" });
    if (reduced) return;
    // Delete the project this scenario just created (it goes to Deleted projects).
    await page.goto("/brands");
    await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
    await settled(page, 1200);
    await t.shot("projects-before-delete");
    const options = page.getByRole("button", { name: /^Project options for/u }).first();
    t.note(`deleting: ${await options.getAttribute("aria-label")}`);
    await options.click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    t.note(`dialog buttons: ${JSON.stringify(await dialog.getByRole("button").allInnerTexts())}`);
    await t.burst("confirm-delete", () => dialog.getByRole("button", { name: /Delete/u }).last().click(), [0, 80, 250, 600, 1200, 2500, 4000]);
    await t.evalNote("after delete", () => ({ dialogs: document.querySelectorAll("dialog[open]").length, cards: document.querySelectorAll("main article").length, live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 80)).filter(Boolean), focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.innerText?.slice(0, 30) || document.activeElement?.tagName }));
  },
});

const logosLive = (reduced) => ({
  name: reduced ? "logos-live-reduced-motion" : "logos-live",
  account: "audit-pro",
  reducedMotion: reduced,
  async run(page, t, context) {
    await aiMode({ text: "normal", images: "slow", delayMs: 45_000 });
    await page.goto(conversation(reduced ? "brightharbor" : "aurelie"));
    const more = page.getByRole("button", { name: "More concepts" }).first();
    await more.waitFor({ timeout: 60_000 });
    await settled(page, 2000);
    await more.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await t.evalNote("frame rate before (idle page)", frameRate, 2000);
    await t.burst("click-more-concepts", () => more.click(), [0, 80, 250, 600, 1200, 2500, 4000, 6000]);
    await page.getByText(/Creating your concept/u).first().waitFor({ timeout: 60_000 }).catch(() => t.note("no 'Creating your concept' text appeared"));
    await page.getByText(/Creating your concept/u).first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(2500);
    await t.evalNote("generation stage", () => ({ stages: document.querySelectorAll("[data-generation-animation]").length, canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight}`), captions: [...document.querySelectorAll("[data-generation-animation]")].map((n) => n.innerText.trim()).slice(0, 6), live: [...document.querySelectorAll('[role="status"]')].map((n) => n.innerText.trim().slice(0, 60)).filter(Boolean).slice(0, 8) }));
    await t.evalNote("animations while drawing", animations);
    await t.evalNote("frame rate while drawing", frameRate, 3000);
    await t.burst("drawing", () => page.waitForTimeout(10), [0, 500, 1000, 1500, 2000]);
    if (!reduced) {
      await throttle(page, context, 4);
      await t.evalNote("frame rate while drawing, CPU 4x slower", frameRate, 3000);
      await page.mouse.wheel(0, -600);
      await t.evalNote("frame rate while drawing and scrolling, CPU 4x slower", frameRate, 2000);
      await throttle(page, context, 1);
    }
    const stop = page.getByRole("button", { name: /^Stop/u }).first();
    if (await stop.count()) {
      await stop.scrollIntoViewIfNeeded();
      await t.burst("click-stop", () => stop.click(), [0, 80, 250, 700, 1500, 3000, 5000, 8000]);
      await t.evalNote("after stop", () => ({ stages: document.querySelectorAll("[data-generation-animation]").length, live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 80)).filter(Boolean).slice(0, 8) }));
    } else t.note("no Stop button found");
    await aiMode({ text: "normal", images: "normal" });
    if (reduced) return;
    // A normal-speed run, to see how finished concepts arrive.
    await page.waitForTimeout(6000);
    const again = page.getByRole("button", { name: "More concepts" }).first();
    if (await again.isEnabled().catch(() => false)) {
      await again.scrollIntoViewIfNeeded();
      await t.burst("more-concepts-normal-speed", () => again.click(), [0, 300, 1000, 2000, 3500, 5000, 7000, 9000, 12000, 16000, 20000]);
    } else t.note("More concepts not enabled after stop");
  },
});

await runWalk("live", [
  researchLive(false),
  researchLive(true),
  logosLive(false),
  logosLive(true),
  {
    name: "scroll-performance",
    account: "audit-pro",
    async run(page, t, context) {
      await page.goto(conversation("kestrel"));
      await settled(page, 4000);
      const scroller = () =>
        [...document.querySelectorAll("body *")].find((n) => n.scrollHeight > n.clientHeight + 400 && /auto|scroll/u.test(getComputedStyle(n).overflowY));
      await t.evalNote("scroller", (find) => {
        const n = new Function(`return (${find})()`)();
        return n ? { cls: n.className, height: n.scrollHeight, view: n.clientHeight } : "document";
      }, scroller.toString());
      const measure = async (label) => {
        const result = page.evaluate(frameRate, 3000);
        for (let i = 0; i < 28; i++) {
          await page.mouse.wheel(0, i < 14 ? 260 : -260);
          await page.waitForTimeout(100);
        }
        t.note(`${label}: ${JSON.stringify(await result)}`);
      };
      await page.mouse.move(t.mobile ? 195 : 720, 450);
      await measure("scrolling the finished brand page");
      await throttle(page, context, 4);
      await measure("scrolling the finished brand page, CPU 4x slower");
      await throttle(page, context, 1);
      await t.log("scroll-log");
    },
  },
  {
    name: "select-concept",
    account: "audit-free",
    async run(page, t) {
      await page.goto(conversation("quill"));
      const grid = page.getByRole("region", { name: "Logo concepts", exact: true });
      await grid.waitFor({ timeout: 60_000 });
      await settled(page, 2500);
      await grid.scrollIntoViewIfNeeded();
      const select = grid.getByRole("button", { name: "Select concept 1", exact: true });
      t.note(`select button box: ${JSON.stringify(await select.boundingBox())}`);
      await t.shot("before-select");
      await t.burst("select-concept-1", () => select.click({ force: true }), [0, 80, 200, 450, 900, 1800, 3000]);
      await t.evalNote("after select", () => ({ selected: document.querySelectorAll('[data-selected="true"]').length, live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 70)).filter(Boolean).slice(0, 6), buttons: [...document.querySelectorAll('[aria-label="Logo concepts"] ~ * button, [aria-label="Logo concepts"] button')].map((b) => (b.getAttribute("aria-label") || b.innerText).trim().slice(0, 30)).slice(0, 14) }));
      const other = grid.getByRole("button", { name: "Select concept 2", exact: true });
      if (await other.count()) await t.burst("switch-to-concept-2", () => other.click({ force: true }), [0, 80, 200, 450, 900]);
      const refine = page.getByRole("textbox", { name: "Describe a change to this logo", exact: true });
      if (await refine.count()) {
        await refine.scrollIntoViewIfNeeded();
        await t.burst("focus-refine-composer", () => refine.click(), [0, 120, 400]);
        await refine.fill("Make the strokes thicker.");
        await t.burst("refine-with-zero-credits", () => page.getByRole("button", { name: "Refine", exact: true }).click(), [0, 80, 250, 700, 1500]);
      }
    },
  },
  {
    name: "choose-direction",
    account: "audit-free",
    async run(page, t) {
      await page.goto(conversation("mosswood"));
      const step = page.getByRole("region", { name: "Creative direction", exact: true });
      await step.waitFor({ timeout: 60_000 });
      await settled(page, 2500);
      // The radio only reports "checked" after the choice is saved, so click and watch (no check()).
      const one = step.getByRole("radio", { name: /^Direction 1: /u });
      const first = (await one.getAttribute("aria-checked")) === "true" ? step.getByRole("radio", { name: /^Direction 2: /u }) : one;
      t.note(`choosing: ${await first.getAttribute("aria-label")}`);
      await first.scrollIntoViewIfNeeded();
      await t.shot("before-choose");
      await t.burst("choose-direction", () => first.click(), [0, 80, 200, 450, 900, 1800, 3000]);
      t.note(`aria-checked after 3 s: ${await first.getAttribute("aria-checked")}`);
      await t.evalNote("after choose", () => ({ selected: document.querySelectorAll('[data-selected="true"]').length, live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 70)).filter(Boolean).slice(0, 6) }));
      const next = step.getByRole("link", { name: "Continue", exact: true });
      if (await next.count()) {
        await next.scrollIntoViewIfNeeded();
        await t.burst("continue-to-assets-first-time", () => next.click(), [0, 100, 300, 700, 1500, 2500, 4000, 6000, 9000, 13000]);
        await page.getByRole("status").filter({ hasText: "Ready to download." }).waitFor({ timeout: 120_000 }).catch(() => t.note("never reached Ready to download"));
        await t.log("assets-first-build");
      }
    },
  },
  {
    name: "failed-upload",
    account: "audit-free",
    async run(page, t) {
      await page.goto(conversation("northernlights"));
      await page.getByRole("article", { name: "Inspiration gallery", exact: true }).waitFor({ timeout: 60_000 });
      await settled(page, 2000);
      const input = page.locator('input[type="file"][aria-label="Choose images to add"]');
      if (!(await input.count())) return t.note("no file input found");
      await t.burst("upload-a-broken-image", () => input.setInputFiles({ name: "not-an-image.png", mimeType: "image/png", buffer: Buffer.from("this is not an image") }), [0, 150, 500, 1200, 2500, 5000, 9000]);
      await t.evalNote("after upload", () => ({ live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 110)).filter(Boolean).slice(0, 6), buttons: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((x) => /upload/iu.test(x)) }));
      const cancel = page.getByRole("button", { name: /Cancel upload/u }).first();
      if (await cancel.count()) await t.burst("cancel-upload", () => cancel.click(), [0, 150, 500, 1200]);
    },
  },
  {
    name: "keyboard-and-sign-out",
    account: "audit-pro",
    async run(page, t) {
      await page.goto("/");
      await settled(page, 1500);
      await t.reset();
      for (let i = 0; i < 9; i++) {
        await page.keyboard.press("Tab");
        await page.waitForTimeout(60);
      }
      await t.log("tab-through-home");
      await t.shot("focus-ring-on-home");
      await page.goto(conversation("kestrel"));
      await settled(page, 3000);
      await t.reset();
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        await page.waitForTimeout(80);
      }
      await t.log("tab-through-brand-page");
      await t.shot("focus-ring-on-brand-page");
      await page.goto("/");
      await settled(page, 1200);
      await page.getByLabel("Account menu").first().click();
      await t.burst("sign-out", () => page.getByRole("button", { name: "Sign out", exact: true }).click(), [0, 80, 250, 600, 1200, 2500]);
      await t.evalNote("after sign out", () => ({ url: location.pathname, signedOut: !!document.querySelector('a[href="/sign-in"]'), live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 70)).filter(Boolean) }));
    },
  },
  {
    name: "delete-project",
    account: "audit-pro",
    async run(page, t) {
      // Removes the "Untitled brand" projects the research scenarios created (they go to Deleted projects).
      for (let round = 0; round < 3; round++) {
        await page.goto("/brands");
        await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
        await settled(page, 1500);
        const options = page.getByRole("button", { name: "Project options for Untitled brand" }).first();
        if (!(await options.count())) return t.note(`no Untitled brand left after ${round} deletion(s)`);
        if (round === 0) await t.shot("projects-before-delete");
        await options.click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        t.note(`dialog: ${JSON.stringify((await dialog.innerText()).replace(/\s+/gu, " ").slice(0, 260))}`);
        const confirm = dialog.getByRole("button", { name: /delete/iu }).last();
        if (round === 0) {
          await t.burst("confirm-delete", () => confirm.click(), [0, 80, 250, 600, 1200, 2500, 4000, 7000]);
          await t.evalNote("after delete", () => ({ dialogs: document.querySelectorAll("dialog[open]").length, cards: document.querySelectorAll("main article").length, live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 90)).filter(Boolean), focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.innerText?.slice(0, 30) || document.activeElement?.tagName }));
        } else {
          await confirm.click();
          await page.waitForTimeout(6000);
        }
      }
    },
  },
]);
