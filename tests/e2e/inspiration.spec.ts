import { checkDialogHitTesting } from "./dialog-hit-testing";
import { expect, test, type Page } from "@playwright/test";
import { inspirationBrands, INSPIRATION_CATALOG_VERSION, type InspirationOverview } from "../../src/domain/inspiration";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
// Fixture API state only; actual page/components, brand images, and client requests.
// Database persistence and authorization are exercised separately in project-inspiration.test.ts.
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base = `/api/projects/${projectId}/inspiration`,
  url = `/brands/account/${projectId}/inspiration`,
  brand = inspirationBrands[0]!;
// Inspiration is the first Identity step of the brand conversation: it shows once Voice is finished, that is with
// a chosen name and the slogan question answered (here: skipped).
const when = "2026-10-13T00:00:00Z";
const finishedVoice = contextSnapshotSchema.parse({
  description: "Explicit local inspiration fixture",
  selectedName: "Fixture",
  intake: {
    guidedInterview: {
      version: 1,
      stage: "complete",
      turns: [{ id: "slogan-turn", userMessageId: null, stage: "slogan", purpose: "propose", inputRevision: 1 }],
      answers: [{ stage: "slogan", turnId: "slogan-turn", optionIds: [], customText: null, confirmedAt: when }],
    },
  },
});
async function setup(page: Page) {
  const fixture = {
    writes: 0,
    lost: false,
    fail: false,
    overview: {
      ownerId,
      projectId,
      projectTitle: "Inspiration prototype",
      projectScope: "complete_brand",
      projectRevision: 1,
      catalogVersion: INSPIRATION_CATALOG_VERSION,
      selectionRevision: 0,
      choices: [],
      availableReferenceIds: inspirationBrands.map((item) => item.id),
    } as InspirationOverview,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/session") return json({ user: { id: ownerId } });
    if (path === "/api/account/profile")
      return json({
        profile: {
          ownerId,
          email: "fixture@example.invalid",
          revision: 0,
          updatedAt: null,
          values: DEFAULT_PROFILE_VALUES,
        },
      });
    if (path === `/api/projects/${projectId}`)
      return json({
        project: {
          id: projectId,
          owner_id: ownerId,
          title: fixture.overview.projectTitle,
          scope: "complete_brand",
          current_revision: 1,
          created_at: "2026-10-13T00:00:00Z",
          context: finishedVoice,
        },
      });
    if (path === `/api/projects/${projectId}/strategy`)
      return json({
        availability: {
          status: "available",
          operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 100000, interviewVersion: 1 }],
        },
        jobs: [],
      });
    if (path === `/api/projects/${projectId}/generations` && request.method() === "GET") return json({ runs: [] });
    if (path === base) return json(fixture.overview);
    if (path.startsWith(`${base}/`) && request.method() === "PATCH") {
      fixture.writes++;
      const referenceId = path.split("/").at(-1)!,
        body = request.postDataJSON(),
        previous = fixture.overview.choices.find((choice) => choice.referenceId === referenceId);
      if (fixture.fail) return json({}, 503);
      if (body.expectedRevision !== (previous?.revision ?? 0)) return json({}, 409);
      fixture.overview.selectionRevision++;
      fixture.overview.choices = [
        ...fixture.overview.choices.filter((choice) => choice.referenceId !== referenceId),
        {
          referenceId,
          ownerId,
          projectId,
          revision: (previous?.revision ?? 0) + 1,
          ensemble: body.ensemble,
          elements: body.elements,
          updatedAt: "2026-10-13T00:00:00Z",
        },
      ];
      if (fixture.lost) {
        fixture.lost = false;
        return json({}, 503);
      }
      return json(fixture.overview);
    }
    return json({}, 503);
  });
  // The old standalone address hands over to the Identity part of the brand conversation.
  await page.goto(url);
  await expect(page).toHaveURL(`/brands/account/${projectId}?view=strategy#journey-identity`);
  await expect(page.getByRole("button", { name: /^Liked · 0$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: `Like the whole ${brand.brand} brand`, exact: true })).toBeEnabled();
  return fixture;
}
const card = (page: Page) => page.getByRole("article", { name: brand.brand, exact: true });
const open = (page: Page, part = "logo") =>
  card(page).getByRole("button", { name: `Open ${brand.brand}: ${part}`, exact: true });
const overlay = (page: Page) => page.locator("dialog.inspiration-brand-overlay");
test("brand containers, categories, search and the brand overlay", async ({ page }, info) => {
  const fixture = await setup(page);
  await expect(page.locator(".inspiration-categories button")).toHaveText([
    "Brands",
    "Logos",
    "Colors",
    "Typefaces",
    "Socials",
    "Visuals",
  ]);
  // The first brands show at once; more load on their own as the end of the gallery comes near.
  expect(await page.locator(".inspiration-brand").count()).toBeGreaterThanOrEqual(
    Math.min(8, inspirationBrands.length),
  );
  await expect(card(page).locator(".inspiration-brand-tile")).toHaveCount(5);
  await expect
    .poll(() =>
      card(page)
        .locator(".inspiration-brand-tile img")
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  // The gallery has no Continue of its own in the conversation: Send in the reply box moves on to Logo.
  await expect(page.getByRole("link", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("form", { name: "Reply", exact: true })
      .getByRole("button", { name: "Continue to Logo", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: info.outputPath("brands.png") });
  await page.getByRole("button", { name: "Colors", exact: true }).click();
  await expect(page.locator(".inspiration-brand")).toHaveCount(0);
  const cards = page.locator(".inspiration-card");
  await expect(cards.first()).toBeVisible();
  const first = await cards.count();
  expect(first).toBeGreaterThanOrEqual(Math.min(24, inspirationBrands.length));
  await page.screenshot({ path: info.outputPath("colors.png") });
  // No Show more button: scrolling to the last card loads the next ones.
  await expect(page.getByRole("button", { name: /^Show more/ })).toHaveCount(0);
  if (inspirationBrands.length > first) {
    await cards.last().scrollIntoViewIfNeeded();
    await expect.poll(() => cards.count()).toBeGreaterThan(first);
  }
  await page.getByRole("searchbox").fill("nothing matches this");
  await expect(page.getByRole("heading", { name: "No colors match this search" })).toBeVisible();
  await page.getByRole("button", { name: "Browse all colors" }).click();
  await page.getByRole("button", { name: "Brands", exact: true }).click();
  await open(page, "typefaces").click();
  const dialog = overlay(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: brand.brand, exact: true })).toBeVisible();
  await expect(dialog.locator("figcaption")).toHaveText("Typefaces");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator("figcaption")).toHaveText("Socials");
  await page.screenshot({ path: info.outputPath("overlay.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toBe(0);
  await expect(open(page, "typefaces")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("whole-brand and part likes are independent, reloadable and visible in Liked", async ({ page }, info) => {
  const fixture = await setup(page);
  const whole = card(page).getByRole("button", { name: `Like the whole ${brand.brand} brand`, exact: true });
  await whole.click();
  await expect(
    card(page).getByRole("button", { name: `Like the whole ${brand.brand} brand`, exact: true, pressed: true }),
  ).toBeEnabled();
  await open(page).click();
  const dialog = overlay(page),
    colors = dialog.getByRole("button", { name: `Like ${brand.brand} colors`, exact: true });
  await colors.click();
  await expect(
    dialog.getByRole("button", { name: `Like ${brand.brand} colors`, exact: true, pressed: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: `Like the whole ${brand.brand} brand`, exact: true, pressed: true }).click();
  await expect(dialog.getByRole("button", { name: `Like the whole ${brand.brand} brand`, exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("button", { name: "Liked · 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Liked · 1", exact: true }).click();
  await expect(page.locator(".inspiration-brand")).toHaveCount(1);
  await expect(
    card(page).getByRole("button", { name: `Like ${brand.brand} colors`, exact: true, pressed: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("liked.png") });
  expect(fixture.writes).toBe(3);
  expect(fixture.overview.choices[0]).toMatchObject({ ensemble: false, elements: ["colors"] });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(brand.id);
});
test("a lost successful response is recovered by reading, without repeating the write", async ({ page }) => {
  const fixture = await setup(page);
  fixture.lost = true;
  await card(page)
    .getByRole("button", { name: `Like the whole ${brand.brand} brand`, exact: true })
    .click();
  await card(page).getByRole("button", { name: "Review unsaved choices" }).click();
  const dialog = overlay(page);
  await expect(dialog.getByRole("button", { name: "Save my changes" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Check saved choices" }).click();
  await expect(
    dialog.getByRole("button", { name: `Like the whole ${brand.brand} brand`, pressed: true }),
  ).toBeEnabled();
  expect(fixture.writes).toBe(1);
});
test("a failed write retains intent and requires check then explicit retry", async ({ page }) => {
  const fixture = await setup(page);
  fixture.fail = true;
  await card(page)
    .getByRole("button", { name: `Like the whole ${brand.brand} brand`, exact: true })
    .click();
  await card(page).getByRole("button", { name: "Review unsaved choices" }).click();
  const dialog = overlay(page);
  await expect(dialog.getByRole("button", { name: "Save my changes" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Check saved choices" }).click();
  await expect(dialog.getByRole("button", { name: "Save my changes" })).toBeEnabled();
  fixture.fail = false;
  await dialog.getByRole("button", { name: "Save my changes" }).click();
  await expect(
    dialog.getByRole("button", { name: `Like the whole ${brand.brand} brand`, pressed: true }),
  ).toBeEnabled();
  expect(fixture.writes).toBe(2);
  expect(fixture.overview.choices[0]?.ensemble).toBe(true);
});

test("dialog hit testing: the brand overlay protects padding without saving choices", async ({ page }) => {
  const fixture = await setup(page);
  await checkDialogHitTesting(page, open(page), overlay(page), "Close brand");
  expect(fixture.writes).toBe(0);
});
