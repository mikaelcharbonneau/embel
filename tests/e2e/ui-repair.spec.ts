import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Every API is intercepted; these layout checks never reach an account or provider.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } }),
  );
});

test("all public workspaces fit the viewport and retain visible page headings", async ({ page }, info) => {
  for (const [name, path] of Object.entries({
    home: "/",
    brands: "/brands",
    assets: "/assets",
    settings: "/settings",
    signIn: "/sign-in",
    logo: "/brands/logo/new",
  })) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(page.viewportSize()!.width);
    const directory = process.env.FLUID_UI_EVIDENCE ?? info.outputDir;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${info.project.name}-${name}.png`), fullPage: true, scale: "css" });
    await writeFile(
      join(directory, `${info.project.name}-${name}.json`),
      JSON.stringify(
        await page.evaluate(() => {
          const rect = (selector: string) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const box = el.getBoundingClientRect();
            return {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              fontSize: getComputedStyle(el).fontSize,
            };
          };
          return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            mainCount: document.querySelectorAll("main").length,
            prompt: rect(".conversation-composer textarea"),
            saveDraft: rect(".home-draft-actions button"),
            status: rect(".conversation-start-notice .field-hint"),
            trademarkInput: rect(".tm-editor input"),
            accountNotice: rect(":is(.e-message, .e-empty)"),
            signInCard: rect(".auth-card"),
          };
        }),
        null,
        2,
      ),
    );
  }
});

test("Home recovery control is a usable touch target", async ({ page }) => {
  // Home shows one recovery control, Check and retry save, and only after a save went unconfirmed.
  // Synthetic session; the create request is dropped so the save stays unconfirmed.
  await page.route("**/api/**", (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/session")
      return route.fulfill({ json: { user: { id: "aaaaaaaa-1111-4111-8111-111111111111" } } });
    if (path === "/api/projects" && request.method() === "POST") return route.abort("failed");
    return route.fulfill({ status: 404, json: { error: "Synthetic missing fixture" } });
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Your prompt", exact: true })
    .fill("A repair workshop sharing tools with local residents.");
  await expect(page.getByRole("button", { name: "Save project", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  const retry = page.getByRole("button", { name: "Check and retry save", exact: true });
  await expect(retry).toBeEnabled();
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("logo has one main landmark", async ({ page }) => {
  await page.goto("/brands/logo/new");
  await expect(page.getByRole("main")).toHaveCount(1);
});

test("sign-in recovery restores the prompt from one retained browser copy", async ({ page }, info) => {
  await page.goto("/");
  const prompt = "A repair workshop sharing tools and practical skills with local residents.";
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(prompt);
  // Home no longer asks what to create: every project is a complete brand (src/domain/projects.ts).
  // Signed out, the navigation pill offers Sign in directly.
  await page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Your idea is kept. It will be waiting when you’re signed in.")).toBeVisible();
  // A full load, as after an authentication redirect, must use the retained sign-in copy.
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue(prompt);
  await expect(page.getByText(/Your prompt is ready to continue/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("home-restored-prompt.png"), fullPage: true, scale: "css" });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fluid.local-drafts.v1")!).drafts.length)).toBe(1);
});

test("320px layout keeps Home input disclosures and navigation reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  // The Tools menu (Trademarks and the other standalone tools) was removed with the standalone tools.
  await page.locator(".home-files-popover summary").click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeVisible();
});
