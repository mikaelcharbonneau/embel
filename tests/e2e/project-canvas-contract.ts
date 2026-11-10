import { expect, test, type Page } from "@playwright/test";

/** These three project bars were removed, rather than hidden at a breakpoint. */
export async function expectProjectCanvas(page: Page) {
  await expect(
    page.locator(".project-workspace-header, .project-stage-navigation, .logo-journey-navigation"),
  ).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Project stages", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Logo and identity pages", exact: true })).toHaveCount(0);
  const owned = await page.locator(".project-workspace").count();
  const shell = page.locator(owned ? ".project-workspace" : ".project-strategy-workspace"),
    content = owned ? page.locator(".project-workspace-content") : shell;
  await expect(shell).toBeVisible();
  await expect(content).toBeVisible();
  const bounds = (await shell.boundingBox())!,
    canvas = (await content.boundingBox())!,
    topbar = (await page.getByRole("banner").boundingBox())!;
  expect(bounds.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);
  expect(Math.abs(bounds.y - topbar.y - topbar.height)).toBeLessThanOrEqual(1);
  // Existing actionable notices may precede the canvas; deleted bars reserve no space.
  const noticeBottom = await shell.evaluate((element) =>
    Math.max(
      element.getBoundingClientRect().top,
      ...Array.from(element.children)
        .filter((child) => child.classList.contains("project-read-notice"))
        .map((child) => child.getBoundingClientRect().bottom),
    ),
  );
  expect(Math.abs(canvas.y - noticeBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(canvas.y + canvas.height - bounds.y - bounds.height)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await test.info().attach("project-canvas-geometry", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify(
        {
          route: new URL(page.url()).pathname,
          viewport: page.viewportSize(),
          topbar,
          shell: bounds,
          content: canvas,
          noticeBottom,
          documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
          removedBarCount: 0,
        },
        null,
        2,
      ),
    ),
  });
  return { shell: bounds, content: canvas };
}
