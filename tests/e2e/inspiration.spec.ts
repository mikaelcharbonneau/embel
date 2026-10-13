import { expect, test, type Page } from "@playwright/test";
import { inspirationCatalog, INSPIRATION_CATALOG_VERSION, type InspirationOverview } from "../../src/domain/inspiration";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
// Fixture API state only; actual page/components, original catalog images, and client requests.
// Database persistence and authorization are exercised separately in project-inspiration.test.ts.
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base = `/api/projects/${projectId}/inspiration`, url = `/brands/account/${projectId}/inspiration`, design = inspirationCatalog[0]!;
async function setup(page: Page) {
  const fixture = { writes: 0, lost: false, fail: false, overview: { ownerId, projectId, projectTitle: "Inspiration prototype", projectScope: "complete_brand", projectRevision: 1, catalogVersion: INSPIRATION_CATALOG_VERSION, selectionRevision: 0, choices: [] } as InspirationOverview };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/session") return json({ user: { id: ownerId } });
    if (path === "/api/account/profile") return json({ profile: { ownerId, email: "fixture@example.invalid", revision: 0, updatedAt: null, values: DEFAULT_PROFILE_VALUES } });
    if (path === `/api/projects/${projectId}`) return json({ project: { id: projectId, owner_id: ownerId, title: fixture.overview.projectTitle, scope: "complete_brand", current_revision: 1, created_at: "2026-10-13T00:00:00Z", context: contextSnapshotSchema.parse({ description: "Explicit local inspiration fixture" }) } });
    if (path === base) return json(fixture.overview);
    if (path.startsWith(`${base}/`) && request.method() === "PATCH") {
      fixture.writes++; const referenceId = path.split("/").at(-1)!, body = request.postDataJSON(), previous = fixture.overview.choices.find(choice => choice.referenceId === referenceId);
      if (fixture.fail) return json({}, 503);
      if (body.expectedRevision !== (previous?.revision ?? 0)) return json({}, 409);
      fixture.overview.selectionRevision++;
      fixture.overview.choices = [...fixture.overview.choices.filter(choice => choice.referenceId !== referenceId), { referenceId, ownerId, projectId, revision: (previous?.revision ?? 0) + 1, ensemble: body.ensemble, elements: body.elements, updatedAt: "2026-10-13T00:00:00Z" }];
      if (fixture.lost) { fixture.lost = false; return json({}, 503); }
      return json(fixture.overview);
    }
    return json({}, 503);
  });
  await page.goto(url); await expect(page.getByRole("button", { name: /^Liked · 0$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: `Like Dropbox overall look: ${design.slug}`, exact: true })).toBeEnabled();
  return fixture;
}
const card = (page: Page) => page.getByRole("article", { name: `Dropbox — ${design.slug}`, exact: true });
const inspect = (page: Page) => card(page).getByRole("button", { name: /^Inspect / });
test("catalog search, filters, original images and read-only inspection", async ({ page }, info) => {
  const fixture = await setup(page); await expect(page.locator(".inspiration-card")).toHaveCount(15);
  await expect.poll(() => card(page).locator(".inspiration-image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(720);
  await page.screenshot({ path: info.outputPath("gallery.png") });
  await page.getByRole("searchbox").fill("collins blue"); await expect(page.locator(".inspiration-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Identities", exact: true }).click(); await expect(page.getByRole("heading", { name: "No designs match these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Browse all designs" }).click(); await inspect(page).click();
  const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible(); await expect(dialog.getByRole("link", { name: "View original project" })).toHaveAttribute("href", design.sourceUrl);
  await page.screenshot({ path: info.outputPath("detail.png") });
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); expect(fixture.writes).toBe(0);
  await expect(inspect(page)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("whole and component likes are independent, reloadable and visible in Liked and Your style", async ({ page }, info) => {
  const fixture = await setup(page); await inspect(page).click(); const dialog = page.getByRole("dialog"), colors = dialog.getByRole("button", { name: "Colors", exact: true }), overall = dialog.getByRole("button", { name: "Overall look" });
  await colors.click(); await expect(colors).toBeEnabled(); await expect(colors).toHaveAttribute("aria-pressed", "true"); await expect(overall).toHaveAttribute("aria-pressed", "false");
  await overall.click(); await expect(overall).toBeEnabled(); await overall.click(); await expect(overall).toBeEnabled(); await expect(colors).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape"); await page.reload(); await expect(page.getByRole("button", { name: "Liked · 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Liked · 1", exact: true }).click(); await expect(page.locator(".inspiration-card")).toHaveCount(1);
  await expect(card(page).getByText("Colors liked", { exact: true })).toBeVisible(); await page.screenshot({ path: info.outputPath("liked.png") });
  await page.getByRole("button", { name: "Your style", exact: true }).click(); await expect(page.getByRole("complementary", { name: "Your style" }).getByText("Colors", { exact: true })).toBeVisible();
  expect(fixture.writes).toBe(3); expect(fixture.overview.choices[0]).toMatchObject({ ensemble: false, elements: ["colors"] });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(design.id);
});
test("a lost successful response is recovered by reading, without repeating the write", async ({ page }) => {
  const fixture = await setup(page); fixture.lost = true; await card(page).getByRole("button", { name: /^Like Dropbox overall/ }).click();
  await card(page).getByRole("button", { name: "Review unsaved choices" }).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save my changes" })).toBeDisabled(); await dialog.getByRole("button", { name: "Check saved choices" }).click();
  await expect(dialog.getByRole("button", { name: "Overall look" })).toBeEnabled(); await expect(dialog.getByRole("button", { name: "Overall look" })).toHaveAttribute("aria-pressed", "true"); expect(fixture.writes).toBe(1);
});
test("a failed write retains intent and requires check then explicit retry", async ({ page }) => {
  const fixture = await setup(page); fixture.fail = true; await card(page).getByRole("button", { name: /^Like Dropbox overall/ }).click();
  await card(page).getByRole("button", { name: "Review unsaved choices" }).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Save my changes" })).toBeDisabled(); await dialog.getByRole("button", { name: "Check saved choices" }).click();
  await expect(dialog.getByRole("button", { name: "Save my changes" })).toBeEnabled(); fixture.fail = false; await dialog.getByRole("button", { name: "Save my changes" }).click();
  await expect(dialog.getByRole("button", { name: "Overall look" })).toBeEnabled(); expect(fixture.writes).toBe(2); expect(fixture.overview.choices[0]?.ensemble).toBe(true);
});
