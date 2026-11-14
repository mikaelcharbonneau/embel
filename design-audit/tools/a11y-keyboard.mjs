// Design-audit pass 3: keyboard and focus-management checks that need real key presses.
// Read-only: nothing is confirmed, saved or generated (dialogs are opened and closed with Escape;
// the one account edit is typed while offline and the page is reloaded offline afterwards; the
// Upgrade presses have their checkout request blocked, so no payment page is ever opened;
// finished steps are only reopened for viewing, never chosen again).
//
//   node design-audit/tools/a11y-keyboard.mjs [--only=name,name]
// Output: design-audit/evidence/a11y/keyboard.json and screenshots in evidence/annotated/A-kbd-*.png
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, signIn } from "../seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.resolve(HERE, "..");
const ORIGIN = "http://127.0.0.1:3105";
const OUT = path.join(AUDIT, "evidence/a11y");
const SHOTS = path.join(AUDIT, "evidence/annotated");
mkdirSync(SHOTS, { recursive: true });
const only = process.argv
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  .split(",");

const credentials = JSON.parse(readFileSync(path.join(AUDIT, ".audit-credentials"), "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(AUDIT, ".logs/last-seed.json"), "utf8")).results;
const conv = (key) => `/brands/account/${seeded.find((r) => r.key === key).projectId}?view=strategy`;

const browser = await launchBrowser();
const states = new Map();
async function contextFor(account, viewport = { width: 1440, height: 900 }) {
  let storageState;
  if (account) {
    if (!states.has(account)) {
      const c = await browser.newContext({ baseURL: ORIGIN, viewport });
      const p = await c.newPage();
      const entry = credentials.find((a) => a.account === account);
      await signIn(p, entry.email, entry.password);
      await p.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });
      await p.waitForTimeout(1500);
      states.set(account, await c.storageState());
      await c.close();
    }
    storageState = states.get(account);
  }
  return browser.newContext({ baseURL: ORIGIN, viewport, storageState, reducedMotion: "reduce" });
}
const settle = async (page, extra = 1500) => {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(extra);
};

/** What has focus, in words. */
const active = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "BODY (focus lost)";
    const cls = String(el.className?.baseVal ?? el.className ?? "")
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .join(".");
    const name =
      el.getAttribute("aria-label") ||
      el.innerText?.trim().replace(/\s+/gu, " ").slice(0, 50) ||
      el.getAttribute("name") ||
      el.getAttribute("placeholder") ||
      "";
    const dialog = el.closest("dialog[open], [role='dialog'], [role='alertdialog']");
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} "${name}"${dialog ? " [inside dialog]" : ""}${el.matches(":focus-visible") ? "" : " [no :focus-visible]"}`;
  });

/** Describes the open modal, walks Tab through it, presses Escape, reports where focus went. */
async function dialogReport(page, { tabs = 14, escape = true } = {}) {
  const report = await page.evaluate(() => {
    const d = [...document.querySelectorAll("dialog[open], [role='dialog'], [role='alertdialog']")]
      .filter((n) => n.checkVisibility?.() !== false)
      .at(-1);
    if (!d) return { found: false };
    const labelled = d.getAttribute("aria-labelledby");
    const described = d.getAttribute("aria-describedby");
    return {
      found: true,
      tag: d.tagName.toLowerCase(),
      modal: d.matches(":modal"),
      role: d.getAttribute("role"),
      ariaModal: d.getAttribute("aria-modal"),
      name:
        d.getAttribute("aria-label") ||
        (labelled
          ? labelled
              .split(" ")
              .map((i) => document.getElementById(i)?.innerText?.trim())
              .join(" ")
          : null),
      description: described
        ? described
            .split(" ")
            .map((i) => document.getElementById(i)?.innerText?.trim().slice(0, 80))
            .join(" ")
        : null,
      focusables: d.querySelectorAll(
        "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
      ).length,
      size: `${Math.round(d.getBoundingClientRect().width)}x${Math.round(d.getBoundingClientRect().height)}`,
      scrolls: d.scrollHeight > d.clientHeight + 1,
    };
  });
  report.focusOnOpen = await active(page);
  if (!report.found) return report;
  const stops = [];
  let escaped = false;
  for (let i = 0; i < tabs; i += 1) {
    await page.keyboard.press("Tab");
    const where = await active(page);
    stops.push(where);
    if (!where.includes("[inside dialog]")) escaped = true;
  }
  report.tabStops = [...new Set(stops)];
  report.focusLeftDialog = escaped;
  if (escape) {
    // A non-modal dialog only hears Escape from inside: if the walk left it, put focus back on its first control.
    report.refocusedInsideBeforeEscape = await page.evaluate(() => {
      const d = [...document.querySelectorAll("dialog[open], [role='dialog'], [role='alertdialog']")]
        .filter((n) => n.checkVisibility?.() !== false)
        .at(-1);
      if (!d || d.contains(document.activeElement)) return false;
      d.querySelector(
        "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
      )?.focus();
      return true;
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    report.closedByEscape = await page.evaluate(
      () =>
        ![...document.querySelectorAll("dialog[open], [role='dialog'], [role='alertdialog']")].some(
          (n) => n.checkVisibility?.() !== false,
        ),
    );
    report.focusAfterClose = await active(page);
  }
  return report;
}

const results = {};
const scenario = async (name, account, fn, viewport) => {
  if (only && !only.some((o) => name.includes(o))) return;
  const context = await contextFor(account, viewport);
  const page = await context.newPage();
  const log = {};
  try {
    await fn(page, log, context);
  } catch (error) {
    log.error = String(error.message ?? error)
      .split("\n")[0]
      .slice(0, 300);
    await page.screenshot({ path: path.join(SHOTS, `A-kbd-ERROR-${name}.png`) }).catch(() => {});
  }
  results[name] = log;
  console.log(`\n### ${name}\n${JSON.stringify(log, null, 1)}`);
  await context.close();
};
const shot = (page, name, options = {}) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...options });

/** Visually hidden headings: the design system's `e-sr`, or the older `sr-only`. */
const VISUALLY_HIDDEN = ["e-sr", "sr-only"];

/**
 * Reopens a finished step of the brand conversation for viewing, by keyboard: its folded entry in the chat, then
 * the entry's Change button. Only the work area changes; nothing is chosen or saved until a choice is pressed.
 */
async function reopenStep(page, label, button) {
  const summary = page
    .locator("details.conversation-folded > summary")
    .filter({ hasText: new RegExp(`^\\s*${label}`, "u") })
    .first();
  await summary.focus();
  if (!(await summary.evaluate((n) => n.parentElement.open))) await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const change = page.getByRole("button", { name: button, exact: true });
  await change.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
}

// 1. Skip link
await scenario("skip-link", "audit-pro", async (page, log) => {
  await page.goto("/brands");
  await settle(page);
  await page.keyboard.press("Tab");
  log.firstTab = await active(page);
  log.skipLinkVisible = await page.evaluate(() => {
    const r = document.activeElement.getBoundingClientRect();
    return r.width > 10 && r.top >= 0 && r.left >= 0;
  });
  await shot(page, "A-kbd-skip-link", { clip: { x: 0, y: 0, width: 700, height: 160 } });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  log.afterActivate = await active(page);
  await page.keyboard.press("Tab");
  log.nextTab = await active(page);
});

// 2. Signed-out Home: sending a brief opens the sign-in overlay
await scenario("home-signed-out-overlay", null, async (page, log) => {
  await page.goto("/");
  await settle(page, 2500);
  const prompt = page.getByRole("textbox", { name: "Your prompt" });
  await prompt.focus();
  log.composerFocus = await page.evaluate(() => {
    const box = document.activeElement.closest(".conversation-composer, form") ?? document.activeElement.parentElement;
    const cs = getComputedStyle(box);
    const own = getComputedStyle(document.activeElement);
    return {
      ownOutline: `${own.outlineStyle} ${own.outlineWidth}`,
      box: box.className,
      boxBorder: cs.borderTopColor,
      boxOutline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      boxShadow: cs.boxShadow.slice(0, 90),
      background: cs.backgroundColor,
    };
  });
  await shot(page, "A-kbd-home-composer-focus", { clip: { x: 220, y: 200, width: 1000, height: 420 } });
  await page.evaluate(() => document.activeElement.blur());
  log.composerRest = await page.evaluate(() => {
    const box = document.querySelector(".conversation-composer") ?? document.querySelector("textarea").parentElement;
    const cs = getComputedStyle(box);
    return { boxBorder: cs.borderTopColor, boxShadow: cs.boxShadow.slice(0, 90) };
  });
  await prompt.fill("A neighbourhood bakery that delivers by bicycle");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  log.url = page.url().replace(ORIGIN, "");
  log.dialog = await dialogReport(page, { tabs: 16 });
  log.promptKept = await prompt.inputValue().catch(() => "(not found)");
});

// 3. Sign-in: wrong password
await scenario("sign-in-wrong-password", null, async (page, log) => {
  await page.goto("/sign-in");
  await settle(page, 2500);
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill("audit-pro@example.test");
  await form.getByLabel("Password", { exact: true }).fill("definitely-wrong-password");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  log.focusAfterError = await active(page);
  log.error = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"], [aria-live], .form-error')]
      .filter((n) => n.innerText?.trim())
      .map((n) => {
        const cs = getComputedStyle(n);
        return {
          text: n.innerText.trim().slice(0, 120),
          role: n.getAttribute("role"),
          live: n.getAttribute("aria-live"),
          id: n.id,
          color: cs.color,
          background: cs.backgroundColor,
          tabindex: n.getAttribute("tabindex"),
        };
      }),
  );
  log.fields = await page.evaluate(() =>
    [...document.querySelectorAll("form[aria-label='Sign in'] input")].map((i) => ({
      name: i.name,
      value: i.type === "password" ? `(${i.value.length} chars)` : i.value,
      invalid: i.getAttribute("aria-invalid"),
      describedby: i.getAttribute("aria-describedby"),
    })),
  );
  await shot(page, "A-kbd-sign-in-error");
  // password toggle: is it reachable and not covered?
  log.toggle = await page.evaluate(() => {
    const t = document.querySelector(".auth-password-toggle");
    if (!t) return "no .auth-password-toggle";
    const r = t.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      topElementAtCentre:
        top === t || t.contains(top) ? "the toggle itself" : `${top.tagName.toLowerCase()}.${top.className}`,
      pressed: t.getAttribute("aria-pressed"),
      label: t.getAttribute("aria-label"),
    };
  });
});

// 4. Sign-up validation
await scenario("sign-up-validation", null, async (page, log) => {
  await page.goto("/sign-up");
  await settle(page, 2500);
  log.fields = await page.evaluate(() =>
    [...document.querySelectorAll("main form input")].map((i) => ({
      name: i.name,
      type: i.type,
      autocomplete: i.autocomplete,
      required: i.required,
      minlength: i.getAttribute("minlength"),
      describedby: i.getAttribute("aria-describedby"),
      describedText: i.getAttribute("aria-describedby")
        ? document.getElementById(i.getAttribute("aria-describedby"))?.innerText.slice(0, 120)
        : null,
    })),
  );
  const inputs = page.locator("main form input");
  await inputs.nth(0).fill("audit-new@example.test");
  await page.locator("main form input[type=password]").nth(0).fill("LongEnoughPassword-123");
  await page.locator("main form input[type=password]").nth(1).fill("Different-Password-456");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  log.focusAfterMismatch = await active(page);
  log.errors = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"], .form-error')]
      .filter((n) => n.innerText?.trim())
      .map((n) => ({ text: n.innerText.trim().slice(0, 140), role: n.getAttribute("role") })),
  );
  log.fieldsAfter = await page.evaluate(() =>
    [...document.querySelectorAll("main form input")].map((i) => ({
      name: i.name,
      len: i.value.length,
      invalid: i.getAttribute("aria-invalid"),
      describedby: i.getAttribute("aria-describedby"),
    })),
  );
  log.legalLinks = await page.evaluate(() =>
    [...document.querySelectorAll("main a")].map((a) => a.innerText.trim()).filter(Boolean),
  );
  await shot(page, "A-kbd-sign-up-mismatch");
});

// 5. Projects: card options menu and Delete dialog
await scenario("projects-menu-and-delete", "audit-pro", async (page, log) => {
  await page.goto("/brands");
  await settle(page, 2500);
  const trigger = page.getByRole("button", { name: "Project options for Kestrel Analytics" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  log.menu = await page.evaluate(() => {
    const m = document.querySelector('[role="menu"]');
    return m
      ? {
          items: [...m.querySelectorAll('[role="menuitem"], button, a')].map(
            (i) => `${i.getAttribute("role")}:${i.innerText.trim()}`,
          ),
          label: m.getAttribute("aria-label") || m.getAttribute("aria-labelledby"),
        }
      : "no role=menu";
  });
  log.focusOnOpen = await active(page);
  await page.keyboard.press("ArrowDown");
  log.afterArrowDown = await active(page);
  await shot(page, "A-kbd-project-menu", { clip: { x: 0, y: 150, width: 1440, height: 600 } });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  log.menuClosedByEscape = await page.evaluate(() => !document.querySelector('[role="menu"]'));
  log.focusAfterEscape = await active(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.getByRole("menuitem", { name: /Delete/u }).press("Enter");
  await page.waitForTimeout(600);
  await shot(page, "A-kbd-delete-project-dialog");
  log.deleteDialog = await dialogReport(page);
});

// 6. Account menu (avatar button + role=menu)
await scenario("account-menu", "audit-pro", async (page, log) => {
  await page.goto("/brands");
  await settle(page, 2500);
  const trigger = page.locator("button.e-avatar[data-account-menu-trigger]");
  const menuState = () =>
    page.evaluate(() => {
      const t = document.querySelector("button.e-avatar[data-account-menu-trigger]");
      const m = document.getElementById(t.getAttribute("aria-controls"));
      return { open: Boolean(m && !m.hidden), triggerExpanded: t.getAttribute("aria-expanded") };
    });
  await trigger.focus();
  log.trigger = await active(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  log.menu = await page.evaluate(() => {
    const t = document.querySelector("button.e-avatar[data-account-menu-trigger]");
    const m = document.getElementById(t.getAttribute("aria-controls"));
    if (!m || m.hidden) return "not open";
    return {
      role: m.getAttribute("role"),
      label: m.getAttribute("aria-label") || m.getAttribute("aria-labelledby"),
      triggerExpanded: t.getAttribute("aria-expanded"),
      summary: m.querySelector(".e-menu__summary")?.innerText.trim().replace(/\s+/gu, " ") ?? null,
      items: [...m.querySelectorAll(".e-menu__item")].map(
        (i) =>
          `${i.getAttribute("role")}:${i.innerText.trim()}${i.getAttribute("aria-disabled") ? " (disabled)" : ""} tabindex=${i.tabIndex}`,
      ),
    };
  });
  log.focusOnOpen = await active(page);
  await page.keyboard.press("ArrowDown");
  log.afterArrowDown = await active(page);
  await page.keyboard.press("End");
  log.afterEnd = await active(page);
  await page.keyboard.press("Home");
  log.afterHome = await active(page);
  await shot(page, "A-kbd-account-menu-open");
  // Tab out of the open menu: does it close, and where does focus go?
  const stops = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    stops.push(await active(page));
  }
  log.tabStops = stops;
  log.afterTabbingOut = await menuState();
  log.stillOpenAfterTabbingOut = log.afterTabbingOut.open;
  await shot(page, "A-kbd-account-menu-left-open");
  // Escape from inside the menu: closes, focus back on the trigger?
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  log.reopened = await menuState();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterEscape = await menuState();
  log.closedByEscape = !afterEscape.open;
  log.triggerExpandedAfterEscape = afterEscape.triggerExpanded;
  log.focusAfterEscape = await active(page);
  log.focusReturnedToTrigger = await page.evaluate(() =>
    document.activeElement?.matches("button.e-avatar[data-account-menu-trigger]"),
  );
});

// 7. Settings: tabs, Delete account dialog
await scenario("settings-tabs-and-delete-account", "audit-free", async (page, log) => {
  await page.goto("/settings");
  await settle(page, 2500);
  const tab = page.getByRole("tab", { name: "Account" });
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);
  log.afterArrowRight = await active(page);
  log.selected = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].map(
      (t) => `${t.innerText.trim()}:${t.getAttribute("aria-selected")}:tabindex=${t.tabIndex}`,
    ),
  );
  log.usageTable = await page.evaluate(() => {
    const t = document.querySelector("table");
    return t
      ? {
          caption: t.caption?.innerText ?? null,
          ariaLabel: t.getAttribute("aria-label") || t.getAttribute("aria-labelledby"),
          headers: [...t.querySelectorAll("th")].map((h) => `${h.innerText.trim()}(${h.getAttribute("scope")})`),
          rows: t.rows.length,
          overflowsContainer: t.scrollWidth > t.parentElement.clientWidth,
        }
      : "no table";
  });
  await shot(page, "A-kbd-settings-usage");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  const del = page.getByRole("button", { name: "Delete account" });
  await del.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  await shot(page, "A-kbd-delete-account-dialog");
  log.deleteAccountDialog = await dialogReport(page);
});

// 8. Settings: an account edit while offline (error handling). Fields save on their own (650 ms after typing),
// so the browser goes offline before the first key press and never comes back online in this context: the
// failed save is left unretried, the page is reloaded offline and the context is closed. Nothing is saved.
await scenario("settings-offline-save", "audit-free", async (page, log, context) => {
  await page.goto("/settings");
  await settle(page, 2500);
  const name = page.getByLabel("Full name", { exact: true });
  log.nameBefore = await name.inputValue();
  await context.setOffline(true);
  await name.focus();
  await page.keyboard.press("End");
  await page.keyboard.type(" (not saved)");
  await page.waitForTimeout(5000);
  log.focusAfter = await active(page);
  log.fieldStatus = await page.evaluate(() => {
    const s = document.getElementById("profile-fullName-status");
    return s
      ? {
          live: s.getAttribute("aria-live"),
          state: s.dataset.state,
          text: s.innerText.trim().replace(/\s+/gu, " ").slice(0, 140),
          describesField: document.getElementById("profile-full-name")?.getAttribute("aria-describedby"),
        }
      : "no status line";
  });
  log.messages = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')]
      .filter((n) => n.innerText?.trim() && n.checkVisibility?.() !== false)
      .map((n) => ({
        text: n.innerText.trim().replace(/\s+/gu, " ").slice(0, 140),
        role: n.getAttribute("role"),
        live: n.getAttribute("aria-live"),
        color: getComputedStyle(n).color,
        background: getComputedStyle(n).backgroundColor,
      })),
  );
  await shot(page, "A-kbd-settings-offline-error");
  // Still offline: the reload fails and drops the unsaved edit.
  await page.reload({ timeout: 10_000 }).catch(() => {});
  log.reloadedWhileOffline = true;
  // Confirm nothing was saved, from a separate signed-in session.
  const check = await contextFor("audit-free");
  const fresh = await check.newPage();
  await fresh.goto("/settings");
  await settle(fresh, 2500);
  log.nameInFreshSession = await fresh.getByLabel("Full name", { exact: true }).inputValue();
  log.nothingSaved = log.nameInFreshSession === log.nameBefore;
  await check.close();
});

// 9. Brand conversation: direction boards, logo concepts, inspiration overlay, name picker. The finished steps are
// reopened from their folded entries for viewing only; no Choose, like or Send is pressed.
await scenario("conversation-kestrel", "audit-pro", async (page, log) => {
  await page.goto(conv("kestrel"));
  await settle(page, 5000);
  log.h1 = await page.evaluate(
    (hidden) =>
      [...document.querySelectorAll("h1")].map(
        (h) => `${h.innerText.trim()}${hidden.some((c) => h.classList.contains(c)) ? " (visually hidden)" : ""}`,
      ),
    VISUALLY_HIDDEN,
  );
  log.liveLog = await page.evaluate(() => {
    const l = document.querySelector('[role="log"]');
    return l
      ? {
          live: l.getAttribute("aria-live"),
          tabindex: l.getAttribute("tabindex"),
          label: l.getAttribute("aria-label"),
          descendants: l.querySelectorAll("*").length,
          images: l.querySelectorAll("img").length,
          nestedStatus: l.querySelectorAll('[role="status"], [role="alert"]').length,
        }
      : null;
  });
  // Creative direction: Change direction shows the three boards again (nothing is chosen until Choose is pressed).
  await reopenStep(page, "Creative direction", "Change direction");
  log.focusAfterReopenDirections = await active(page);
  log.directionCards = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('section[aria-label="Creative directions"] article.e-choice')];
    const group = cards[0]?.parentElement;
    return {
      count: cards.length,
      group: group
        ? `${group.tagName.toLowerCase()} role=${group.getAttribute("role")} label="${group.getAttribute("aria-label")}"`
        : null,
      labels: cards.map((c) => c.getAttribute("aria-label")),
      chooseButtons: cards.map((c) =>
        [...c.querySelectorAll("button[aria-pressed]")]
          .map((b) => `${b.innerText.trim()} pressed=${b.getAttribute("aria-pressed")} tabindex=${b.tabIndex}`)
          .join(", "),
      ),
      nestedControls: cards.map((c) => c.querySelectorAll("button, a").length),
      tag: cards[0]?.tagName,
    };
  });
  // direction board: larger view
  const expand = page.getByRole("button", { name: /^Enlarge Direction 1\b/u }).first();
  await expand.focus();
  await shot(page, "A-kbd-direction-card-focus");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  await shot(page, "A-kbd-direction-larger-view");
  log.largerViewDialog = await dialogReport(page);
  log.largerViewReturnedFocusToOpener = await expand.evaluate((el) => el === document.activeElement);
  // a direction's Choose button: focus ring and keys (not pressed: pressing would change the saved choice)
  await page
    .getByRole("article", { name: /^Direction 2:/u })
    .getByRole("button", { name: "Choose", exact: true })
    .focus();
  log.directionChooseFocus = await active(page);
  await page.keyboard.press("ArrowRight");
  log.afterArrowRightOnChoose = await active(page);
  // Logo: Change logo shows the six concepts again.
  await reopenStep(page, "Logo", "Change logo");
  log.focusAfterReopenLogo = await active(page);
  log.logoConcepts = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('section[aria-label="Logo concepts"] ol > li')];
    return cards.slice(0, 6).map((li) => {
      const controls = [...li.querySelectorAll("button, [role='button'], select, a")].map((c) => {
        const r = c.getBoundingClientRect();
        return `${c.tagName.toLowerCase()}${c.getAttribute("role") ? `[role=${c.getAttribute("role")}]` : ""} "${(c.getAttribute("aria-label") || c.innerText || "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)} tabindex=${c.tabIndex}${c.getAttribute("aria-pressed") ? ` pressed=${c.getAttribute("aria-pressed")}` : ""}`;
      });
      return controls;
    });
  });
  // Inspiration: Change inspiration shows the gallery again.
  await reopenStep(page, "Inspiration", "Change inspiration");
  log.focusAfterReopenInspiration = await active(page);
  const open = page.getByRole("button", { name: /^Open Archi-Tex: logo/u }).first();
  await open.focus();
  await shot(page, "A-kbd-inspiration-tile-focus");
  log.tileFocus = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    let clipper = null;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement)
      if (/hidden|clip/u.test(getComputedStyle(n).overflow)) {
        clipper = `${n.tagName.toLowerCase()}.${String(n.className).split(" ")[0]}`;
        break;
      }
    const r = el.getBoundingClientRect();
    const pr = el.parentElement.getBoundingClientRect();
    return {
      outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor} offset ${cs.outlineOffset}`,
      nearestClippingAncestor: clipper,
      elementRect: `${Math.round(r.width)}x${Math.round(r.height)}`,
      parentRect: `${Math.round(pr.width)}x${Math.round(pr.height)}`,
    };
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  await shot(page, "A-kbd-inspiration-overlay");
  log.inspirationOverlay = await dialogReport(page, { tabs: 10 });
  log.overlayReturnedFocusToOpener = await open.evaluate((el) => el === document.activeElement);
  // like heart: visible on focus? (focused only, never pressed)
  const heart = page.getByRole("button", { name: /^Like Archi-Tex logo/u }).first();
  await heart.focus();
  log.heartOnFocus = await page.evaluate(() => {
    const el = document.activeElement;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      opacity: getComputedStyle(el).opacity,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      topElementAtCentre:
        top === el || el.contains(top)
          ? "the heart itself"
          : `${top?.tagName.toLowerCase()}.${String(top?.className).split(" ")[0]}`,
      zIndex: getComputedStyle(el).zIndex,
    };
  });
  await shot(page, "A-kbd-inspiration-heart-focus");
  // Voice: Change name reopens the name picker in the work area (view only until a name is chosen).
  await reopenStep(page, "Voice", "Change name");
  log.afterChangeName = await active(page);
  log.nameDialogOpen = await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].length);
  log.workAreaAfterChangeName = await page.evaluate(() =>
    [...document.querySelectorAll("main h2, main h3")]
      .filter((h) => h.checkVisibility?.() !== false)
      .map((h) => h.innerText.trim().replace(/\s+/gu, " ").slice(0, 60))
      .slice(0, 8),
  );
  await shot(page, "A-kbd-change-name");
});

// 10. Out of credits. At 0 credits the Logo step marks it before any press (D-014): the start control is disabled
// and a note links to Plans. Nothing is pressed here; the start control is only inspected.
await scenario("out-of-credits-prompt", "audit-free", async (page, log) => {
  await page.goto(conv("berenice"));
  await settle(page, 5000);
  const startName = /^(Draw|Explore) six concepts$/u;
  await page.waitForFunction(
    (source) =>
      [...document.querySelectorAll("button")].some((b) =>
        new RegExp(source, "u").test((b.getAttribute("aria-label") || b.innerText).trim()),
      ),
    startName.source,
    { timeout: 45_000 },
  );
  log.startControl = await page.evaluate((source) => {
    const b = [...document.querySelectorAll("button")].find((n) =>
      new RegExp(source, "u").test((n.getAttribute("aria-label") || n.innerText).trim()),
    );
    const described = b.getAttribute("aria-describedby");
    return {
      name: (b.getAttribute("aria-label") || b.innerText).trim(),
      disabled: b.disabled,
      ariaDisabled: b.getAttribute("aria-disabled"),
      describedby: described
        ? described
            .split(" ")
            .map((i) => document.getElementById(i)?.innerText.trim())
            .join(" | ")
        : null,
    };
  }, startName.source);
  // Can a keyboard user reach the start control at all? (A disabled button is skipped by Tab.)
  log.startControlTakesFocus = await page.evaluate((source) => {
    const b = [...document.querySelectorAll("button")].find((n) =>
      new RegExp(source, "u").test((n.getAttribute("aria-label") || n.innerText).trim()),
    );
    b.focus();
    return document.activeElement === b;
  }, startName.source);
  log.noCreditsNote = await page.evaluate(() => {
    const p = [...document.querySelectorAll("main p, main div, main span")]
      .filter((n) => /no credits left this month/u.test(n.innerText ?? "") && n.checkVisibility?.() !== false)
      .at(-1);
    if (!p) return "not shown";
    const box = p.closest('[role="status"], [role="alert"], .e-message, [class*="message"]') ?? p;
    const link = box.querySelector("a");
    const r = box.getBoundingClientRect();
    return {
      tag: box.tagName.toLowerCase(),
      className: String(box.className).split(" ").slice(0, 2).join("."),
      role: box.getAttribute("role"),
      live: box.getAttribute("aria-live"),
      text: box.innerText.trim().replace(/\s+/gu, " ").slice(0, 200),
      link: link ? `${link.innerText.trim()} -> ${link.getAttribute("href")}` : null,
      color: getComputedStyle(box).color,
      rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
    };
  });
  // Keyboard path from the reply box to the note's See plans link.
  await page.locator("textarea").first().focus();
  const stops = [];
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    const where = await active(page);
    stops.push(where);
    if (/See plans/u.test(where)) break;
  }
  log.tabsFromReplyBoxToSeePlans = stops.some((s) => /See plans/u.test(s)) ? stops.length : "not reached in 25";
  log.globalPrompt = await page.evaluate(() => {
    const p = document.querySelector(".out-of-credits-prompt");
    return p ? p.innerText.trim().replace(/\s+/gu, " ").slice(0, 160) : "not shown";
  });
  await shot(page, "A-kbd-out-of-credits");
  log.otherMessages = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"], [role="status"]')]
      .filter((n) => n.innerText?.trim() && n.checkVisibility?.() !== false)
      .map((n) => `${n.getAttribute("role")}: ${n.innerText.trim().replace(/\s+/gu, " ").slice(0, 110)}`)
      .slice(0, 8),
  );
});

// 11. Library: details
await scenario("library-details", "audit-pro", async (page, log) => {
  await page.goto("/assets");
  await settle(page, 3500);
  const open = page.locator("button.assets-open").first();
  log.control = await open.evaluate((el) => ({
    name: el.getAttribute("aria-label") || el.innerText.trim(),
    card: el.closest("article")?.getAttribute("aria-label") ?? null,
  }));
  await open.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  log.dialogsOpen = await page.evaluate(() => document.querySelectorAll("dialog[open]").length);
  log.focusAfter = await active(page);
  await shot(page, "A-kbd-library-details");
  if (log.dialogsOpen) {
    log.dialog = await dialogReport(page);
    log.focusReturnedToOpener = await open.evaluate((el) => el === document.activeElement);
  }
  log.tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].map(
      (t) => `${t.innerText.trim()}:${t.getAttribute("aria-selected")}`,
    ),
  );
});

/** Keeps every Upgrade press away from payments: the checkout and portal requests are aborted (a network failure,
 * optionally after a delay) and any request to Stripe is blocked. Returns the list of blocked requests. */
async function blockCheckout(context, delayMs = 0) {
  const blocked = [];
  await context.route(/\/api\/billing\/(checkout|portal)/u, async (route) => {
    blocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route.abort("internetdisconnected");
  });
  await context.route(/stripe\.com/u, (route) => {
    blocked.push(`blocked ${new URL(route.request().url()).host}`);
    return route.abort("blockedbyclient");
  });
  return blocked;
}

// 12. Plans: upgrade with the checkout request blocked (no payment page opens)
await scenario("plans-upgrade", "audit-free", async (page, log, context) => {
  const blocked = await blockCheckout(context);
  await page.goto("/plans");
  await settle(page, 3000);
  // The plan card's button (an out-of-credits banner above the cards has its own Upgrade to Pro).
  const upgrade = page.locator(".plans-grid").getByRole("button", { name: "Upgrade to Pro", exact: true });
  await upgrade.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  log.blockedRequests = blocked;
  log.url = page.url().replace(ORIGIN, "");
  log.focusAfter = await active(page);
  log.messages = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"], [role="status"], .plans-notice')]
      .filter((n) => n.innerText?.trim())
      .map((n) => ({
        text: n.innerText.trim().slice(0, 140),
        role: n.getAttribute("role"),
        color: getComputedStyle(n).color,
        background: getComputedStyle(n).backgroundColor,
        inViewport: n.getBoundingClientRect().top < window.innerHeight,
      })),
  );
  log.planCards = await page.evaluate(() =>
    [...document.querySelectorAll(".plans-grid > *")].map((c) => ({
      tag: c.tagName.toLowerCase(),
      current: c.getAttribute("aria-current"),
      selected: c.dataset.selected ?? null,
      label: c.getAttribute("aria-label") || c.getAttribute("aria-labelledby"),
      text: c.innerText.trim().replace(/\s+/gu, " ").slice(0, 60),
    })),
  );
  await shot(page, "A-kbd-plans-upgrade-error");
});

// 13. Fixed chrome at 200% zoom: how much of the window is left for content?
await scenario(
  "zoom-200-chrome",
  "audit-pro",
  async (page, log) => {
    await page.goto(conv("kestrel"));
    await settle(page, 4000);
    log.viewport = "720x450 (1440x900 at 200%)";
    log.layers = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
      };
      const header = pick("header");
      if (header) header.position = getComputedStyle(document.querySelector("header")).position;
      const box = [...document.querySelectorAll("textarea")].find((t) => t.checkVisibility?.() !== false);
      const wrap = box?.closest("form") ?? box?.parentElement;
      const wr = wrap?.getBoundingClientRect();
      const composer = wr
        ? {
            top: Math.round(wr.top),
            bottom: Math.round(wr.bottom),
            height: Math.round(wr.height),
            inFirstScreen: wr.top < window.innerHeight,
          }
        : null;
      // A composer below the first screen scrolls with the page and takes no fixed room.
      const free = Math.min(composer?.top ?? window.innerHeight, window.innerHeight) - Math.max(header?.bottom ?? 0, 0);
      return {
        header,
        composer,
        composerPlaceholder: box?.placeholder ?? null,
        contentHeightLeft: free,
        shareLeft: `${Math.round((free / window.innerHeight) * 100)}%`,
      };
    });
    await shot(page, "A-kbd-zoom200-conversation");
  },
  { width: 720, height: 450 },
);

// 14. Inspiration tile: is the focus ring drawn at all? (2x crop)
await scenario(
  "tile-focus-crop",
  "audit-pro",
  async (page, log) => {
    await page.goto(conv("kestrel"));
    await settle(page, 4000);
    await reopenStep(page, "Inspiration", "Change inspiration");
    const open = page.getByRole("button", { name: /^Open Asteor: logo/u }).first();
    await open.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    const before = await open.boundingBox();
    const clip = { x: before.x - 30, y: before.y - 30, width: before.width + 60, height: before.height + 60 };
    await shot(page, "A-kbd-tile-unfocused", { clip });
    await page.keyboard.press("Tab");
    await open.focus();
    await page.waitForTimeout(300);
    const after = await open.boundingBox();
    await shot(page, "A-kbd-tile-focused", {
      clip: { x: after.x - 30, y: after.y - 30, width: after.width + 60, height: after.height + 60 },
    });
    log.focusVisible = await open.evaluate((el) => el.matches(":focus-visible"));
    log.clip = await open.evaluate((el) => {
      const out = [];
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        out.push(
          `${n.tagName.toLowerCase()}.${String(n.className).split(" ")[0]} ${Math.round(r.width)}x${Math.round(r.height)} overflow=${cs.overflow} radius=${cs.borderTopLeftRadius}`,
        );
        if (out.length >= 4) break;
      }
      return out;
    });
    // the brand title button, the heart and a secondary button for comparison
    const title = page.getByRole("button", { name: /^Asteor Open brand/u }).first();
    await title.focus();
    const tb = await title.boundingBox();
    await shot(page, "A-kbd-tile-title-focused", {
      clip: { x: tb.x - 30, y: tb.y - 30, width: tb.width + 60, height: tb.height + 60 },
    });
  },
  { width: 1440, height: 900 },
);

// 15. Where does focus go when an action starts? Sample it every 100 ms.
// The checkout request is held for 1.5 s and then fails (blocked), so the busy state is visible in the trace.
await scenario("focus-loss-on-submit", "audit-free", async (page, log, context) => {
  const blocked = await blockCheckout(context, 1500);
  await page.goto("/plans");
  await settle(page, 3000);
  const upgrade = page.locator(".plans-grid").getByRole("button", { name: "Upgrade to Pro", exact: true });
  await upgrade.focus();
  await page.evaluate(() => {
    window.__trace = [];
    const btn = document.activeElement;
    const t0 = performance.now();
    const id = setInterval(() => {
      const a = document.activeElement;
      window.__trace.push(
        `${Math.round(performance.now() - t0)}ms active=${a === document.body ? "BODY" : a.tagName.toLowerCase()} buttonConnected=${btn.isConnected} disabled=${btn.disabled} label="${btn.innerText.trim()}"`,
      );
      if (performance.now() - t0 > 3500) clearInterval(id);
    }, 100);
  });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3800);
  log.trace = await page.evaluate(() =>
    window.__trace.filter(
      (line, i, all) => i === 0 || line.replace(/^\d+ms /u, "") !== all[i - 1].replace(/^\d+ms /u, ""),
    ),
  );
  log.blockedRequests = blocked;
  log.url = page.url().replace(ORIGIN, "");
  log.focusAfter = await active(page);
  await page.keyboard.press("Tab");
  log.nextTabGoesTo = await active(page);
});

// 16. Settings: Usage tab markup (audit-pro has history)
await scenario("settings-usage", "audit-pro", async (page, log) => {
  await page.goto("/settings");
  await settle(page, 2500);
  await page.getByRole("tab", { name: "Usage" }).click();
  await page.waitForTimeout(3000);
  log.table = await page.evaluate(() => {
    const t = document.querySelector("table");
    if (!t) return "no table";
    const wrap = t.parentElement;
    return {
      caption: t.caption?.innerText ?? null,
      ariaLabel: t.getAttribute("aria-label") || t.getAttribute("aria-labelledby"),
      headers: [...t.querySelectorAll("th")]
        .slice(0, 8)
        .map((h) => `${h.innerText.trim()}(${h.getAttribute("scope")})`),
      rows: t.rows.length,
      wrapOverflowX: getComputedStyle(wrap).overflowX,
      wrapTabindex: wrap.getAttribute("tabindex"),
      tableWider: t.scrollWidth > wrap.clientWidth,
    };
  });
  log.panel = await page.evaluate(() => {
    const p = document.querySelector('[role="tabpanel"]:not([hidden])');
    return p ? { labelledby: p.getAttribute("aria-labelledby"), tabindex: p.getAttribute("tabindex") } : null;
  });
  await shot(page, "A-kbd-settings-usage-pro");
});

await browser.close();
let previous = {};
try {
  previous = JSON.parse(readFileSync(path.join(OUT, "keyboard.json"), "utf8"));
} catch {}
writeFileSync(path.join(OUT, "keyboard.json"), `${JSON.stringify({ ...previous, ...results }, null, 1)}\n`);
