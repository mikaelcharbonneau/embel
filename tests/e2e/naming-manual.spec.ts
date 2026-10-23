import { expect, test } from "@playwright/test";
import { base, namingFixture, openNaming, ownerId, showNamingNames } from "./naming-brain-fixture";

test("manual name after 130 generated names stays saved and selected across reload with AI unavailable", async ({ page }, info) => {
  const runtimeErrors: string[] = []; page.on("pageerror", error => runtimeErrors.push(error.message));
  const fixture = await namingFixture(page, { saved: true, count: 130, terminal: "partial" });
  const retained = structuredClone(fixture.state.rows), preferences = structuredClone(fixture.state.preferences), request = structuredClone(fixture.state.activeRun);
  await page.route(url => url.pathname === `${base}/feed`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ feed: { ...fixture.feed(Number(new URL(route.request().url()).searchParams.get("cursorPosition") ?? 0)), availability: { status: "unavailable", code: "worker_unavailable" } } }) });
  });
  await openNaming(page); await showNamingNames(page);
  const field = page.getByRole("textbox", { name: "Your own name", exact: true });
  await field.fill("A name from me"); await page.getByRole("button", { name: "Add name", exact: true }).click();
  await expect(page.getByRole("button", { name: "Inspect name A name from me", exact: true })).toBeVisible();
  await expect(field).toHaveValue("");
  expect(fixture.state.manual).toHaveLength(1);
  await page.reload(); await showNamingNames(page);
  await page.getByRole("button", { name: "Inspect name A name from me", exact: true }).click();
  await page.getByRole("button", { name: "Save A name from me", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unsave A name from me", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use this name", exact: true }).click();
  await expect(page.getByRole("region", { name: "Name screening", exact: true })).toContainText("A name from me");
  await page.reload(); await showNamingNames(page);
  await expect(page.getByRole("heading", { name: "A name from me", exact: true })).toBeVisible();
  const screening = page.getByRole("region", { name: "Name screening", exact: true });
  if (!await screening.isVisible()) await page.getByRole("button", { name: "View selected name", exact: true }).click();
  await expect(screening).toContainText("A name from me");
  expect(fixture.state.currentSelection?.candidate.value).toBe("A name from me");
  expect(fixture.state.manual[0]!.retention.saved).toBe(true);
  expect(fixture.state.rows).toEqual(retained); expect(fixture.state.preferences).toEqual(preferences); expect(fixture.state.activeRun).toEqual(request);
  expect(fixture.mutations()).toHaveLength(0);
  for (const suffix of ["/imports", "/selection", "/retention"]) expect(fixture.mutations(suffix).every(row => row.account === ownerId)).toBe(true);
  expect(runtimeErrors).toEqual([]);
  await page.screenshot({ path: info.outputPath("custom-name-selected-after-reload.png") });
});
