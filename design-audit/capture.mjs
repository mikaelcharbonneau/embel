#!/usr/bin/env node
// Design-audit screenshot capture. Recaptures every route, state and width with stable file names:
//   <outDir>/<route-slug>__<state>__<width>.png     plus   <outDir>/manifest.json
//
//   node design-audit/capture.mjs [outDir] [options]
//     outDir            output folder (default design-audit/evidence/screens/)
//     --widths=390,768,1440   widths to capture (default all three)
//     --only=<text>[,<text>]   only states whose file stem contains one of the texts (e.g. --only=kestrel,hover)
//     --workers=<n>     parallel browser contexts (default 3)
//     --recipes         also capture the states that change seeded data (stand-in AI modes, new briefs).
//                       Run these LAST and reseed afterwards: node design-audit/seed/seed.mjs
//     --failed          re-run only the states the last run listed as problems (reads <outDir>/manifest.json)
//     --list            print the state names and exit
//     --headed          show the browser
//
// Needs the audit stack running (node design-audit/seed/serve.mjs) and a seed
// (node design-audit/seed/seed.mjs). Local only: refuses any address that is not 127.0.0.1/localhost.
// Elements are found by role, label, visible text or URL, never by CSS class.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.AUDIT_ORIGIN ?? "http://127.0.0.1:3105";
const AI_ORIGIN = process.env.AUDIT_AI_ORIGIN ?? "http://127.0.0.1:3186";
if (
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/u.test(ORIGIN) ||
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/u.test(AI_ORIGIN)
)
  throw new Error("Refusing to run: the audit only captures a local app (127.0.0.1 or localhost).");

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(HERE, "evidence/screens"));
const WIDTHS = flag("widths", "390,768,1440").split(",").map(Number);
const HEIGHT = { 390: 844, 768: 1024, 1440: 900 };
const ONLY = flag("only", "");
const WORKERS = Number(flag("workers", "3"));
const RECIPES = has("recipes");

// ---------------------------------------------------------------- seeded data
const credentials = JSON.parse(readFileSync(path.join(HERE, ".audit-credentials"), "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(HERE, ".logs/last-seed.json"), "utf8")).results;
const brand = (key) => {
  const hit = seeded.find((r) => r.key === key);
  if (!hit) throw new Error(`Brand "${key}" is not in design-audit/.logs/last-seed.json. Run the seed first.`);
  return hit.projectId;
};
const MISSING_PROJECT = "00000000-0000-4000-8000-000000000000";
const AUTH_DIR = path.join(HERE, ".auth");
mkdirSync(AUTH_DIR, { recursive: true });

// ---------------------------------------------------------------- page helpers
const HIDE_CHROME = `
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
  nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }
`;

/** Thrown when a page that must be signed in shows the signed-out screen. Stops the whole run. */
class LoginWall extends Error {}

/** The round account button in the navigation pill (labelled "Account menu", or "Account menu, checking your account"). */
const accountButton = (page) => page.locator("[data-account-menu-trigger]").first();

async function signedIn(page) {
  return accountButton(page).isVisible();
}

/** Opens a path and checks the account really is signed in (fails loudly otherwise). */
async function open(page, account, route, { idle = true } = {}) {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  if (account) await requireSignedIn(page, account, route);
  // Loading states hold requests on purpose, so they must not wait for the network to go quiet.
  if (idle) await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

async function requireSignedIn(page, account, route) {
  const menu = accountButton(page);
  const wall = page.getByText(/Sign in to (see|save|choose|edit)/u).first();
  const result = await Promise.race([
    menu.waitFor({ state: "visible", timeout: 30_000 }).then(() => "ok"),
    wall.waitFor({ state: "visible", timeout: 30_000 }).then(() => "wall"),
  ]).catch(() => "timeout");
  // A stale saved session shows the account menu first and the sign-in prompt a moment later,
  // once the server has rejected it, so look again after the page has settled.
  const late = result === "ok" ? await settledWall(page, wall) : false;
  if (result !== "ok" || late)
    throw new LoginWall(
      `${account} should be signed in on ${route} but the page shows ${result === "ok" || result === "wall" ? "the sign-in prompt" : "no account menu"}. ` +
        `Delete design-audit/.auth/${account}.json and re-run (a reseed invalidates saved sessions).`,
    );
}
async function settledWall(page, wall) {
  await page.waitForTimeout(2500);
  return wall.isVisible();
}

/** Waits until the usual "still loading" texts are gone (bounded; some states legitimately keep one). */
async function loaded(page, { extra = 400 } = {}) {
  await page
    .waitForFunction(
      () =>
        !/(^|\n)\s*(Loading (your )?(projects|project|library|saved preview|assets|account|activity)|Preparing…|Checking (your )?(account|plan)…)/u.test(
          document.body.innerText,
        ),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((i) =>
        i.complete
          ? 0
          : new Promise((r) => {
              i.onload = i.onerror = r;
              setTimeout(r, 8000);
            }),
      ),
    );
  });
  await page.waitForTimeout(extra);
}

/** Grows the viewport to the tallest inner scroller so a normal screenshot shows the whole page. */
async function fitToContent(page, width) {
  const base = HEIGHT[width] ?? 900;
  let height = base;
  for (let i = 0; i < 4; i++) {
    const extra = await page.evaluate((viewport) => {
      let max = 0;
      for (const el of document.querySelectorAll("body *")) {
        if (el.clientHeight < viewport * 0.5 || el.scrollHeight <= el.clientHeight + 4) continue;
        const o = getComputedStyle(el).overflowY;
        if (o === "auto" || o === "scroll" || o === "hidden") max = Math.max(max, el.scrollHeight - el.clientHeight);
      }
      return Math.max(max, document.documentElement.scrollHeight - innerHeight);
    }, height);
    if (extra <= 4 || height >= 15_000) break;
    height = Math.min(15_000, height + extra);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(350);
  }
  return height;
}

// ---------------------------------------------------------------- state list
const states = []; // { route, state, account, recipe, run(page, helpers) }
function state(route, name, account, run, options = {}) {
  states.push({ route, state: name, account, run, ...options });
}
const stem = (s) => `${s.route}__${s.state}`;

const hold = (page, pattern) => page.route(pattern, () => {}); // request never answers: shows the loading state
const fail = (page, pattern, status = 500, body = "{}") =>
  page.route(pattern, (r) => r.fulfill({ status, contentType: "application/json", body }));

// ---- signed out -----------------------------------------------------------
state("home", "signed-out", null, async (page) => {
  await open(page, null, "/");
  await page.getByRole("textbox", { name: "Your prompt" }).waitFor();
  await loaded(page);
});
state("home", "signed-out-prompt-filled", null, async (page) => {
  await open(page, null, "/");
  await page
    .getByRole("textbox", { name: "Your prompt" })
    .fill("A neighborhood coffee shop that roasts its own beans and sells to offices.");
  await loaded(page);
});
state("home", "signed-out-prompt-focus", null, async (page) => {
  await open(page, null, "/");
  await page.getByRole("textbox", { name: "Your prompt" }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // keyboard focus shows the focus ring
  await loaded(page);
});
state("home", "signed-out-sign-in-overlay", null, async (page) => {
  await open(page, null, "/");
  await page.waitForTimeout(1500); // the pill settles after the session check
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await loaded(page);
});
state("home", "signed-out-sign-up-overlay", null, async (page) => {
  // At 390 px the pill only shows Sign in, so go through the Sign in overlay's own Create account link.
  await open(page, null, "/");
  await page.waitForTimeout(1500);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Create account" }).click();
  await page.getByRole("dialog").getByRole("form", { name: "Create account", exact: true }).waitFor();
  await loaded(page);
});
state("home", "signed-out-sign-in-overlay-error-by-field", null, async (page) => {
  // The sign-in answer is given by the script (401), so no account is touched.
  await fail(page, "**/api/auth/sign-in", 401, JSON.stringify({ error: { code: "invalid_credentials" } }));
  await open(page, null, "/");
  await page.waitForTimeout(1500);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  const form = page.getByRole("dialog").getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill("ana@fieldnotes.example");
  await form.getByLabel("Password", { exact: true }).fill("not-the-password-1");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
  await loaded(page);
});
state("home", "signed-out-sign-up-overlay-errors-by-field", null, async (page) => {
  await open(page, null, "/");
  await page.waitForTimeout(1500);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Create account" }).click();
  const form = page.getByRole("dialog").getByRole("form", { name: "Create account", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill("ana@fieldnotes.example");
  await form.getByLabel("Password", { exact: true }).fill("short-one");
  await form.getByLabel("Confirm password").fill("different");
  await form.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
  await loaded(page);
});
state("sign-in", "default", null, async (page) => {
  await open(page, null, "/sign-in");
  await page.getByRole("form", { name: "Sign in", exact: true }).waitFor();
  await loaded(page);
});
state("sign-in", "error-wrong-password", null, async (page) => {
  await open(page, null, "/sign-in");
  await page.waitForTimeout(1500); // typed text can be wiped in the first seconds (README issue 2)
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill("audit-fresh@example.test");
  await form.getByLabel("Password", { exact: true }).fill("not-the-password-1");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").first().waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("sign-in", "email-confirmed-notice", null, async (page) => {
  await open(page, null, "/sign-in?confirmation=complete");
  await loaded(page);
});
state("sign-in", "email-confirmation-failed-notice", null, async (page) => {
  await open(page, null, "/sign-in?confirmation=failed");
  await loaded(page);
});
state("sign-in", "password-shown", null, async (page) => {
  await open(page, null, "/sign-in");
  await page.waitForTimeout(1500);
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByLabel("Password", { exact: true }).fill("example-password");
  await form.getByRole("button", { name: "Show password" }).click();
  await loaded(page);
});
state("sign-up", "default", null, async (page) => {
  await open(page, null, "/sign-up");
  await page.getByRole("form", { name: "Create account", exact: true }).waitFor();
  await loaded(page);
});
state("sign-up", "validation-password-mismatch", null, async (page) => {
  await open(page, null, "/sign-up");
  await page.waitForTimeout(1500);
  const form = page.getByRole("form", { name: "Create account", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill("someone@example.test");
  await form.getByLabel("Password", { exact: true }).fill("short");
  await form.getByLabel("Confirm password").fill("different-1");
  await form.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
  await loaded(page);
});
state("forgot-password", "default", null, async (page) => {
  await open(page, null, "/forgot-password");
  await page.getByRole("form", { name: "Request a password reset link" }).waitFor();
  await loaded(page);
});
state("forgot-password", "sent", null, async (page) => {
  // The request is answered by the script, so no email is created, not even in the local inbox.
  await page.route("**/api/auth/password-reset", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requested: true }) }),
  );
  await open(page, null, "/forgot-password");
  await page.waitForTimeout(1500);
  const form = page.getByRole("form", { name: "Request a password reset link" });
  await form.getByRole("textbox").fill("someone@example.test");
  await form.getByRole("button").click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 15_000 });
  await loaded(page);
});
state("forgot-password", "error-rate-limited", null, async (page) => {
  await fail(page, "**/api/auth/password-reset", 429, JSON.stringify({ error: { code: "auth_rate_limited" } }));
  await open(page, null, "/forgot-password");
  await page.waitForTimeout(1500);
  const form = page.getByRole("form", { name: "Request a password reset link" });
  await form.getByRole("textbox").fill("someone@example.test");
  await form.getByRole("button").click();
  await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
  await loaded(page);
});
state("reset-password", "no-recovery-session", null, async (page) => {
  await open(page, null, "/reset-password");
  await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
  await loaded(page);
});
for (const [name, status, body] of [
  ["saved", 200, { updated: true }],
  ["error-link-expired", 401, { error: { code: "recovery_required" } }],
])
  state("reset-password", name, null, async (page) => {
    // The request is answered by the script; no password is changed anywhere.
    await page.route("**/api/auth/password", (r) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
    );
    await open(page, null, "/reset-password");
    await page.waitForTimeout(1500);
    const form = page.getByRole("form", { name: "Choose a new password" });
    await form.getByLabel("New password", { exact: true }).fill("a-long-example-password-1");
    await form.getByLabel("Confirm new password").fill("a-long-example-password-1");
    await form.getByRole("button", { name: "Save new password" }).click();
    await page
      .getByRole("heading", { name: name === "saved" ? "Your password is updated" : "This link has expired" })
      .waitFor({ timeout: 15_000 });
    await loaded(page);
  });
for (const [route, slug, text] of [
  ["/brands", "projects", "Sign in to see your projects"],
  ["/assets", "library", "Sign in to see your library"],
  ["/plans", "plans", "Sign in to choose a plan."],
  ["/settings", "settings", "Sign in to edit your profile and preferences."],
  [`/brands/account/${MISSING_PROJECT}`, "project-workspace", "Sign in to see and save your work."],
])
  state(slug, "signed-out", null, async (page) => {
    await open(page, null, route);
    await page.getByText(text).first().waitFor({ timeout: 20_000 });
    await loaded(page);
  });
state("recover-project", "signed-out-none-available", null, async (page) => {
  await open(page, null, `/brands/${MISSING_PROJECT}`);
  await loaded(page);
});
state("not-found", "default", null, async (page) => {
  await open(page, null, "/this-page-does-not-exist");
  await page.getByRole("heading", { name: "Page not found" }).waitFor();
  await loaded(page);
});

// ---- audit-fresh: first visit, empty states ---------------------------------
state("home", "empty-fresh", "audit-fresh", async (page) => {
  await open(page, "audit-fresh", "/");
  await page.getByRole("textbox", { name: "Your prompt" }).waitFor();
  await loaded(page);
});
state("projects", "empty-fresh", "audit-fresh", async (page) => {
  await open(page, "audit-fresh", "/brands");
  await page.getByRole("heading", { name: "Your first project starts with an idea" }).waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("projects-deleted", "empty-fresh", "audit-fresh", async (page) => {
  await open(page, "audit-fresh", "/brands?state=deleted");
  await page.getByRole("heading", { name: "No deleted projects" }).waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("library", "empty-fresh", "audit-fresh", async (page) => {
  await open(page, "audit-fresh", "/assets");
  await loaded(page);
});
state("plans", "free-30-credits-fresh", "audit-fresh", async (page) => {
  await open(page, "audit-fresh", "/plans");
  await page.getByText("Credits left").waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("settings", "account-fresh", "audit-fresh", async (page) => {
  await open(page, "audit-fresh", "/settings");
  await page.getByRole("tab", { name: "Account" }).waitFor();
  await loaded(page);
});
state("settings", "usage-empty-fresh", "audit-fresh", async (page) => {
  await open(page, "audit-fresh", "/settings");
  await page.getByRole("tab", { name: "Usage" }).click();
  await loaded(page);
});
for (const [query, name] of [
  ["?checkout=success", "return-checkout-success"],
  ["?checkout=cancelled", "return-checkout-cancelled"],
  ["?portal=updated", "return-portal-updated"],
])
  state("plans", `${name}-fresh`, "audit-fresh", async (page) => {
    await open(page, "audit-fresh", `/plans${query}`);
    await page.getByRole("status").first().waitFor({ timeout: 30_000 });
    await loaded(page);
  });

// ---- audit-free: 0 credits, eight brands ----------------------------------
state("home", "recent-brands-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/");
  await page.getByRole("heading", { name: "Recent projects" }).waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("projects", "eight-brands-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/brands");
  await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("projects", "search-no-match-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/brands");
  await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
  await page
    .getByRole("searchbox", { name: /Search projects/u })
    .or(page.getByRole("textbox", { name: /Search projects/u }))
    .fill("zzzz-nothing");
  await page.getByRole("heading", { name: /^No projects match/u }).waitFor({ timeout: 10_000 });
  await loaded(page);
});
state("projects", "options-menu-open-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/brands");
  await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: /^Project options for/u })
    .first()
    .click();
  await loaded(page);
});
state("projects", "delete-dialog-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/brands");
  await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
  await page
    .getByRole("button", { name: /^Project options for/u })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").waitFor();
  await loaded(page);
});
state("projects", "loading-skeleton-free", "audit-free", async (page) => {
  await hold(page, "**/api/projects/page**");
  await hold(page, "**/api/projects?**");
  await open(page, "audit-free", "/brands", { idle: false });
  await page.waitForTimeout(1500);
});
state("projects", "error-api-500-free", "audit-free", async (page) => {
  await fail(page, "**/api/projects/page**");
  await fail(page, "**/api/projects?**");
  await open(page, "audit-free", "/brands");
  await page.waitForTimeout(2500);
});
state("projects-deleted", "empty-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/brands?state=deleted");
  await page.getByRole("heading", { name: "No deleted projects" }).waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("library", "kept-assets-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/assets");
  await loaded(page);
});
state("library", "all-generations-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/assets");
  await page.getByRole("tab", { name: "Everything made" }).click();
  await loaded(page);
});
state("plans", "free-0-credits-upgrade-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/plans");
  await page.getByRole("button", { name: /Upgrade to Pro/u }).waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("plans", "upgrade-unavailable-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/plans");
  await page.getByRole("button", { name: /Upgrade to Pro/u }).click();
  await page.getByText(/Payments are unavailable/u).waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("settings", "account-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/settings");
  await page.getByRole("tab", { name: "Account" }).waitFor();
  await loaded(page);
});
state("settings", "usage-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/settings");
  await page.getByRole("tab", { name: "Usage" }).click();
  await loaded(page);
});
state("settings", "delete-account-dialog-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/settings");
  await page.getByRole("button", { name: "Delete account" }).first().click();
  await page.getByRole("dialog").waitFor();
  await loaded(page); // nothing is confirmed
});
state("settings", "save-error-offline-free", "audit-free", async (page) => {
  await open(page, "audit-free", "/settings");
  await page.waitForTimeout(1500);
  await page.getByRole("textbox", { name: "Full name" }).fill("Audit Free Person");
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText(/Saving could not be confirmed/u).waitFor({ timeout: 30_000 });
  await loaded(page);
  await page.context().setOffline(false);
});

// ---- brands, one per stage ---------------------------------------------------
const STAGES = [
  ["spokesmith", "audit-free", "research-done", "free"],
  ["brightsmile", "audit-free", "strategy-done", "free"],
  ["northernlights", "audit-free", "voice-done-long-name", "free"],
  ["berenice", "audit-free", "inspiration-chosen", "free"],
  ["quill", "audit-free", "logos-generated", "free"],
  ["tidewater", "audit-free", "logos-partly-failed", "free"],
  ["mosswood", "audit-free", "directions-generated", "free"],
  ["orchardlane", "audit-free", "complete-showcase", "free"],
  ["kestrel", "audit-pro", "complete-showcase", "pro"],
  ["aurelie", "audit-pro", "complete-accents", "pro"],
  ["brightharbor", "audit-pro", "complete-placeholders", "pro"],
];
for (const [key, account, label, who] of STAGES) {
  state("brand-conversation", `${key}-${label}-${who}`, account, async (page) => {
    await open(page, account, `/brands/account/${brand(key)}?view=strategy`);
    await accountButton(page).waitFor();
    await page.waitForTimeout(2500);
    await loaded(page, { extra: 1200 });
  });
}
for (const [key, account, who] of [
  ["kestrel", "audit-pro", "pro"],
  ["aurelie", "audit-pro", "pro"],
  ["brightharbor", "audit-pro", "pro"],
  ["orchardlane", "audit-free", "free"],
]) {
  state("brand-assets", `${key}-ready-${who}`, account, async (page) => {
    await open(page, account, `/brands/account/${brand(key)}/logo/deliverables`);
    await page.getByRole("status").filter({ hasText: "Ready to download." }).waitFor({ timeout: 120_000 });
    await loaded(page, { extra: 1000 });
  });
}
state("brand-assets", "kestrel-preparing-pro", "audit-pro", async (page) => {
  await hold(page, "**/api/assets/**");
  await hold(page, "**/api/projects/*/logo/deliverables**");
  await open(page, "audit-pro", `/brands/account/${brand("kestrel")}/logo/deliverables`, { idle: false });
  await page.getByRole("button", { name: "Preparing brand kit", exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
});
// The other two tabs of the delivery page, and the toast after the kit downloads.
for (const tab of ["Brand guidelines", "Design system"]) {
  state("brand-assets", `kestrel-${tab.toLowerCase().replace(" ", "-")}-tab-pro`, "audit-pro", async (page) => {
    await open(page, "audit-pro", `/brands/account/${brand("kestrel")}/logo/deliverables`);
    await page.getByRole("status").filter({ hasText: "Ready to download." }).waitFor({ timeout: 120_000 });
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await loaded(page, { extra: 1000 });
  });
}
state("brand-assets", "kestrel-kit-downloaded-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", `/brands/account/${brand("kestrel")}/logo/deliverables`);
  await page.getByRole("status").filter({ hasText: "Ready to download." }).waitFor({ timeout: 120_000 });
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download brand kit", exact: true }).click(),
  ]);
  await page.getByText("Brand kit downloaded").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
});
state("brand-identity", "kestrel-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", `/brands/account/${brand("kestrel")}/identity`);
  await loaded(page, { extra: 1200 });
});
state("brand-recover", "owner-no-unsaved-project-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", `/brands/${brand("kestrel")}`);
  await loaded(page);
});
state("project-workspace", "missing-project-pro", "audit-pro", async (page) => {
  await page.goto(`/brands/account/${MISSING_PROJECT}`, { waitUntil: "domcontentloaded" });
  await page
    .getByText(/not available to this account|could not be checked/u)
    .first()
    .waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("project-workspace", "error-api-500-pro", "audit-pro", async (page) => {
  await fail(page, "**/api/projects/**");
  await page.goto(`/brands/account/${brand("kestrel")}?view=strategy`, { waitUntil: "domcontentloaded" });
  await page
    .getByText(/could not be reached/u)
    .first()
    .waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("project-workspace", "loading-pro", "audit-pro", async (page) => {
  await hold(page, "**/api/projects/**");
  await page.goto(`/brands/account/${brand("kestrel")}?view=strategy`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
});

// ---- audit-pro: paid account ---------------------------------------------------
state("home", "recent-brands-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/");
  await page.getByRole("heading", { name: "Recent projects" }).waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("projects", "three-brands-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/brands");
  await page.getByRole("region", { name: "Projects" }).getByRole("article").first().waitFor({ timeout: 30_000 });
  await loaded(page, { extra: 1200 });
});
state("library", "kept-assets-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/assets");
  await page.getByText(/assets loaded/u).waitFor({ timeout: 30_000 });
  await loaded(page, { extra: 1200 });
});
state("library", "all-generations-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/assets");
  await page.getByRole("tab", { name: "All generations" }).click();
  await page.getByText(/assets loaded/u).waitFor({ timeout: 30_000 });
  await loaded(page, { extra: 1200 });
});
state(
  "library",
  "asset-detail-dialog-pro",
  "audit-pro",
  async (page) => {
    await open(page, "audit-pro", "/assets");
    await page.getByText(/assets loaded/u).waitFor({ timeout: 30_000 });
    await page
      .getByLabel(/^View details of /u)
      .first()
      .click();
    await page.getByRole("dialog").waitFor();
    await loaded(page, { extra: 1000 });
  },
  {
    skip: "The View details button does not open the dialog in Playwright at 390/768/1440 (no console error). See 00_inventory.md, Could not reach.",
  },
);
state("plans", "pro-current-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/plans");
  await page.getByText("Current plan").first().waitFor({ timeout: 30_000 });
  await loaded(page);
});
state("settings", "account-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/settings");
  await page.getByRole("tab", { name: "Account" }).waitFor();
  await loaded(page);
});
state("settings", "usage-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/settings");
  await page.getByRole("tab", { name: "Usage" }).click();
  await loaded(page, { extra: 800 });
});
state("home", "account-menu-open-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/");
  await accountButton(page).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).waitFor();
  await loaded(page);
});

state("home", "generation-activity-dialog-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", "/");
  await accountButton(page).click();
  await page.getByRole("menuitem", { name: "Activity", exact: true }).click();
  await page.getByRole("dialog", { name: "Activity", exact: true }).waitFor({ timeout: 15_000 });
  await loaded(page);
});
state("brand-conversation", "kestrel-change-name-open-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", `/brands/account/${brand("kestrel")}?view=strategy`);
  await page.waitForTimeout(2500);
  // The name is folded in the chat with the rest of Voice: open it, then Change name.
  await page
    .locator("details.conversation-folded", { has: page.getByRole("button", { name: "Change name" }) })
    .locator("summary")
    .click();
  await page.getByRole("button", { name: "Change name" }).click();
  await page.waitForTimeout(2500);
  await loaded(page, { extra: 1200 });
});
// Name details: opening them only reads which checks are connected; nothing is looked up.
state("brand-conversation", "kestrel-name-details-pro", "audit-pro", async (page) => {
  await open(page, "audit-pro", `/brands/account/${brand("kestrel")}?view=strategy`);
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Change name" }).click();
  await page
    .getByRole("region", { name: "Naming exploration", exact: true })
    .getByRole("button", { name: /^Details for / })
    .first()
    .click();
  await page.getByRole("dialog").first().waitFor();
  await loaded(page, { extra: 800 });
});

// ---- out of credits at the Logo step (audit-free has 0 credits; nothing is spent) --------
// The Logo step marks 0 credits before the click (D-014): the note sits in the chat and Send ("Draw six concepts",
// the logo types as chips in the reply box) is off, so no request is refused.
const replyBox = (page) => page.getByRole("form", { name: "Reply", exact: true });
state("brand-conversation", "out-of-credits-prompt-free", "audit-free", async (page) => {
  await open(page, "audit-free", `/brands/account/${brand("berenice")}?view=strategy#journey-logo`);
  await replyBox(page).getByRole("button", { name: "Draw six concepts", exact: true }).waitFor({ timeout: 60_000 });
  await page.getByText("You have no credits left this month.").first().waitFor({ timeout: 30_000 });
  await loaded(page);
});

// ---- the larger views of a logo concept and a direction board (over the work area; the chat stays usable) -------
state("brand-conversation", "quill-logo-larger-view-free", "audit-free", async (page) => {
  await open(page, "audit-free", `/brands/account/${brand("quill")}?view=strategy#journey-logo`);
  const grid = page.getByRole("region", { name: "Logo concepts", exact: true });
  await grid.getByRole("button", { name: "Enlarge Concept 2", exact: true }).click({ timeout: 60_000 });
  await page.getByRole("dialog", { name: "Concept 2" }).waitFor();
  await loaded(page, { extra: 800 });
});
state("brand-conversation", "mosswood-direction-larger-view-free", "audit-free", async (page) => {
  await open(page, "audit-free", `/brands/account/${brand("mosswood")}?view=strategy`);
  const step = page.getByRole("region", { name: "Creative direction", exact: true });
  await step.getByRole("button", { name: /^Enlarge Direction 1, /u }).click({ timeout: 60_000 });
  await page.getByRole("dialog").first().waitFor();
  await loaded(page, { extra: 800 });
});

// ---- hover, keyboard focus and disabled controls (viewport-wide captures, mouse left in place) -------
state(
  "home",
  "hover-create-account",
  null,
  async (page) => {
    await open(page, null, "/");
    await page.waitForTimeout(1500);
    await page.getByRole("link", { name: "Create account", exact: true }).hover();
    await loaded(page);
  },
  { keepMouse: true, widths: [768, 1440] },
); // the pill hides Create account at 390
state(
  "home",
  "hover-starter-chip",
  null,
  async (page) => {
    await open(page, null, "/");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "A skincare studio" }).hover();
    await loaded(page);
  },
  { keepMouse: true },
);
state(
  "home",
  "hover-nav-link",
  null,
  async (page) => {
    await open(page, null, "/");
    await page.waitForTimeout(1500);
    await page.getByRole("link", { name: "Projects", exact: true }).hover();
    await loaded(page);
  },
  { keepMouse: true },
);
state("home", "keyboard-focus-nav", null, async (page) => {
  await open(page, null, "/");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab"); // brand
  await page.keyboard.press("Tab"); // Home
  await page.keyboard.press("Tab"); // Projects
  await loaded(page);
});
state("sign-in", "keyboard-focus-submit", null, async (page) => {
  await open(page, null, "/sign-in");
  await page.waitForTimeout(1500);
  await page.getByRole("form", { name: "Sign in", exact: true }).getByLabel("Password", { exact: true }).focus();
  await page.keyboard.press("Tab"); // show password
  await page.keyboard.press("Tab"); // submit (Forgot password? sits on the label line, before the field)
  await loaded(page);
});
state(
  "projects",
  "hover-project-card-pro",
  "audit-pro",
  async (page) => {
    await open(page, "audit-pro", "/brands");
    const card = page.getByRole("region", { name: "Projects" }).getByRole("article").first();
    await card.waitFor({ timeout: 30_000 });
    await loaded(page, { extra: 1200 });
    await card.hover();
  },
  { keepMouse: true },
);
state("brand-conversation", "logo-step-no-type-selected-disabled-explore-free", "audit-free", async (page) => {
  await open(page, "audit-free", `/brands/account/${brand("berenice")}?view=strategy#journey-logo`);
  // The logo types are choice cards in the work area and chips in the reply box; with none, Send stays off.
  const types = page.getByRole("group", { name: "Which logo types should I explore?", exact: true });
  await types.waitFor({ timeout: 60_000 });
  for (const type of [
    "Wordmark",
    "Lettermark or monogram",
    "Pictorial mark",
    "Abstract mark",
    "Combination mark",
    "Emblem",
    "Mascot",
  ]) {
    const toggle = types.getByRole("checkbox", { name: type, exact: true });
    if (await toggle.isChecked()) await toggle.uncheck();
  }
  await page.getByText("Choose at least one type").first().waitFor({ timeout: 10_000 });
  await loaded(page);
});

// ---------------------------------------------------------------- recipes (mutating)
const aiMode = (body) =>
  fetch(`${AI_ORIGIN}/__mode`, { method: "POST", body: JSON.stringify(body) }).then((r) => {
    if (!r.ok) throw new Error(`stand-in AI refused ${JSON.stringify(body)}`);
  });
if (RECIPES) {
  state(
    "home",
    "research-in-progress-pro",
    "audit-pro",
    async (page) => {
      await aiMode({ text: "hold" });
      await open(page, "audit-pro", "/");
      await page
        .getByRole("textbox", { name: "Your prompt" })
        .fill("A mobile bike repair service that comes to your office.");
      await page.getByRole("button", { name: "Send prompt", exact: true }).click();
      await page.getByText(/Researching your competitors/u).waitFor({ timeout: 120_000 });
      await loaded(page);
    },
    { recipe: true },
  );
  state(
    "home",
    "research-failed-pro",
    "audit-pro",
    async (page) => {
      await aiMode({ text: "fail" });
      await open(page, "audit-pro", "/");
      await page.getByRole("textbox", { name: "Your prompt" }).fill("A pottery studio that runs evening classes.");
      await page.getByRole("button", { name: "Send prompt", exact: true }).click();
      await page.getByRole("button", { name: /Retry research/u }).waitFor({ timeout: 180_000 });
      await loaded(page);
    },
    { recipe: true },
  );
  state(
    "brand-conversation",
    "logos-drawing-aurelie-pro",
    "audit-pro",
    async (page) => {
      await aiMode({ text: "normal", images: "slow", delayMs: 120_000 });
      // A finished brand shows the brand; the link opens its Logo step in the work area.
      await open(page, "audit-pro", `/brands/account/${brand("aurelie")}?view=strategy#journey-logo`);
      await page.getByRole("button", { name: "More concepts" }).first().click();
      await page
        .getByRole("img", { name: /^Concept [1-6] is being drawn$/u })
        .first()
        .waitFor({ timeout: 60_000 });
      await loaded(page);
    },
    { recipe: true, widths: [1440] },
  ); // one active logo run per brand: 1440 only
  state(
    "brand-conversation",
    "logos-failed-brightharbor-pro",
    "audit-pro",
    async (page) => {
      await aiMode({ images: "refuse" });
      await open(page, "audit-pro", `/brands/account/${brand("brightharbor")}?view=strategy#journey-logo`);
      await page.getByRole("button", { name: "More concepts" }).first().click();
      await page.getByRole("button", { name: /Retry \d+ failed concepts/u }).waitFor({ timeout: 180_000 });
      await loaded(page);
    },
    { recipe: true, widths: [1440] },
  ); // one active logo run per brand: 1440 only
}

// ---------------------------------------------------------------- runner
const manifestPath = path.join(outDir, "manifest.json");
const previous = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { screenshots: [], problems: [] };
const failedStems = new Set(previous.problems.map((p) => p.file.replace(/__\d+\.png$/u, "")));
const selected = states.filter(
  (s) => !s.skip && ONLY.split(",").some((t) => stem(s).includes(t)) && (!has("failed") || failedStems.has(stem(s))),
);
if (has("list")) {
  for (const s of selected)
    console.log(`${stem(s).padEnd(70)} ${s.account ?? "(signed out)"}${s.recipe ? "  [recipe]" : ""}`);
  for (const s of states.filter((x) => x.skip)) console.log(`${stem(s).padEnd(70)} SKIPPED: ${s.skip}`);
  console.log(`${selected.length} states x ${WIDTHS.length} widths`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const browser = await launchBrowser({ headless: !has("headed") });
const contexts = new Map(); // account -> context (one per worker)

async function newContext(account, width) {
  const options = {
    baseURL: ORIGIN,
    viewport: { width, height: HEIGHT[width] ?? 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Toronto",
  };
  const file = path.join(AUTH_DIR, `${account}.json`);
  if (account && existsSync(file)) options.storageState = file;
  const context = await browser.newContext(options);
  // Same calm page on every navigation: no animation, no dev-tools badge.
  await context.addInitScript((css) => {
    const add = () => {
      const style = document.createElement("style");
      style.textContent = css;
      (document.head ?? document.documentElement).appendChild(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true });
    else add();
  }, HIDE_CHROME);
  return context;
}

/** Signs in with the form (as the seed does) and saves the session for the next run. */
async function signInAndSave(account, width) {
  const creds = credentials.find((c) => c.account === account);
  const context = await newContext(null, width);
  const page = await context.newPage();
  await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByRole("form", { name: "Sign in", exact: true }).waitFor();
  await page.waitForTimeout(2000);
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill(creds.email);
  await form.getByLabel("Password", { exact: true }).fill(creds.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !/sign-in/u.test(url.pathname), { timeout: 60_000 });
  await requireSignedIn(page, account, "/ (after sign-in)");
  await context.storageState({ path: path.join(AUTH_DIR, `${account}.json`) });
  await context.close();
}

const sessionChecked = new Set();
async function ensureSession(account) {
  if (!account || sessionChecked.has(account)) return;
  const file = path.join(AUTH_DIR, `${account}.json`);
  let valid = false;
  if (existsSync(file)) {
    const context = await newContext(account, 1440);
    const page = await context.newPage();
    // Probe a page that needs the server to accept the session, not just a cookie that looks valid.
    await page.goto("/brands", { waitUntil: "domcontentloaded" });
    valid = await requireSignedIn(page, account, "/brands").then(
      () => true,
      (e) => {
        if (e instanceof LoginWall) return false;
        throw e;
      },
    );
    await context.close();
  }
  if (!valid) await signInAndSave(account, 1440);
  sessionChecked.add(account);
}

const manifest = [];
const problems = [];
let done = 0;
const queue = selected.flatMap((s) =>
  WIDTHS.filter((w) => !s.widths || s.widths.includes(w)).map((width) => ({ s, width })),
);

async function capture({ s, width }) {
  const file = `${stem(s)}__${width}.png`;
  const context = await newContext(s.account, width);
  const page = await context.newPage();
  const failedRequests = [];
  page.on("pageerror", (e) => failedRequests.push(`pageerror: ${e.message.slice(0, 120)}`));
  try {
    await s.run(page);
    if (!s.keepMouse) await page.mouse.move(0, 0);
    const height = await fitToContent(page, width);
    await page.waitForTimeout(300);
    const target = path.join(outDir, file);
    await page.screenshot({ path: target, fullPage: true, animations: "disabled", caret: "hide" });
    manifest.push({
      file,
      route: s.route,
      state: s.state,
      account: s.account ?? "signed-out",
      width,
      url: page.url().replace(ORIGIN, ""),
      title: await page.title(),
      viewportHeight: height,
      bytes: statSync(target).size,
      notes: failedRequests,
    });
    rmSync(path.join(outDir, `FAILED__${file}`), { force: true });
    console.log(`  ok   ${file}`);
  } catch (error) {
    if (error instanceof LoginWall) throw error;
    problems.push({ file, error: error.message.split("\n")[0].slice(0, 200) });
    console.log(`  FAIL ${file}: ${error.message.split("\n")[0].slice(0, 160)}`);
    await page.screenshot({ path: path.join(outDir, `FAILED__${file}`), fullPage: false }).catch(() => {});
  } finally {
    await context.close().catch(() => {});
    done++;
  }
}

async function worker() {
  while (queue.length) {
    const job = queue.shift();
    await ensureSession(job.s.account);
    await capture(job);
  }
}

console.log(
  `Capturing ${selected.length} states x ${WIDTHS.length} widths into ${path.relative(process.cwd(), outDir)} (${WORKERS} workers)`,
);
const started = Date.now();
try {
  // Sign in sequentially first so parallel workers share saved sessions.
  for (const account of new Set(selected.map((s) => s.account).filter(Boolean))) await ensureSession(account);
  // Recipes change the stand-in AI and seeded data: run them one at a time, after everything else.
  const normal = queue.filter((j) => !j.s.recipe);
  const recipes = queue.filter((j) => j.s.recipe);
  queue.length = 0;
  queue.push(...normal);
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (recipes.length) {
    queue.push(...recipes);
    await worker();
    await aiMode({ text: "normal", images: "normal" });
    console.log("Recipes ran. Reseed before the next session: node design-audit/seed/seed.mjs");
  }
} catch (error) {
  await browser.close();
  console.error(`\nSTOPPED: ${error.message}`);
  process.exit(2);
}
await browser.close();
// Merge with the previous run so partial re-runs keep the full picture.
const merged = new Map(previous.screenshots.map((m) => [m.file, m]));
for (const m of manifest) merged.set(m.file, m);
const retried = new Set([...manifest.map((m) => m.file), ...problems.map((p) => p.file)]);
const allProblems = [...previous.problems.filter((p) => !retried.has(p.file)), ...problems];
const all = [...merged.values()].sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(
  manifestPath,
  JSON.stringify(
    { origin: ORIGIN, capturedAt: new Date().toISOString(), screenshots: all, problems: allProblems },
    null,
    2,
  ),
);
console.log(
  `\n${manifest.length} captured this run, ${all.length} in the manifest, ${allProblems.length} open problem(s), ${Math.round((Date.now() - started) / 1000)}s`,
);
for (const p of allProblems) console.log(`  - ${p.file}: ${p.error}`);
process.exit(allProblems.length ? 1 : 0);
