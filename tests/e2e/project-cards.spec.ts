import { expect, test, type Page } from "@playwright/test";
import { createVisualJourneyFixture } from "../fixtures/visual-identity-journey";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";
import { accountProjectResponseSchema } from "../../src/domain/project-api";
import {
  getIdentityCurrentBasis,
  getIdentityReadiness,
  projectIdentityOverviewSchema,
} from "../../src/domain/project-identity";
import { identityBatchOverviewSchema } from "../../src/domain/identity-jobs";
import { accountProjectPageSchema, compareProjectCursors, projectCursor } from "../../src/domain/project-pages";
import { captureUiEvidence } from "./ui-evidence";

// Synthetic, read-only account fixtures. No provider, account write or real
// selected artwork is used by this local browser contract.
async function setup(page: Page) {
  const selectedName = "Cedar & Finch";
  const journey = createVisualJourneyFixture({ name: selectedName });
  const { workspace, sourceLogo, logoBatch } = journey;
  const rows = [
    { id: workspace.projectId, title: "Untitled brand", scope: "complete_brand" },
    {
      id: id(900),
      title: "A long project label with enough detail to demonstrate a two-line title and a stable fallback",
      scope: "complete_brand",
    },
    { id: id(901), title: "Naming project fixture", scope: "naming_only" },
  ].map((row) => ({
    ...row,
    owner_id: workspace.ownerId,
    current_revision: 1,
    lifecycle_version: 0,
    created_at: "2026-10-20T00:00:00Z",
    deletion_state: "active",
    deleted_at: null,
    deletion_requested_at: null,
  }));
  // Use the real HTTP contracts so an invalid local fixture fails here instead
  // of masquerading as an application rendering or private-preview failure.
  const projectPage = accountProjectPageSchema.parse({
    ownerId: workspace.ownerId,
    items: [...rows].sort((a, b) => -compareProjectCursors(projectCursor(a), projectCursor(b))),
    nextCursor: null,
  });
  const projects = projectPage.items.map(
    (row) =>
      accountProjectResponseSchema.parse({
        project: {
          ...row,
          context: row.id === workspace.projectId ? { ...journey.project.context, selectedName } : {},
        },
      }).project,
  );
  const project = projects.find((item) => item.id === workspace.projectId)!;
  const scope = { projectId: project.id, ownerId: project.owner_id };
  const emptyWorkspace = { ...syntheticLogoWorkspace(), ownerId: workspace.ownerId, projectId: id(900) };
  const identity = journey.overview();
  const overview = projectIdentityOverviewSchema.parse({
    ...identity,
    project: {
      ...identity.project,
      scope: project.scope,
      title: project.title,
      created_at: project.created_at,
      context: project.context,
    },
    currentBasis: getIdentityCurrentBasis({
      ...scope,
      context: project.context,
      references: identity.referenceSnapshot,
      preferences: journey.input.preferences,
      logoBrief: sourceLogo.brief,
    }),
    readiness: getIdentityReadiness(project.context, project.scope, identity.referenceSnapshot),
    systems: { ...identity.systems, query: { limit: 1 } },
  });
  const batches = identityBatchOverviewSchema.parse({ ...scope, availability: journey.availability(), latest: null });
  const state = { writes: [] as string[], previewReads: 0, directionReads: [] as string[] };
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (request.method() !== "GET") {
      state.writes.push(`${request.method()} ${path}`);
      return reply({}, 503);
    }
    if (path === "/api/session") return reply({ user: { id: workspace.ownerId } });
    if (path === "/api/projects/page") return reply(projectPage);
    const detail = projects.find((item) => path === `/api/projects/${item.id}`);
    if (detail) return reply({ project: detail });
    const base = `/api/projects/${project.id}`;
    if (path === `${base}/logo`) return reply(workspace);
    if (path === `/api/projects/${emptyWorkspace.projectId}/logo`) return reply(emptyWorkspace);
    if (path === `/api/projects/${emptyWorkspace.projectId}/logo/batches`)
      return reply({ ownerId: workspace.ownerId, projectId: emptyWorkspace.projectId, items: [], nextCursor: null });
    const revision = journey.stages.get(path.split("/").at(-1)!);
    if (revision && path === `${base}/logo/stages/${revision.stage}/revisions/${revision.id}`) return reply(revision);
    if (path === `${base}/logo/batches/${logoBatch.id}`) return reply(logoBatch);
    if (path === `${base}/logo/batches`)
      return reply({
        ...scope,
        items: [{ id: logoBatch.id, requestKey: logoBatch.requestKey, createdAt: logoBatch.createdAt }],
        nextCursor: null,
      });
    if (path === `${base}/identity` && url.searchParams.get("limit") === "1") {
      state.directionReads.push("selection");
      return reply(overview);
    }
    if (path === `${base}/identity/batches`) {
      state.directionReads.push("batches");
      return reply(batches);
    }
    if (path === `/api/assets/${sourceLogo.preview.reference.versionId}/preview`) {
      state.previewReads++;
      return route.fulfill({ contentType: "image/png", body: journey.logoBytes });
    }
    return reply({}, 404);
  });
  return { state, rows, selectedName };
}

for (const route of ["/brands", "/"])
  test(`saved project cards resume the next step on ${route === "/" ? "Home" : "Projects"}`, async ({ page }, info) => {
    await page.setViewportSize(
      info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    const { state, rows, selectedName } = await setup(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(route);
    const card = page.locator(`[data-project-id="${rows[0]!.id}"]`);
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("heading", { name: selectedName, exact: true })).toBeVisible();
    const image = card.getByRole("img", { name: `Saved selected logo for ${selectedName}` });
    await expect(image).toBeVisible();
    expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(48);
    const fallback = page.locator(`[data-project-id="${rows[1]!.id}"]`);
    await fallback.scrollIntoViewIfNeeded();
    // No logo yet: the picture area sets the name in type, with no "No logo yet" label.
    await expect(fallback.locator('[data-project-preview="placeholder"]')).toHaveText(rows[1]!.title);
    await expect(fallback.getByText("No logo yet", { exact: true })).toHaveCount(0);
    const title = fallback.getByRole("heading");
    await expect(title).toHaveAttribute("title", rows[1]!.title);
    // A long name takes at most two lines.
    const geometry = await title.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const open = card.getByRole("link");
    await expect(open).toHaveAttribute("href", `/brands/account/${rows[0]!.id}/logo/directions`);
    await expect(open).toHaveAccessibleName(selectedName);
    await expect(open).toHaveAccessibleDescription("Explore creative directions");
    await expect(card.getByRole("img", { name: "Step 3 of 4: Identity" })).toBeVisible();
    await expect(fallback.getByRole("link")).toHaveAttribute(
      "href",
      `/brands/account/${rows[1]!.id}?view=strategy#strategy-brief`,
    );
    await open.focus();
    await page.keyboard.press("Tab");
    const options = card.getByRole("button", { name: `Project options for ${selectedName}`, exact: true });
    await expect(options).toBeFocused();
    await options.click();
    await expect(card.getByRole("menu")).toBeVisible();
    // The first row takes focus; the destructive Delete row comes last.
    await expect(card.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
    await expect(card.getByRole("menuitem", { name: "Delete", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    await expect(card.getByRole("menu")).toHaveCount(0);
    expect(new Set(state.directionReads)).toEqual(new Set(["selection", "batches"]));
    expect(state.writes).toEqual([]);
    expect(state.previewReads).toBe(1);
    expect(errors).toEqual([]);
    await card.scrollIntoViewIfNeeded();
    await captureUiEvidence(page, info);
  });
