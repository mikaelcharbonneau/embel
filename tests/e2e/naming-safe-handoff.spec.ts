import { expect, test } from "@playwright/test";
import { base, frameBarrier, namingFixture, namingUrl, openNaming, projectId } from "./naming-brain-fixture";

// Explicit synthetic account APIs only; no provider or database is contacted.
test("final Continue waits for an in-flight read, admits once, and reload never restarts it", async ({ page }) => {
  await page.clock.install();
  const fixture = await namingFixture(page, { saved: true }); await openNaming(page);
  await expect(page.locator("#project-naming-preferences-heading")).toHaveText("Any length limits or text to include or avoid?");
  const held = fixture.hold(`${base}/feed`, "GET");
  await page.clock.runFor(15_000); await expect.poll(() => held.ready).toBe(true);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#project-naming-preferences-heading")).toHaveText("Your naming direction");
  expect(fixture.mutations()).toHaveLength(0);
  held.release();
  await expect.poll(() => fixture.mutations().length).toBe(1);
  await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "initial" });
  await page.reload(); await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  expect(fixture.mutations()).toHaveLength(1);
});

test("manual selection survives screening reload, tab verification, Projects navigation and reopen", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true }); await openNaming(page);
  await page.getByRole("textbox", { name: "Your own name", exact: true }).fill("Cedarloom QA");
  await page.getByRole("button", { name: "Add name", exact: true }).click();
  await page.getByRole("button", { name: "Inspect name Cedarloom QA", exact: true }).click();
  await page.getByRole("button", { name: "Use this name", exact: true }).click();
  await expect(page.locator("#project-naming-screening-heading")).toHaveText("Cedarloom QA");
  await page.reload(); await expect(page.locator("#project-naming-screening-heading")).toHaveText("Cedarloom QA");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#project-naming-screening-heading")).toHaveText("Cedarloom QA");
  await frameBarrier(page);
  // Inside a project the bar's project menu leads back to all projects.
  await page.locator('header summary[aria-label^="Project:"]').click();
  await page.getByRole("link", { name: "All projects", exact: true }).click();
  await expect(page).toHaveURL(/\/brands$/);
  await expect(page.getByRole("heading", { name: "Projects.", exact: true })).toBeVisible();
  await page.goto(namingUrl); await expect(page.locator("#project-naming-screening-heading")).toHaveText("Cedarloom QA");
  // The project menu and its All projects link are keyboard operable.
  await page.locator('header summary[aria-label^="Project:"]').focus(); await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "All projects", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/brands$/);
  await expect(page.locator("#project-naming-screening-heading")).toHaveCount(0);
  await page.goto(namingUrl); await expect(page.locator("#project-naming-screening-heading")).toHaveText("Cedarloom QA");
  const geometry = await page.evaluate(() => {
    const shell = document.querySelector("#main-content")!.getBoundingClientRect();
    const canvas = document.querySelector("[data-naming-results-scroll]")!.getBoundingClientRect();
    return { scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth, shellBottom: shell.bottom, canvasBottom: canvas.bottom };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  expect(geometry.canvasBottom).toBeLessThanOrEqual(geometry.shellBottom + 1);
  expect(fixture.state.manual).toHaveLength(1); expect(fixture.state.currentSelection?.candidate.value).toBe("Cedarloom QA");
  expect(fixture.mutations()).toHaveLength(0);
  expect(fixture.state.requests.filter(row => row.path === `/api/projects/${projectId}/naming/selection` && row.method === "POST")).toHaveLength(1);
});
