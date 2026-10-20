import { expect, test } from "@playwright/test";
import { createEmptyNamesWorkspace, namesWorkspaceSchema } from "../../src/domain/names-workspace";
import { emptyGuidedUi } from "../../src/domain/names-guided";
import { accountNamesPageSchema, nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import { accountProjectSchema, accountProjectSummarySchema } from "../../src/domain/project-api";
import { createNamesAccountFixture, namesOwner, waitForNamesSaved } from "./fixtures/names-account";
import { captureUiEvidence } from "./ui-evidence";

const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const when = "2026-10-20T00:00:00Z";
const longSeed = "interface, application, independent visual reference, graphic identity, a longer retained name to keep unchanged";

test("Names hierarchy: long retained seed and live preview stay accessible beside controls", async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const fixture = createNamesAccountFixture(), payload = createEmptyNamesWorkspace();
  payload.ui.guided = { ...emptyGuidedUi(), words: [{ value: longSeed, candidateId: null }] };
  fixture.state.workspace = { id: id(1), ownerId: namesOwner, revision: 1, payload: namesWorkspaceSchema.parse(payload), createdAt: when, updatedAt: when };
  await fixture.install(page); await page.goto("/names");
  await expect(page.locator(".names-word-chip")).toHaveCount(1);
  await expect(page.locator(".names-word-count")).toHaveText("1 word");
  const words = await page.locator(".names-words-panel").boundingBox(); expect(words!.height).toBeLessThanOrEqual(page.viewportSize()!.height * .4);
  const seed = page.locator(".names-long-word"), summary = seed.locator("summary");
  const collapsedLines = await summary.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight));
  expect(collapsedLines).toBeLessThanOrEqual(2);
  if (info.project.name === "mobile") {
    expect((await page.getByRole("button", { name: `Remove word ${longSeed}`, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Preview · 1", exact: true })).toBeInViewport();
  }
  await summary.focus(); await summary.press("Enter"); await expect(seed).toHaveAttribute("open", "");
  await summary.press("Enter"); await expect(seed).not.toHaveAttribute("open", "");
  const prefix = page.getByRole("button", { name: "prefix Neo", exact: true });
  await prefix.click(); await expect(prefix).toBeFocused(); await waitForNamesSaved(page); await expect(prefix).toBeFocused();
  const result = `Neo${longSeed}`;
  if (info.project.name === "mobile") {
    const preview = page.getByRole("button", { name: "Preview · 1", exact: true });
    await expect(preview).toBeInViewport();
    await expect(page.locator(".names-guided-preview-value")).toHaveText(result);
    await preview.focus(); await preview.press("Enter"); await expect(preview).toBeFocused();
    await expect(page.locator(".names-guided-controls")).toBeHidden();
    await expect(page.getByRole("region", { name: "Live naming results" })).toBeVisible();
    await page.getByRole("button", { name: "Controls", exact: true }).click();
    await expect(prefix).toHaveAttribute("aria-pressed", "true");
  } else {
    const controls = await page.locator(".names-guided-controls").boundingBox(), results = await page.locator(".names-guided-results").boundingBox();
    expect(results!.x).toBeGreaterThan(controls!.x + controls!.width);
    await expect(page.getByRole("button", { name: `Favorite result ${result}`, exact: true })).toBeVisible();
  }
  expect(fixture.payload().ui.guided!.words).toEqual([{ value: longSeed, candidateId: null }]);
  expect(fixture.payload().candidates).toEqual([]); expect(fixture.state.projects).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.querySelector("#main-content")?.scrollTo(0, 0); window.scrollTo(0, 0); });
  await captureUiEvidence(page, info);
});

test("Names hierarchy: one visible scoped search preserves independent queries and source history", async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const fixture = createNamesAccountFixture(), payload = createEmptyNamesWorkspace();
  payload.ui.tab = "library";
  payload.candidates.push({ source: { id: id(2), value: "Manual Cedar", origin: "manual", history: [], createdAt: when }, context: payload.ui.context, runId: null, explanation: "Added manually", favorite: false, saved: true });
  fixture.state.workspace = { id: id(1), ownerId: namesOwner, revision: 1, payload: namesWorkspaceSchema.parse(payload), createdAt: when, updatedAt: when };
  await fixture.install(page);
  const project = accountProjectSchema.parse({ id: id(3), owner_id: namesOwner, title: "Untitled brand", scope: "naming_only", current_revision: 1, created_at: when, context: { description: "Synthetic source-history fixture" } });
  const value = "Project Cedar", candidateId = id(4);
  const source = { id: candidateId, value, origin: "manual", history: [], createdAt: when };
  const projectPage = accountNamesPageSchema.parse({ ownerId: namesOwner, items: [{
    candidate: { id: candidateId, ownerId: namesOwner, projectId: project.id, value, identityKey: nameIdentityKey(value), rationale: "Synthetic retained project name", contextRevision: 1, strategyBasis: namingStrategyBasis(project.context), strategyKey: namingStrategyKey(project.context), createdAt: when,
      origin: { kind: "local_import", ownerId: namesOwner, projectId: project.id, candidateId, contextRevision: 1, source, capturedContext: project.context } },
    retention: { ownerId: namesOwner, projectId: project.id, candidateId, revision: 1, favorite: true, saved: false, updatedAt: when },
    project: accountProjectSummarySchema.parse(project), currentSelection: true, earlierContext: false,
  }], nextCursor: null });
  await page.route(url => url.pathname === "/api/names", route => route.fulfill({ json: projectPage }));
  const projectWrites: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/projects/") && request.method() !== "GET") projectWrites.push(request.url()); });
  await page.goto("/names");
  const manual = page.getByRole("searchbox", { name: "Search names", exact: true });
  await expect(page.getByRole("searchbox")).toHaveCount(1); await manual.fill("Manual");
  await page.getByRole("button", { name: "Project names", exact: true }).click();
  const projectSearch = page.getByRole("searchbox", { name: "Search account names", exact: true });
  await expect(page.getByRole("searchbox")).toHaveCount(1); await projectSearch.fill("Cedar");
  const filter = page.getByRole("combobox", { name: "Filter project names", exact: true });
  await filter.selectOption("saved"); await expect(page.getByRole("heading", { name: "No account names in this view", exact: true })).toBeVisible();
  await filter.selectOption("favorite"); await expect(page.getByRole("heading", { name: value, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open source project: ${project.title}`, exact: true })).toHaveAttribute("href", `/brands/account/${project.id}/naming`);
  await expect(page.locator(".names-project-source")).toContainText("Untitled brand");
  const sourceLabel = (await page.locator(".names-project-source > span").boundingBox())!;
  const sourceLink = (await page.getByRole("link", { name: `Open source project: ${project.title}`, exact: true }).boundingBox())!;
  expect(Math.abs(sourceLabel.x - sourceLink.x)).toBeLessThanOrEqual(1);
  if (info.project.name === "desktop") {
    const title = (await page.getByRole("heading", { name: value, exact: true }).boundingBox())!;
    expect(sourceLabel.x).toBeGreaterThan(title.x + title.width);
    expect(sourceLabel.y).toBeLessThan(title.y + title.height);
    expect(sourceLink.y + sourceLink.height).toBeGreaterThan(title.y);
  }
  await page.getByRole("button", { name: "Workshop & manual", exact: true }).click();
  await expect(page.getByRole("searchbox")).toHaveCount(1); await expect(manual).toHaveValue("Manual");
  await page.getByRole("button", { name: "Project names", exact: true }).click();
  await expect(projectSearch).toHaveValue("Cedar"); await expect(filter).toHaveValue("favorite");
  expect(projectWrites).toEqual([]); expect(fixture.state.projects).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.querySelector("#main-content")?.scrollTo(0, 0); window.scrollTo(0, 0); });
  await captureUiEvidence(page, info);
});
