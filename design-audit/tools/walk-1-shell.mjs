#!/usr/bin/env node
// Pass 2 walk, group 1: signed-out pages, sign-in, and the app shell (navigation, Projects, Library,
// Plans, Settings). Read-only except where a line says otherwise (each such step undoes itself).
//   node design-audit/tools/walk-1-shell.mjs [--only=<text>] [--widths=1440,390]
import { runWalk, settled } from "./walk-lib.mjs";

const prompt = "A neighborhood coffee shop that roasts its own beans and sells to offices.";

await runWalk("shell", [
  {
    name: "signed-out-home-load",
    async run(page, t) {
      await t.burst("load", () => page.goto("/", { waitUntil: "commit" }), [100, 400, 900, 1600, 2600, 4000]);
    },
  },
  {
    name: "signed-out-composer",
    async run(page, t) {
      await page.goto("/");
      await settled(page, 1500);
      const box = page.getByRole("textbox", { name: "Your prompt" });
      await t.burst("focus-composer", () => box.click(), [0, 120, 400]);
      await t.burst("type-first-characters", () => box.pressSequentially("A coffee", { delay: 30 }), [0, 150, 500]);
      t.note(
        `send button after typing: ${JSON.stringify(
          await page.getByRole("button", { name: "Send prompt" }).evaluate((b) => {
            const s = getComputedStyle(b);
            return { disabled: b.disabled, ariaDisabled: b.getAttribute("aria-disabled"), bg: s.backgroundColor, transition: s.transitionDuration };
          }),
        )}`,
      );
      await box.fill("");
      await page.waitForTimeout(300);
      await t.burst("click-starter-chip", () => page.getByRole("button", { name: "A neighborhood coffee shop" }).click(), [0, 120, 400, 900]);
      await t.evalNote("prompt after chip", () => document.querySelector("textarea")?.value.slice(0, 80));
      await t.burst("open-add-files-popover", () => page.getByText("Add files or images").first().click({ force: true }).catch(() => page.locator("summary").first().click()), [0, 120, 400]);
      await page.keyboard.press("Escape");
      await t.evalNote("popover open after Escape", () => [...document.querySelectorAll("details[open]")].length);
    },
  },
  {
    name: "signed-out-sign-in-overlay",
    async run(page, t) {
      await page.goto("/");
      await settled(page, 1500);
      await page.getByRole("textbox", { name: "Your prompt" }).fill(prompt);
      await t.burst("send-prompt-signed-out", () => page.getByRole("button", { name: "Send prompt" }).click(), [0, 80, 200, 450, 1000, 2000]);
      await t.evalNote("dialog styles", () => {
        const d = document.querySelector("dialog[open]");
        if (!d) return "no dialog";
        const s = getComputedStyle(d);
        const b = getComputedStyle(d, "::backdrop");
        return { cls: d.className, animation: s.animationName, transition: s.transitionDuration, backdrop: b.backgroundColor, backdropFilter: b.backdropFilter, focus: document.activeElement?.getAttribute("name") || document.activeElement?.tagName };
      });
      await t.burst("escape-closes-overlay", () => page.keyboard.press("Escape"), [0, 80, 200, 600]);
      await t.evalNote("after escape", () => ({ dialogs: document.querySelectorAll("dialog[open]").length, url: location.pathname, prompt: document.querySelector("textarea")?.value.length, focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName }));
      await page.waitForTimeout(500);
      await t.burst("open-overlay-from-pill", () => page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true }).click(), [0, 80, 200, 450, 1000]);
      await t.burst("switch-to-create-account", () => page.getByRole("dialog").getByRole("link", { name: "Create account" }).click(), [0, 80, 200, 450, 1000]);
      await t.burst("backdrop-click-closes", () => page.mouse.click(8, t.mobile ? 20 : 450), [0, 80, 200, 600]);
      await t.evalNote("after backdrop click", () => ({ dialogs: document.querySelectorAll("dialog[open]").length, url: location.pathname }));
    },
  },
  {
    name: "sign-in-page",
    async run(page, t, context) {
      await t.burst("load", () => page.goto("/sign-in", { waitUntil: "commit" }), [100, 400, 900, 1600, 2600]);
      const form = page.getByRole("form", { name: "Sign in", exact: true });
      await form.getByRole("textbox", { name: "Email" }).fill("audit-fresh@example.test");
      await form.getByLabel("Password", { exact: true }).fill("not-the-password-1");
      await t.burst("toggle-show-password", () => form.getByRole("button", { name: "Show password" }).click(), [0, 120, 400]);
      // Slow the sign-in request so the pending state can be seen.
      await context.route("**/api/auth/**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
      await context.route("**/auth/v1/token**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
      await t.burst("submit-wrong-password", () => form.getByRole("button", { name: "Sign in", exact: true }).click(), [0, 100, 400, 1200, 2400, 3200, 4500, 6500]);
      await t.evalNote("after wrong password", () => ({ alert: document.querySelector('[role="alert"]')?.innerText.slice(0, 120), password: document.querySelector('input[type="password"], input[name="password"]')?.value.length, focus: document.activeElement?.getAttribute("name") || document.activeElement?.tagName }));
    },
  },
  {
    name: "sign-up-and-forgot",
    async run(page, t) {
      await page.goto("/sign-up");
      await settled(page, 1500);
      const form = page.getByRole("form", { name: "Create account", exact: true });
      await form.getByRole("textbox", { name: "Email" }).fill("someone@example.test");
      await form.getByLabel("Password", { exact: true }).fill("short");
      await form.getByLabel("Confirm password").fill("different-1");
      await t.burst("submit-invalid-sign-up", () => form.getByRole("button", { name: "Create account", exact: true }).click(), [0, 150, 500, 1200]);
      await t.evalNote("validation", () => ({ alerts: [...document.querySelectorAll('[role="alert"]')].map((a) => a.innerText.slice(0, 100)), invalid: [...document.querySelectorAll(":invalid")].map((i) => i.name || i.tagName), focus: document.activeElement?.getAttribute("name") || document.activeElement?.tagName }));
      // Forgot password: the request is answered here after a delay, so no email is created anywhere.
      await page.route("**/api/auth/password-reset", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requested: true }) });
      });
      await page.goto("/forgot-password");
      await settled(page, 1500);
      const reset = page.getByRole("form", { name: "Request a password reset link" });
      await reset.getByRole("textbox").fill("someone@example.test");
      await t.burst("submit-forgot-password", () => reset.getByRole("button").click(), [0, 150, 600, 1500, 2200, 3000]);
      await t.burst("not-found", () => page.goto("/this-page-does-not-exist", { waitUntil: "commit" }), [200, 800, 2000]);
    },
  },
  {
    name: "nav-route-changes",
    account: "audit-pro",
    async run(page, t) {
      await t.burst("home-full-load", () => page.goto("/", { waitUntil: "commit" }), [100, 400, 900, 1600, 2600, 4000]);
      await settled(page, 1000);
      const nav = (name) => page.getByRole("navigation").getByRole("link", { name, exact: true }).first();
      await t.burst("home-to-projects", () => nav("Projects").click(), [0, 60, 150, 400, 900, 1600, 2600]);
      await settled(page);
      await t.burst("projects-to-library", () => nav("Library").click(), [0, 60, 150, 400, 900, 1600, 2600]);
      await settled(page);
      await t.burst("library-to-home", () => nav("Home").click(), [0, 60, 150, 400, 900, 1600, 2600]);
      await settled(page);
      await t.burst("home-to-projects-second-visit", () => nav("Projects").click(), [0, 60, 150, 400, 900, 1600]);
      await settled(page);
      await t.burst("browser-back", () => page.goBack({ waitUntil: "commit" }), [0, 150, 400, 900, 1600]);
    },
  },
  {
    name: "account-menu",
    account: "audit-pro",
    async run(page, t) {
      await page.goto("/brands");
      await settled(page, 1200);
      const trigger = page.getByLabel("Account menu").first();
      await t.burst("open-account-menu", () => trigger.click(), [0, 80, 200, 500]);
      await t.evalNote("menu styles", () => {
        const menu = document.querySelector("details[open] > :not(summary)");
        if (!menu) return "no open details";
        const s = getComputedStyle(menu);
        return { cls: menu.className, animation: s.animationName, transition: s.transitionDuration, origin: s.transformOrigin, items: [...menu.querySelectorAll("a,button")].map((i) => i.innerText.trim()), focus: document.activeElement?.innerText?.slice(0, 20) || document.activeElement?.tagName };
      });
      await t.burst("escape-closes-menu", () => page.keyboard.press("Escape"), [0, 150, 400]);
      await t.evalNote("after Escape", () => ({ open: document.querySelectorAll("details[open]").length, focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName }));
      if ((await page.locator("details[open]").count()) === 0) await trigger.click();
      await t.burst("outside-click-closes-menu", () => page.mouse.click(t.mobile ? 195 : 700, 600), [0, 150, 400]);
      await t.evalNote("after outside click", () => ({ open: document.querySelectorAll("details[open]").length }));
    },
  },
  {
    name: "projects-list",
    account: "audit-free",
    async run(page, t, context) {
      await page.goto("/brands");
      await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
      await settled(page, 1200);
      const card = page.getByRole("region", { name: "Projects" }).getByRole("article").first();
      if (!t.mobile) await t.burst("hover-project-card", () => card.hover(), [0, 100, 300]);
      await t.burst("open-card-options", () => page.getByRole("button", { name: /^Project options for/u }).first().click(), [0, 80, 200, 500]);
      await t.evalNote("options menu", () => {
        const menu = document.querySelector('[role="menu"]');
        if (!menu) return "no menu";
        const s = getComputedStyle(menu);
        return { cls: menu.className, animation: s.animationName, transition: s.transitionDuration, origin: s.transformOrigin, focus: document.activeElement?.innerText?.slice(0, 20) };
      });
      await t.burst("choose-delete", () => page.getByRole("menuitem", { name: "Delete" }).click(), [0, 80, 200, 500]);
      await t.evalNote("delete dialog", () => {
        const d = document.querySelector("dialog[open]");
        if (!d) return "no dialog";
        const s = getComputedStyle(d);
        const b = getComputedStyle(d, "::backdrop");
        return { cls: d.className, animation: s.animationName, transition: s.transitionDuration, backdrop: b.backgroundColor, focus: document.activeElement?.innerText?.slice(0, 30) };
      });
      await t.burst("escape-closes-dialog", () => page.keyboard.press("Escape"), [0, 80, 200, 500]);
      await t.evalNote("after Escape", () => ({ dialogs: document.querySelectorAll("dialog[open]").length, focus: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName }));
      const search = page.getByRole("searchbox", { name: /Search projects/u }).or(page.getByRole("textbox", { name: /Search projects/u }));
      await t.burst("type-search", () => search.pressSequentially("quill", { delay: 40 }), [0, 100, 300, 800]);
      await t.burst("search-no-match", () => search.fill("zzzz-nothing"), [0, 100, 300, 800]);
      await t.burst("clear-search", () => search.fill(""), [0, 100, 300, 800]);
      await t.burst("open-sort", () => page.getByText("Sort", { exact: true }).first().click(), [0, 100, 300]);
      await page.keyboard.press("Escape");
      // Slow list: what a slow connection sees.
      await context.route("**/api/projects**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.continue();
      });
      await t.burst("reload-with-3s-api-delay", () => page.reload({ waitUntil: "commit" }), [300, 1000, 2000, 3200, 3600, 4200, 5500]);
    },
  },
  {
    name: "library",
    account: "audit-pro",
    async run(page, t) {
      await t.burst("load-library", () => page.goto("/assets", { waitUntil: "commit" }), [200, 700, 1400, 2400, 4000]);
      await settled(page, 800);
      await t.burst("tab-all-generations", () => page.getByRole("tab", { name: "All generations" }).click(), [0, 80, 250, 700, 1500]);
      await t.burst("tab-kept-assets", () => page.getByRole("tab", { name: "Kept assets" }).click(), [0, 80, 250, 700, 1500]);
      await t.evalNote("card controls", () => [...document.querySelectorAll("main button, main summary")].map((b) => (b.getAttribute("aria-label") || b.innerText || "").trim().slice(0, 40)).filter(Boolean).slice(0, 24));
      const details = page.getByRole("button", { name: /^View details of/u }).first();
      if (await details.count()) {
        await t.burst("view-details", () => details.click(), [0, 150, 500, 1200]);
        await t.evalNote("after view details", () => ({ dialogs: document.querySelectorAll("dialog[open]").length }));
        await page.keyboard.press("Escape");
      }
      if (!t.mobile) await t.burst("hover-library-card", () => page.locator("main article, main li").first().hover(), [0, 120, 300]);
    },
  },
  {
    name: "plans",
    account: "audit-free",
    async run(page, t) {
      await t.burst("load-plans", () => page.goto("/plans", { waitUntil: "commit" }), [200, 700, 1400, 2400]);
      await page.getByRole("button", { name: /Upgrade to Pro/u }).waitFor({ timeout: 30_000 });
      await settled(page, 500);
      await t.burst("click-upgrade", () => page.getByRole("button", { name: /Upgrade to Pro/u }).click(), [0, 80, 250, 700, 1500, 3000]);
      await t.evalNote("after upgrade click", () => ({ live: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((n) => n.innerText.trim().slice(0, 90)).filter(Boolean), focus: document.activeElement?.innerText?.slice(0, 30) || document.activeElement?.tagName, scrollTop: Math.round(document.scrollingElement.scrollTop) }));
    },
  },
  {
    name: "settings",
    account: "audit-pro",
    async run(page, t, context) {
      await t.burst("load-settings", () => page.goto("/settings", { waitUntil: "commit" }), [200, 700, 1400, 2400]);
      await settled(page, 1200);
      await t.burst("tab-usage", () => page.getByRole("tab", { name: "Usage" }).click(), [0, 80, 250, 700, 1500]);
      await t.burst("tab-account", () => page.getByRole("tab", { name: "Account" }).click(), [0, 80, 250, 700]);
      const name = page.getByRole("textbox", { name: "Full name" });
      const original = await name.inputValue();
      // Changes the profile name, then puts the original back.
      await name.fill(`${original || "Audit Pro"} x`);
      await t.burst("save-changes", () => page.getByRole("button", { name: "Save changes" }).click(), [0, 80, 250, 700, 1500, 3000]);
      await name.fill(original);
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.waitForTimeout(1500);
      await name.fill(`${original || "Audit Pro"} y`);
      await context.setOffline(true);
      await t.burst("save-changes-offline", () => page.getByRole("button", { name: "Save changes" }).click(), [0, 80, 250, 700, 1500, 3000, 6000]);
      await context.setOffline(false);
      await name.fill(original);
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.waitForTimeout(1500);
      await t.burst("open-delete-account-dialog", () => page.getByRole("button", { name: "Delete account" }).first().click(), [0, 80, 250, 700]);
      await t.evalNote("delete account dialog", () => {
        const d = document.querySelector("dialog[open]");
        return d ? { cls: d.className, focus: document.activeElement?.innerText?.slice(0, 30) || document.activeElement?.tagName, backdrop: getComputedStyle(d, "::backdrop").backgroundColor } : "no dialog";
      });
      await t.burst("escape-closes-delete-account", () => page.keyboard.press("Escape"), [0, 150, 500]);
    },
  },
  {
    name: "settings-dialogs",
    account: "audit-pro",
    async run(page, t) {
      await page.goto("/settings");
      await settled(page, 1500);
      const del = page.getByRole("button", { name: "Delete account" }).first();
      await del.scrollIntoViewIfNeeded();
      await t.burst("open-delete-account-dialog", () => del.click(), [0, 80, 250, 700]);
      await t.evalNote("delete account dialog", () => {
        const d = document.querySelector("dialog[open]");
        return d ? { cls: d.className, animation: getComputedStyle(d).animationName, focus: document.activeElement?.innerText?.slice(0, 30) || document.activeElement?.tagName, backdrop: getComputedStyle(d, "::backdrop").backgroundColor, buttons: [...d.querySelectorAll("button")].map((b) => `${b.innerText.trim()}${b.disabled ? " (disabled)" : ""}`) } : "no dialog";
      });
      await t.burst("escape-closes-delete-account", () => page.keyboard.press("Escape"), [0, 150, 500]);
      await t.evalNote("after Escape", () => ({ dialogs: document.querySelectorAll("dialog[open]").length, focus: document.activeElement?.innerText?.slice(0, 30) || document.activeElement?.tagName }));
      // Unsaved edit, then Sign out: shows the confirmation. "Keep editing" leaves everything as it was.
      const name = page.getByRole("textbox", { name: "Full name" });
      const original = await name.inputValue();
      await name.fill(`${original} unsaved`);
      await page.getByLabel("Account menu").first().click();
      await t.burst("sign-out-with-unsaved-edits", () => page.getByRole("button", { name: "Sign out", exact: true }).first().click(), [0, 80, 250, 700]);
      await t.evalNote("sign-out confirmation", () => ({ dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.className), text: [...document.querySelectorAll("dialog[open], details[open]")].map((d) => d.innerText.trim().replace(/\s+/gu, " ").slice(0, 160)) }));
      const keep = page.getByRole("button", { name: "Keep editing" }).first();
      if (await keep.isVisible().catch(() => false)) await t.burst("keep-editing", () => keep.click(), [0, 150, 500]);
      await name.fill(original);
    },
  },
]);
