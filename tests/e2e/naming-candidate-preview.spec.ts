import { expect, test, type Page } from "@playwright/test";
import { standaloneLookupResponseSchema, type StandaloneLookupInput, type StandaloneLookupResult } from "../../src/domain/standalone-live-checks";
import { frameBarrier, namingCard, namingFixture, namingUrl, openNaming, ownerId } from "./naming-brain-fixture";

async function lookupFixture(page: Page) {
  const lookups: StandaloneLookupInput[] = [];
  await page.route("**/api/standalone-checks", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { ownerId, domains: "rdap", youtube: true, euipo: true } });
    expect(route.request().method()).toBe("POST");
    const input = route.request().postDataJSON() as StandaloneLookupInput;
    lookups.push(input);
    const checkedAt = new Date(Date.now() - 60_000).toISOString();
    let result: StandaloneLookupResult;
    if (input.tool === "domains") result = { status: "domain", check: {
      id: "domain-fixture", provider: "Public registry RDAP", domain: input.domain, availability: "taken",
      checkedAt, validUntil: new Date(Date.now() + 86_400_000).toISOString(), evidenceReference: "rdap:fixture",
      sourceUrl: "https://example.test/rdap", detail: "Synthetic registration record.",
    }, quote: null };
    else if (input.tool === "handles") result = input.handle === "previewcheck"
      ? { status: "failed", code: "unavailable", retryAfterSeconds: null }
      : { status: "handle", evidence: { platform: "youtube", handle: input.handle, outcome: "taken", authority: "platform_api",
        source: "YouTube API", sourceUrl: "https://example.test/channel", method: "Exact synthetic channel match",
        checkedAt, observedAt: checkedAt, detail: "An exact fixture channel was returned." } };
    else result = { status: "trademark", research: { query: input, searched: ["EM"], missing: [],
      hits: [{ registryId: "000123456", mark: "Synthetic registry result", niceClasses: [35], status: "Registered" }],
      checkedAt, datasetAsOf: null, completeness: "partial", interrupted: null, sourceUrl: "https://example.test/registry",
      legalClearance: "not_assessed", filing: "not_submitted",
    } };
    return route.fulfill({ json: standaloneLookupResponseSchema.parse({ ownerId, result }) });
  });
  return lookups;
}

test("candidate modal checks one name without replacing, scrolling or selecting the results", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const fixture = await namingFixture(page, { saved: true, count: 100 });
  const lookups = await lookupFixture(page);
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  const composer = page.getByRole("textbox", { name: "Naming message", exact: true });
  await composer.fill("Keep my shortlist draft.");
  const panel = page.locator("[data-floating-composer]");
  await panel.getByRole("button", { name: "Move composer" }).press("ArrowUp");
  const originalPanel = await panel.boundingBox();
  const grid = page.locator("[data-naming-results-scroll]");
  const name = "Synthetic 050";
  const trigger = namingCard(page, 50).getByRole("button", { name: `Inspect name ${name}`, exact: true });
  await trigger.evaluate(el => el.scrollIntoView({ block: "center" })); await frameBarrier(page);
  const before = await grid.evaluate(el => { el.setAttribute("data-tested-grid", "original"); return el.scrollTop; });
  expect(before).toBeGreaterThan(0);
  const dialog = page.getByRole("dialog", { name, exact: true });
  const open = async () => {
    await trigger.press("Enter"); await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(d => d.matches(":modal") && d.contains(document.activeElement))).toBe(true);
    await expect(grid).toHaveAttribute("data-tested-grid", "original");
    await expect(grid.locator(".naming-feed-card")).toHaveCount(100);
    await expect(page).toHaveURL(namingUrl);
  };
  const closed = async () => {
    await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    await expect.poll(() => grid.evaluate(el => el.scrollTop)).toBe(before);
    await expect(composer).toHaveValue("Keep my shortlist draft.");
    const current = await panel.boundingBox();
    expect(current!.x).toBeCloseTo(originalPanel!.x, 0); expect(current!.y).toBeCloseTo(originalPanel!.y, 0);
  };
  await open();
  expect(lookups).toHaveLength(0);
  await dialog.getByRole("tab", { name: "Domains", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Domain", exact: true }).fill("preview-check.com");
  await dialog.getByRole("button", { name: "Check domain", exact: true }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText(/taken|registered/i);
  await dialog.getByRole("tab", { name: "Handles", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Handle", exact: true }).fill("previewcheck");
  await dialog.getByRole("button", { name: "Check handle", exact: true }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText(/not connected|unavailable|could not|couldn’t/i);
  await dialog.getByRole("textbox", { name: "Handle", exact: true }).fill("anotherpreview");
  await dialog.getByRole("button", { name: "Check handle", exact: true }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText("An exact fixture channel was returned.");
  await dialog.getByRole("tab", { name: "Trademarks", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Word mark", exact: true }).fill("Preview Check");
  await dialog.getByRole("button", { name: "Search trademarks", exact: true }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText("Synthetic registry result");
  expect(lookups).toEqual([
    { tool: "domains", domain: "preview-check.com" },
    { tool: "handles", platform: "youtube", handle: "previewcheck" },
    { tool: "handles", platform: "youtube", handle: "anotherpreview" },
    { tool: "trademarks", mark: "Preview Check", jurisdictions: ["EM"], niceClasses: [], mode: "exact_word" },
  ]);
  await expect(page).toHaveURL(namingUrl);
  await page.keyboard.press("Escape"); await closed();
  await open();
  const b = (await dialog.boundingBox())!;
  expect(b.x).toBeGreaterThan(1);
  await page.mouse.click(b.x / 2, b.y + b.height / 2); await closed();
  await open();
  await dialog.getByRole("button", { name: "Close name preview", exact: true }).click(); await closed();
  expect(lookups).toHaveLength(4);
  expect(fixture.state.currentSelection).toBeNull();
  expect(fixture.mutations("/selection")).toHaveLength(0); expect(fixture.mutations()).toHaveLength(0);
});

test("disconnected providers show unavailable checks inside the unselected candidate preview", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 });
  await openNaming(page);
  const name = "Synthetic 001";
  await namingCard(page, 1).getByRole("button", { name: `Inspect name ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name, exact: true });
  for (const [tab, action] of [["Domains", "Check domain"], ["Handles", "Check handle"], ["Trademarks", "Search trademarks"]]) {
    await dialog.getByRole("tab", { name: tab, exact: true }).click();
    const pane = dialog.getByRole("tabpanel");
    await expect(pane).toContainText(/not connected/i);
    await expect(pane.getByRole("button", { name: action, exact: true })).toBeDisabled();
    await expect(pane.getByRole("link")).toHaveAttribute("href", /^https:\/\//);
  }
  expect(fixture.mutations("/standalone-checks")).toHaveLength(0);
  expect(fixture.state.currentSelection).toBeNull(); await expect(page).toHaveURL(namingUrl);
});
