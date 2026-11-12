#!/usr/bin/env node
// Pass 2 walk, group 2: the brand conversation and the Assets page. Read-only: nothing here starts an
// AI request or changes saved choices (a like is toggled and toggled back).
//   node design-audit/tools/walk-2-brand.mjs [--only=<text>] [--widths=1440,390]
import { brand, conversation, runWalk, settled } from "./walk-lib.mjs";

const controls = () =>
  [...document.querySelectorAll("button, a[href], summary, [role=radio], [role=checkbox], input[type=radio], input[type=checkbox]")]
    .filter((n) => n.getBoundingClientRect().width > 0)
    .map((n) => `${n.tagName.toLowerCase()}:${(n.getAttribute("aria-label") || n.innerText || n.value || "").trim().replace(/\s+/gu, " ").slice(0, 44)}`)
    .filter((v, i, all) => all.indexOf(v) === i)
    .slice(0, 90);
const scrollers = () =>
  [...document.querySelectorAll("body *")]
    .filter((n) => n.scrollHeight > n.clientHeight + 40 && /auto|scroll/u.test(getComputedStyle(n).overflowY))
    .map((n) => ({ cls: String(n.className).split(" ")[0], top: Math.round(n.scrollTop), height: n.scrollHeight, view: n.clientHeight, behavior: getComputedStyle(n).scrollBehavior }));

await runWalk("brand", [
  {
    name: "open-kestrel-from-projects",
    account: "audit-pro",
    async run(page, t) {
      await page.goto("/brands");
      const card = page.getByRole("region", { name: "Projects" }).getByRole("article").filter({ hasText: "Kestrel Analytics" });
      await card.first().waitFor({ timeout: 30_000 });
      await settled(page, 1000);
      await t.burst("click-project-card", () => card.getByRole("link").first().click(), [0, 100, 300, 700, 1200, 1800, 2600, 3600, 5000, 7000]);
      await settled(page, 1500);
      await t.evalNote("scrollers after open", scrollers);
      await t.evalNote("pill controls", () => [...document.querySelectorAll("header a, header button, header summary, nav a, nav button, nav summary")].map((n) => `${n.tagName.toLowerCase()}:${(n.getAttribute("aria-label") || n.innerText).trim().replace(/\s+/gu, " ").slice(0, 40)}${n.getAttribute("aria-current") ? " [current]" : ""}`));
      for (const step of ["Strategy", "Voice", "Identity", "Assets"]) {
        const link = page.getByRole("banner").getByRole("link", { name: new RegExp(step, "u") }).first();
        if (!(await link.count())) {
          t.note(`no pill link for ${step}`);
          continue;
        }
        await t.burst(`pill-step-${step.toLowerCase()}`, () => link.click(), [0, 100, 300, 800, 1700, 3300]);
        if (step === "Assets") {
          await settled(page, 1500);
          await page.goBack();
          await settled(page, 1500);
        }
      }
      await t.burst("browser-back-to-projects", () => page.goto("/brands", { waitUntil: "commit" }), [100, 500, 1200, 2200]);
    },
  },
  {
    name: "kestrel-direct-load",
    account: "audit-pro",
    async run(page, t) {
      await t.burst("direct-load", () => page.goto(conversation("kestrel"), { waitUntil: "commit" }), [150, 500, 1000, 1700, 2600, 3600, 5000, 7000]);
      await settled(page, 1500);
      await t.evalNote("controls", controls);
      await t.evalNote("images", () => {
        const imgs = [...document.images];
        return { total: imgs.length, lazy: imgs.filter((i) => i.loading === "lazy").length, blob: imgs.filter((i) => i.src.startsWith("blob:")).length, withTransition: imgs.filter((i) => getComputedStyle(i).transitionDuration !== "0s").length, withBgPlaceholder: imgs.filter((i) => getComputedStyle(i.parentElement).backgroundColor !== "rgba(0, 0, 0, 0)").length };
      });
      const menu = page.getByRole("banner").locator("summary").first();
      await t.burst("open-brand-menu", () => menu.click(), [0, 100, 300]);
      await page.keyboard.press("Escape");
      await t.evalNote("brand menu after Escape", () => document.querySelectorAll("header details[open], nav details[open]").length);
      await page.mouse.click(700, 500);
      const change = page.getByRole("button", { name: "Change name" });
      if (await change.count()) {
        await change.scrollIntoViewIfNeeded();
        await t.burst("change-name", () => change.click(), [0, 100, 300, 800, 1800, 3000]);
        await t.evalNote("controls after change name", controls);
      }
    },
  },
  {
    name: "strategy-choice-cards",
    account: "audit-free",
    async run(page, t) {
      await t.burst("direct-load-brightsmile", () => page.goto(conversation("brightsmile"), { waitUntil: "commit" }), [150, 600, 1200, 2200, 3600]);
      await settled(page, 1500);
      await t.evalNote("controls", controls);
      const radio = page.getByRole("radio").first();
      if (await radio.count()) {
        if (!t.mobile) await t.burst("hover-choice", () => radio.hover({ force: true }), [0, 80, 200]);
        await t.burst("check-choice", () => radio.check({ force: true }), [0, 80, 200, 500]);
        await t.evalNote("after check", () => ({ continueDisabled: [...document.querySelectorAll("button")].filter((b) => b.innerText.trim() === "Continue").map((b) => b.disabled), selectedCards: document.querySelectorAll(".guided-choice-card.is-selected").length }));
      }
      await page.goto(conversation("spokesmith"));
      await settled(page, 1500);
      await t.evalNote("spokesmith controls", controls);
      const box = page.getByRole("checkbox").first();
      if (await box.count()) {
        await t.burst("check-competitor", () => box.check({ force: true }), [0, 80, 200, 500]);
        await t.burst("uncheck-competitor", () => box.uncheck({ force: true }), [0, 80, 200]);
      }
      const refs = page.locator("summary").filter({ hasText: /References|Sources/u }).first();
      if (await refs.count()) await t.burst("open-references", () => refs.click(), [0, 80, 200, 500]);
    },
  },
  {
    name: "inspiration-gallery",
    account: "audit-free",
    async run(page, t) {
      await t.burst("direct-load-northernlights", () => page.goto(conversation("northernlights"), { waitUntil: "commit" }), [150, 600, 1200, 2200, 3600, 5500]);
      await settled(page, 1500);
      const gallery = page.getByRole("article", { name: "Inspiration gallery", exact: true });
      await gallery.waitFor({ timeout: 30_000 });
      await t.evalNote("gallery controls", () => [...document.querySelectorAll('[aria-label="Inspiration gallery"] button')].map((b) => (b.getAttribute("aria-label") || b.innerText).trim().slice(0, 50)).slice(0, 16));
      const likes = gallery.getByRole("button", { name: /^Like the whole .+ brand$/u });
      const brandCard = page.locator(".inspiration-brand").first();
      await brandCard.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      if (!t.mobile) {
        await t.burst("hover-brand-card", () => brandCard.hover({ position: { x: 20, y: 20 } }), [0, 60, 140, 300]);
        await t.burst("hover-brand-tile", () => brandCard.locator(".inspiration-brand-tile").first().hover(), [0, 60, 140, 300]);
      } else {
        await t.evalNote("touch: hover-only controls", () => ({ hoverMedia: matchMedia("(hover: hover)").matches, partLikeOpacity: [...document.querySelectorAll(".inspiration-part-like")].slice(0, 3).map((n) => getComputedStyle(n).opacity), tileLabelOpacity: [...document.querySelectorAll(".inspiration-tile-label")].slice(0, 3).map((n) => getComputedStyle(n).opacity), titleHintOpacity: [...document.querySelectorAll(".inspiration-brand-title span")].slice(0, 3).map((n) => getComputedStyle(n).opacity) }));
      }
      // Like, then unlike: leaves the saved likes as they were.
      const like = likes.first();
      await like.scrollIntoViewIfNeeded();
      await t.burst("like-brand", () => like.click(), [0, 60, 140, 300, 700, 1500]);
      await t.evalNote("after like", () => ({ pressed: document.querySelectorAll('.inspiration-heart[aria-pressed="true"]').length, live: [...document.querySelectorAll('[role="status"]')].map((n) => n.innerText.trim().slice(0, 60)).filter(Boolean).slice(0, 4) }));
      const unlike = gallery.getByRole("button", { name: /^Unlike the whole .+ brand$/u }).first();
      if (await unlike.count()) await t.burst("unlike-brand", () => unlike.click(), [0, 60, 140, 300, 700, 1500]);
      await t.burst("open-brand-detail", () => brandCard.locator(".inspiration-brand-open").first().click(), [0, 80, 200, 500, 1200]);
      await t.evalNote("brand detail dialog", () => {
        const d = document.querySelector("dialog[open]");
        if (!d) return "no dialog";
        const s = getComputedStyle(d);
        return { cls: d.className, size: `${d.offsetWidth}x${d.offsetHeight}`, animation: s.animationName, transition: s.transitionDuration, backdrop: getComputedStyle(d, "::backdrop").backgroundColor, focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName };
      });
      await t.burst("escape-closes-brand-detail", () => page.keyboard.press("Escape"), [0, 80, 200, 500]);
      await t.evalNote("after Escape", () => ({ dialogs: document.querySelectorAll("dialog[open]").length, focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.className || document.activeElement?.tagName }));
      const more = page.locator(".inspiration-more").first();
      if (await more.count()) {
        await more.scrollIntoViewIfNeeded();
        await t.burst("show-more-brands", () => more.click(), [0, 80, 200, 500, 1200]);
      }
    },
  },
  {
    name: "logo-concepts",
    account: "audit-free",
    async run(page, t) {
      await t.burst("direct-load-quill", () => page.goto(conversation("quill"), { waitUntil: "commit" }), [150, 600, 1200, 2200, 3600, 5500]);
      await settled(page, 1500);
      const grid = page.getByRole("region", { name: "Logo concepts", exact: true });
      await grid.waitFor({ timeout: 30_000 });
      await grid.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await t.evalNote("grid controls", () => [...document.querySelectorAll('[aria-label="Logo concepts"] button, [aria-label="Logo concepts"] [role=button]')].map((b) => `${(b.getAttribute("aria-label") || b.innerText).trim().slice(0, 40)} ${b.offsetWidth}x${b.offsetHeight}`).slice(0, 20));
      const cardEl = page.locator('[class*="galleryCard"]').first();
      if (!t.mobile) await t.burst("hover-concept-card", () => cardEl.hover(), [0, 60, 140, 300]);
      await t.shot("concept-grid");
      await page.goto(conversation("tidewater"));
      await settled(page, 2000);
      const retry = page.getByRole("button", { name: /Retry/u }).first();
      if (await retry.count()) {
        await retry.scrollIntoViewIfNeeded();
        await t.shot("tidewater-retry-state");
        await t.burst("click-retry-with-zero-credits", () => retry.click(), [0, 80, 250, 700, 1500]);
        await t.evalNote("after retry click", () => ({ dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.className), text: /out of credits/iu.test(document.body.innerText) }));
      }
    },
  },
  {
    name: "out-of-credits-and-disabled",
    account: "audit-free",
    async run(page, t) {
      await page.goto(conversation("berenice"));
      const explore = page.getByRole("button", { name: /Explore six concepts/u });
      const gallery = page.getByRole("article", { name: "Inspiration gallery", exact: true });
      await settled(page, 4000);
      // The brand reopens on Inspiration; Continue reveals the Logo step (no AI request).
      const openLogoStep = async (label) => {
        if (await explore.isVisible().catch(() => false)) return t.note("the Logo step was already open (logo inputs were saved earlier)");
        const next = gallery.getByRole("button", { name: "Continue", exact: true });
        await next.scrollIntoViewIfNeeded();
        if (label) await t.burst(label, () => next.click(), [0, 80, 200, 450, 900, 1800, 3000]);
        else await next.click();
        await explore.waitFor({ timeout: 60_000 });
        await page.waitForTimeout(1500);
      };
      await openLogoStep("continue-from-inspiration-to-logo");
      await explore.scrollIntoViewIfNeeded();
      const toggles = ["Wordmark", "Lettermark or monogram", "Pictorial mark", "Abstract mark", "Combination mark", "Emblem", "Mascot"];
      const first = page.getByRole("button", { name: new RegExp(`^${toggles[0]}`, "u") });
      if (!t.mobile) await t.burst("hover-logo-type-toggle", () => first.hover(), [0, 80, 200]);
      await t.burst("toggle-logo-type", () => first.click(), [0, 80, 200, 500]);
      await first.click();
      for (const type of toggles) {
        const toggle = page.getByRole("button", { name: new RegExp(`^${type}`, "u") });
        if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
      }
      await t.shot("explore-disabled");
      t.note(`explore disabled: ${JSON.stringify(await explore.evaluate((b) => ({ disabled: b.disabled, cursor: getComputedStyle(b).cursor, bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color })))}`);
      await page.reload();
      await settled(page, 4000);
      await openLogoStep(null);
      await explore.scrollIntoViewIfNeeded();
      await t.burst("explore-with-zero-credits", () => explore.click(), [0, 80, 250, 700, 1500, 3000]);
      await t.evalNote("out-of-credits prompt", () => {
        const el = [...document.querySelectorAll("*")].filter((n) => /out of credits/iu.test(n.innerText || "")).pop()?.closest('[role="dialog"], dialog, section, aside, div');
        if (!el) return "not found";
        const s = getComputedStyle(el);
        return { tag: el.tagName, role: el.getAttribute("role"), cls: el.className, position: s.position, animation: s.animationName, transition: s.transitionDuration, focus: document.activeElement?.innerText?.slice(0, 30) || document.activeElement?.tagName };
      });
      const notNow = page.getByRole("button", { name: "Not now" });
      if (await notNow.count()) await t.burst("not-now", () => notNow.click(), [0, 80, 250, 700]);
    },
  },
  {
    name: "directions",
    account: "audit-free",
    async run(page, t) {
      await t.burst("direct-load-mosswood", () => page.goto(conversation("mosswood"), { waitUntil: "commit" }), [150, 600, 1200, 2200, 3600, 5500]);
      await settled(page, 1500);
      const step = page.getByRole("region", { name: "Creative direction", exact: true });
      await step.waitFor({ timeout: 30_000 });
      await step.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await t.evalNote("direction controls", () => [...document.querySelectorAll('[aria-label="Creative direction"] button, [aria-label="Creative direction"] [role=radio], [aria-label="Creative direction"] a')].map((b) => `${(b.getAttribute("aria-label") || b.innerText).trim().slice(0, 50)} ${b.offsetWidth}x${b.offsetHeight}`).slice(0, 20));
      const cardEl = step.locator('[class*="card"]').first();
      if (!t.mobile) await t.burst("hover-direction-card", () => cardEl.hover(), [0, 60, 140, 300]);
      const expand = step.getByRole("button", { name: /larger|expand|open|view/iu }).first();
      if (await expand.count()) {
        await t.burst("open-larger-view", () => expand.click(), [0, 80, 200, 500, 1200, 2500]);
        await t.evalNote("larger view dialog", () => {
          const d = document.querySelector("dialog[open]");
          return d ? { cls: d.className, size: `${d.offsetWidth}x${d.offsetHeight}`, animation: getComputedStyle(d).animationName, focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName } : "no dialog";
        });
        await t.burst("escape-closes-larger-view", () => page.keyboard.press("Escape"), [0, 80, 200]);
      }
    },
  },
  {
    name: "assets-page",
    account: "audit-pro",
    async run(page, t) {
      await t.burst("load-assets", () => page.goto(`/brands/account/${brand("kestrel")}/logo/deliverables`, { waitUntil: "commit" }), [200, 700, 1500, 2500, 4000, 6000, 9000, 13000]);
      await page.getByRole("status").filter({ hasText: "Ready to download." }).waitFor({ timeout: 120_000 }).catch(() => t.note("never reached Ready to download"));
      await t.log("until-ready");
      await t.evalNote("controls", controls);
      const copy = page.getByRole("button", { name: /Copy/u }).first();
      if (await copy.count()) {
        await copy.scrollIntoViewIfNeeded();
        await t.burst("copy-tokens", () => copy.click(), [0, 80, 250, 700, 1500, 3000]);
        t.note(`copy button after click: ${JSON.stringify(await copy.evaluate((b) => b.innerText))}`);
      }
      const download = page.getByRole("button", { name: "Download brand kit", exact: true });
      if (await download.count()) {
        await download.scrollIntoViewIfNeeded();
        const wait = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
        await t.burst("download-brand-kit", () => download.click(), [0, 80, 250, 700, 1500, 3000, 5000]);
        t.note(`download event: ${(await wait) ? "yes" : "no"}`);
      }
    },
  },
]);
