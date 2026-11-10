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
            accountNotice: rect(".account-notice"),
            signInCard: rect(".auth-card"),
          };
        }),
        null,
        2,
      ),
    );
  }
});

test("Home recovery controls are usable touch targets and remain grouped", async ({ page }) => {
  // Saving a Home prompt is account-only since 96ef9f1; this fixture verifies a synthetic session only.
  await page.route("**/api/**", (route) =>
    new URL(route.request().url()).pathname === "/api/session"
      ? route.fulfill({ json: { user: { id: "aaaaaaaa-1111-4111-8111-111111111111" } } })
      : route.fulfill({ status: 404, json: { error: "Synthetic missing fixture" } }),
  );
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Your prompt", exact: true })
    .fill("A repair workshop sharing tools with local residents.");
  const save = page.getByRole("button", { name: "Save project", exact: true });
  await expect(save).toBeEnabled();
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(
    await page
      .locator(".home-draft-actions .field-hint")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(13);
});

test("logo has one main landmark", async ({ page }) => {
  await page.goto("/brands/logo/new");
  await expect(page.getByRole("main")).toHaveCount(1);
});

test("sign-in recovery restores the prompt and scope from one retained browser copy", async ({ page }, info) => {
  await page.goto("/");
  const prompt = "A repair workshop sharing tools and practical skills with local residents.";
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(prompt);
  await page
    .getByRole("group", { name: "What to create", exact: true })
    .getByText("Name only", { exact: true })
    .click();
  await page.getByLabel("Account menu", { exact: true }).click();
  await page.locator(".workspace-account-panel").getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("link", { name: "Return to your prompt", exact: true })).toHaveAttribute("href", "/");
  // A full load, as after an authentication redirect, must use the retained sign-in copy.
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue(prompt);
  await expect(page.getByRole("radio", { name: "Name only", exact: true })).toBeChecked();
  await expect(page.getByText(/Your prompt is ready to continue/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("home-restored-prompt.png"), fullPage: true, scale: "css" });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fluid.local-drafts.v1")!).drafts.length)).toBe(1);
});

test("320px layout keeps Home input disclosures and navigation reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  const tools = page.getByRole("navigation", { name: "Main navigation", exact: true }).locator("summary");
  await tools.click();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("link", { name: "Trademarks", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tools).toBeFocused();
  await page.locator(".home-files-popover summary").click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeVisible();
});
