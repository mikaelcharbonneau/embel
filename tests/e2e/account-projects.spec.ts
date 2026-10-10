import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectSchema, accountProjectSummarySchema, type AccountProject } from "../../src/domain/project-api";
import { accountProjectDraft } from "../../src/components/workspace/project-draft-adapter";
import { contextSnapshotSchema, createProjectInputSchema } from "../../src/domain/projects";

// All account responses below are route-intercepted synthetic fixtures. No live auth or persistence is exercised.
const ownerA = "aaaaaaaa-1111-4111-8111-111111111111";
const ownerB = "bbbbbbbb-1111-4111-8111-111111111111";
const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const storageKey = "fluid.local-drafts.v1";
const when = "2026-10-02T10:00:00Z";
const source = { url: "https://example.com/fixture", title: "Local research fixture", retrievedAt: when };

function fixtureProject(id = projectA, owner = ownerA): AccountProject {
  return accountProjectSchema.parse({
    id, owner_id: owner, title: owner === ownerA ? "Private account A fixture" : "Private account B fixture", scope: "naming_only", current_revision: 1, created_at: when,
    context: contextSnapshotSchema.parse({
      description: "A fixture neighborhood kitchen for workers and local families.", activity: "Neighborhood kitchen", offering: "Fresh seasonal lunches", knownAudience: "Nearby workers", reformulationConfirmed: true,
      audienceSegments: [{ id: "33333333-3333-4333-8333-333333333333", label: "Nearby workers", needs: ["Reliable lunch\nwith a short wait", "Clear menu"], reason: "They work nearby", selected: true, origin: "proposal", sources: [source] }],
      competitors: [{ id: "44444444-4444-4444-8444-444444444444", name: "Competitor fixture", relevance: "Local kitchen", origin: "research", selected: true, sources: [source] }],
      personality: { sincerity: 70, excitement: 40, competence: 80, sophistication: 20, ruggedness: 10 }, competitorReviewComplete: true, positioning: "A calm daily fixture", selectedName: "Known name fixture", creativeLocale: "fr-CA",
      intake: { suppliedName: "Known name fixture", namingNotes: "Original naming notes", identityNotes: "Keep the poster system", step: "description", audienceReviewedAt: when, example: true },
    }),
  });
}

async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function accountFixtures(page: Page, initial: AccountProject[] = []) {
  const state = {
    owner: ownerA, sessionStatus: 200, patchStatus: 200, expandStatus: 200,
    projects: new Map(initial.map((project) => [project.id, structuredClone(project)])),
    writes: [] as { path: string; body: Record<string, unknown> }[],
    created: [] as AccountProject[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return reply(route, state.sessionStatus === 200 ? { user: { id: state.owner } } : { error: "Synthetic session fixture" }, state.sessionStatus);
    if (state.sessionStatus !== 200) return reply(route, { error: "Synthetic signed-out fixture" }, 401);
    if (path === "/api/projects/page" && request.method() === "GET") return reply(route, {
      ownerId: state.owner,
      items: [...state.projects.values()].filter(project => project.owner_id === state.owner)
        .map(project => accountProjectSummarySchema.parse(project))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)),
      nextCursor: null,
    });
    if (path === "/api/projects" && request.method() === "GET") return reply(route, { projects: [...state.projects.values()].filter((project) => project.owner_id === state.owner).map((project) => accountProjectSummarySchema.parse(project)) });
    if (path === "/api/projects" && request.method() === "POST") {
      const input = createProjectInputSchema.parse(request.postDataJSON());
      const project = accountProjectSchema.parse({ ...input, id: projectA, owner_id: state.owner, current_revision: 1, created_at: when });
      state.projects.set(project.id, project); state.created.push(project);
      state.writes.push({ path, body: request.postDataJSON() });
      return reply(route, { project }, 201);
    }
    const id = path.split("/")[3];
    const project = id ? state.projects.get(id) : undefined;
    if (!project || project.owner_id !== state.owner) return reply(route, { error: "Synthetic not-found fixture" }, 404);
    if (path.endsWith("/idea-source") && request.method() === "GET") return reply(route, { ownerId: state.owner, projectId: project.id, source: null });
    if (path.endsWith("/idea-attachments") && request.method() === "GET") return reply(route, { ownerId: state.owner, projectId: project.id, items: [], nextCursor: null });
    if (path.endsWith("/strategy") && request.method() === "GET") return reply(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (request.method() === "GET") return reply(route, { project });
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push({ path, body });
    if (body.expectedRevision !== project.current_revision) return reply(route, { error: "Synthetic revision conflict" }, 409);
    if (path.endsWith("/expand")) {
      if (state.expandStatus !== 200) return reply(route, { error: "Synthetic expansion failure" }, state.expandStatus);
      const expanded = { ...project, scope: "complete_brand" as const, current_revision: project.current_revision + 1 };
      state.projects.set(project.id, expanded);
      return reply(route, { project: expanded });
    }
    if (state.patchStatus !== 200) return reply(route, { error: "Synthetic save failure" }, state.patchStatus);
    const updated = { ...project, title: typeof body.title === "string" ? body.title : project.title, context: contextSnapshotSchema.parse(body.context), current_revision: project.current_revision + 1 };
    state.projects.set(project.id, updated);
    return reply(route, { revision: { project_id: project.id, owner_id: project.owner_id, revision: updated.current_revision, context: updated.context, input_hash: "fixture-only", created_at: when } });
  });
  return state;
}

async function openAccount(page: Page, id = projectA) {
  await page.goto(`/brands/account/${id}`);
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeVisible();
}
async function save(page: Page, version: number) {
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText(`Saved to account · version ${version}`, { exact: true })).toBeVisible();
}
async function browserData(page: Page) { return page.evaluate((key) => localStorage.getItem(key), storageKey); }

async function rename(page: Page, title: string) {
  await page.getByRole("button", { name: "Rename project", exact: true }).click();
  await page.getByRole("textbox", { name: "Project label", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Project label", exact: true }).press("Enter");
}
async function sendFollowup(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message Fluid", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeEmpty();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

test("account fixture: Naming entry preserves the saved-context boundary", async ({ page }) => {
  const project = fixtureProject();
  await accountFixtures(page, [project]);
  await openAccount(page);
  await expect(page.getByRole("link", { name: "Open Naming", exact: true })).toHaveAttribute("href", `/brands/account/${projectA}/naming`);
  await rename(page, "Unsaved naming entry fixture");
  await expect(page.getByRole("button", { name: "Open Naming", exact: true })).toBeDisabled();
  await expect(page.getByText("Save your edits before opening Naming.", { exact: true })).toBeVisible();
  await save(page, 2);
  await expect(page.getByRole("link", { name: "Open Naming", exact: true })).toBeVisible();
});

test("account fixture: full brand needs reviewed strategy and identity-only omits Naming", async ({ page }) => {
  const project = fixtureProject();
  project.scope = "complete_brand";
  project.context.intake.audienceReviewedAt = null;
  const state = await accountFixtures(page, [project]);
  await openAccount(page);
  await expect(page.getByRole("button", { name: "Open Naming", exact: true })).toBeDisabled();
  await expect(page.getByText("Finish reviewing your strategy before opening Naming.", { exact: true })).toBeVisible();
  state.projects.set(projectA, { ...project, scope: "visual_identity_only" });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Naming", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Naming", exact: true })).toHaveCount(0);
});

test("account fixture: explicit browser copy preserves legacy notes, audience and context across reload", async ({ page }, testInfo) => {
  const state = await accountFixtures(page);
  const legacyProject = fixtureProject();
  legacyProject.scope = "visual_identity_only";
  legacyProject.title = "Culture browser fixture";
  legacyProject.context.intake = { ...legacyProject.context.intake, suppliedName: "Common Room fixture", identityNotes: "Keep the legible poster grid", step: "audience" };
  const legacy = { ...accountProjectDraft(legacyProject), preservedContext: legacyProject.context };
  await page.addInitScript(({ key, legacy }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 1, drafts: [legacy] }));
  }, { key: storageKey, legacy });
  await page.goto(`/brands/${legacy.id}`);
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeVisible();
  const localBefore = await browserData(page);
  await page.getByText("Account saving", { exact: true }).click();
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectA}$`));
  await expect(page.getByText("Saved to account · version 1", { exact: true })).toBeVisible();
  expect(await browserData(page)).toBe(localBefore);
  expect(state.created[0]?.context).toEqual(legacyProject.context);
  await page.reload();
  await expect(page.getByText("Example prompt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit audience", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Selected target" })).toBeChecked();
  await rename(page, "Renamed account fixture");
  await sendFollowup(page, "Keep the poster grid and add strong contrast.");
  await save(page, 2);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Renamed account fixture", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Keep the poster grid and add strong contrast.", { exact: true })).toBeVisible();
  await page.getByText("Saved project details", { exact: true }).click();
  await expect(page.locator(".conversation-saved-details").getByText("Common Room fixture", { exact: true })).toBeVisible();
  await expect(page.locator(".conversation-saved-details").getByText("Keep the legible poster grid", { exact: true })).toBeVisible();
  expect(state.projects.get(projectA)?.context.audienceSegments).toEqual(legacyProject.context.audienceSegments);
  expect(state.projects.get(projectA)?.context.competitors).toEqual(legacyProject.context.competitors);
  expect(await browserData(page)).toBe(localBefore);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath("account-editor.png"), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  await page.getByRole("link", { name: "Back to all projects" }).click();
  await expect(page.getByRole("heading", { name: "Renamed account fixture" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Culture browser fixture" })).toBeVisible();
});

test("account fixture: hidden strategy and audience provenance survive edits and saved scope expansion", async ({ page }) => {
  const original = fixtureProject();
  const state = await accountFixtures(page, [original]);
  await openAccount(page);
  await sendFollowup(page, "New naming notes");
  await expect(page.getByRole("button", { name: "Expand to complete brand" })).toBeDisabled();
  await save(page, 2);
  const saved = state.projects.get(projectA)!.context;
  for (const field of ["activity", "offering", "knownAudience", "audienceSegments", "competitors", "personality", "positioning", "selectedName"] as const) expect(saved[field]).toEqual(original.context[field]);
  expect(saved.intake.namingNotes).toBe(original.context.intake.namingNotes);
  expect(saved.intake.audienceReviewedAt).toBeNull();
  expect(saved.intake.conversation?.at(-1)).toMatchObject({ kind: "user_message", text: "New naming notes" });
  state.expandStatus = 503;
  await page.getByRole("button", { name: "Expand to complete brand" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Account saving is unavailable");
  expect(state.projects.get(projectA)?.scope).toBe("naming_only");
  await expect(page.getByText("Saved to account · version 2", { exact: true })).toBeVisible();
  state.expandStatus = 200;
  await page.getByRole("button", { name: "Expand to complete brand" }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  expect(state.projects.get(projectA)?.scope).toBe("complete_brand");
  expect(state.projects.get(projectA)?.context.audienceSegments).toEqual(original.context.audienceSegments);
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand to complete brand" })).toHaveCount(0);
  await expect(page.locator(".account-scope > strong")).toHaveText("Complete brand");
  await expect(page.getByRole("button", { name: "Open Naming", exact: true })).toBeDisabled();
  expect(await browserData(page)).toBeNull();
  expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("account fixture: a transcript over the request byte cap stays recoverable without an oversized write", async ({ page }) => {
  const original = fixtureProject();
  const state = await accountFixtures(page, [original]);
  await openAccount(page);
  const followup = "漢".repeat(11_000);
  await sendFollowup(page, followup);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(/large|size|shorten|32/i);
  expect(state.writes).toHaveLength(0);
  expect(state.projects.get(projectA)).toEqual(original);
  await expect(page.getByText(followup, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save edits as browser copy", exact: true }).click();
  const copy = JSON.parse((await browserData(page))!).drafts[0];
  expect(copy.conversation.at(-1)).toMatchObject({ kind: "user_message", text: followup });
  expect(copy.preservedContext).toEqual(original.context);
});

test("account fixture: 409 keeps edits, offers an explicit browser copy and requires confirmation to load latest", async ({ page }, testInfo) => {
  const original = fixtureProject();
  const state = await accountFixtures(page, [original]);
  await openAccount(page);
  await rename(page, "Unsaved recovery fixture");
  await sendFollowup(page, "Keep my unsaved notes");
  state.projects.set(projectA, { ...original, title: "Remote latest fixture", current_revision: 2 });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("A newer version is saved");
  await expect(page.getByRole("heading", { name: "Unsaved recovery fixture", exact: true, level: 1 })).toBeVisible();
  expect(await browserData(page)).toBeNull();
  await page.getByRole("button", { name: "Save edits as browser copy" }).click();
  const copied = JSON.parse((await browserData(page))!).drafts[0];
  expect(copied.title).toBe("Unsaved recovery fixture");
  expect(copied.namingNotes).toBe(original.context.intake.namingNotes);
  expect(copied.conversation.at(-1)).toMatchObject({ kind: "user_message", text: "Keep my unsaved notes" });
  expect(copied.preservedContext).toEqual(original.context);
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("account-conflict-recovery.png"), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByRole("heading", { name: "Unsaved recovery fixture", exact: true, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await page.getByRole("button", { name: "Replace with latest version" }).click();
  await expect(page.getByRole("heading", { name: "Remote latest fixture", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Saved to account · version 2", { exact: true })).toBeVisible();
});

test("account fixture: expired session masks private data and same-account recovery keeps edits across internal navigation", async ({ page }) => {
  const state = await accountFixtures(page, [fixtureProject()]);
  await openAccount(page);
  await sendFollowup(page, "A private unsaved note");
  await page.getByRole("link", { name: "Back to all projects" }).click();
  await page.getByRole("link", { name: /Private account A fixture/ }).click();
  await expect(page.getByText("A private unsaved note", { exact: true })).toBeVisible();
  state.patchStatus = 401;
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("No verified account session.", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText("Private account A fixture", { exact: true })).toHaveCount(0);
  expect(await browserData(page)).toBeNull();
  state.sessionStatus = 401;
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check account", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  state.sessionStatus = 200; state.patchStatus = 200;
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await expect(page.getByText("A private unsaved note", { exact: true })).toBeVisible();
  await save(page, 2);
  expect(await browserData(page)).toBeNull();
});

test("account fixture: an account switch fences a late save and never exposes or stores the previous account draft", async ({ page }) => {
  const state = await accountFixtures(page, [fixtureProject(), fixtureProject(projectB, ownerB)]);
  await openAccount(page);
  await rename(page, "Account A secret pending edit");
  let release!: () => void;
  let started!: () => void;
  let delivered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  const completed = new Promise<void>((resolve) => { delivered = resolve; });
  await page.route(`**/api/projects/${projectA}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    started(); await pending;
    await reply(route, { revision: { project_id: projectA, owner_id: ownerA, revision: 2, context: body.context, input_hash: "delayed-fixture", created_at: when } });
    delivered();
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await requested;
  state.owner = ownerB;
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("not available to this account");
  release();
  await completed;
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText("Account A secret pending edit", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save edits as browser copy" })).toHaveCount(0);
  expect(await browserData(page)).toBeNull();
  await page.getByRole("link", { name: "Back to brands", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Private account B fixture" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Private account A fixture" })).toHaveCount(0);
  await page.getByRole("link", { name: /Private account B fixture/ }).click();
  await rename(page, "Account B safe edit");
  await save(page, 2);
});

test("account fixture: late project loading and mismatched response ownership never render private content", async ({ page }) => {
  const state = await accountFixtures(page, [fixtureProject(), fixtureProject(projectB, ownerB)]);
  let release!: () => void;
  let started!: () => void;
  let delivered!: () => void;
  let held = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  const completed = new Promise<void>((resolve) => { delivered = resolve; });
  await page.route(`**/api/projects/${projectA}`, async (route) => {
    if (held || route.request().method() !== "GET") return route.fallback();
    held = true; started(); await pending;
    await reply(route, { project: fixtureProject() });
    delivered();
  });
  await page.goto(`/brands/account/${projectA}`);
  await requested;
  state.owner = ownerB;
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("not available to this account");
  release();
  await completed;
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText("Private account A fixture", { exact: true })).toHaveCount(0);
  await page.route(`**/api/projects/${projectB}`, async (route) => reply(route, { project: { ...fixtureProject(), id: projectB } }));
  await page.goto(`/brands/account/${projectB}`);
  await expect(page.getByText("No verified account session.", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(await browserData(page)).toBeNull();
});

test("account fixture: malformed account data and unknown remote IDs cannot become browser drafts", async ({ page }) => {
  await accountFixtures(page);
  await page.route(`**/api/projects/${projectA}`, async (route) => reply(route, { project: { id: projectA, title: "Unverified malformed fixture" } }));
  await page.goto(`/brands/account/${projectA}`);
  await expect(page.locator("main").getByRole("alert")).toContainText("could not be verified");
  await expect(page.getByText("Unverified malformed fixture", { exact: true })).toHaveCount(0);
  await page.goto("/brands/account/does-not-exist");
  await expect(page.getByRole("heading", { name: "Account project not found" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft not found in this browser" })).toHaveCount(0);
  expect(await browserData(page)).toBeNull();
});

test("account fixture: a delayed load after internal navigation cannot roll back a newer successful save", async ({ page }) => {
  const original = fixtureProject();
  const state = await accountFixtures(page, [original]);
  await openAccount(page);
  await page.getByRole("link", { name: "Back to all projects" }).click();
  let release!: () => void;
  let started!: () => void;
  let held = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route(`**/api/projects/${projectA}`, async (route) => {
    if (held || route.request().method() !== "GET") return route.fallback();
    held = true; started(); await pending;
    await reply(route, { project: original });
  });
  await page.getByRole("link", { name: /Private account A fixture/ }).click();
  await requested;
  await rename(page, "Newer successful save fixture");
  await save(page, 2);
  const oldResponse = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${projectA}`) && response.request().method() === "GET");
  release();
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole("heading", { name: "Newer successful save fixture", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Saved to account · version 2", { exact: true })).toBeVisible();
  expect(state.projects.get(projectA)?.title).toBe("Newer successful save fixture");
  await rename(page, "Follow-on version three fixture");
  await save(page, 3);
  expect(state.writes.at(-1)?.body.expectedRevision).toBe(2);
  expect(await browserData(page)).toBeNull();
});

test("account fixture: typing while a confirmed latest-version load is pending keeps the newer edits", async ({ page }) => {
  const original = fixtureProject();
  const state = await accountFixtures(page, [original]);
  await openAccount(page);
  await rename(page, "My first unsaved edit");
  state.projects.set(projectA, { ...original, current_revision: 2, title: "Remote latest fixture" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("A newer version is saved");
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route(`**/api/projects/${projectA}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    started(); await pending;
    await reply(route, { project: state.projects.get(projectA) });
  });
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await page.getByRole("button", { name: "Replace with latest version" }).click();
  await requested;
  await rename(page, "New edit while loading");
  release();
  await expect(page.getByText("Your edits changed while the latest version was loading.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New edit while loading", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save edits as browser copy" })).toBeEnabled();
  expect(await browserData(page)).toBeNull();
});

for (const status of [404, 503]) {
  test(`account fixture: ${status} during revalidation masks cached data and keeps edits for a successful retry`, async ({ page }) => {
    await accountFixtures(page, [fixtureProject()]);
    await openAccount(page);
    await rename(page, "Private unsaved revalidation fixture");
    await page.getByRole("link", { name: "Back to all projects" }).click();
    let failing = true;
    await page.route(`**/api/projects/${projectA}`, async (route) => failing ? reply(route, { error: "Synthetic revalidation failure" }, status) : route.fallback());
    await page.getByRole("link", { name: /Private account A fixture/ }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText(status === 404 ? "not available to this account" : "Account saving is unavailable");
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByText("Private unsaved revalidation fixture", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Unsaved account edits remain in this tab.", { exact: false })).toBeVisible();
    failing = false;
    await page.getByRole("button", { name: "Check account and retry" }).click();
    await expect(page.getByRole("heading", { name: "Private unsaved revalidation fixture", exact: true, level: 1 })).toBeVisible();
    await save(page, 2);
    expect(await browserData(page)).toBeNull();
  });
}
