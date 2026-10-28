import { expectProjectCanvas } from "./project-canvas-contract";
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
const accountStates = new WeakMap<Page, { projects: Map<string, AccountProject> }>();
const source = { url: "https://example.com/fixture", title: "Local research fixture", retrievedAt: when };

function fixtureProject(id = projectA, owner = ownerA): AccountProject {
  return accountProjectSchema.parse({
    id, owner_id: owner, title: owner === ownerA ? "Private account A fixture" : "Private account B fixture", scope: "naming_only", current_revision: 1, created_at: when, deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0,
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
  accountStates.set(page, state);
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
      const project = accountProjectSchema.parse({ ...input, id: projectA, owner_id: state.owner, current_revision: 1, created_at: when, deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0 });
      state.projects.set(project.id, project); state.created.push(project);
      state.writes.push({ path, body: request.postDataJSON() });
      return reply(route, { project }, 201);
    }
    const id = path.split("/")[3];
    const project = id ? state.projects.get(id) : undefined;
    if (!project || project.owner_id !== state.owner) return reply(route, { error: "Synthetic not-found fixture" }, 404);
    if (path.endsWith("/idea-source") && request.method() === "GET") return reply(route, { ownerId: state.owner, projectId: project.id, source: null });
    if (path.endsWith("/standalone-source") && request.method() === "GET") return reply(route, { ownerId: state.owner, projectId: project.id, source: null });
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
  await Promise.all([waitForAccountProject(page, id), page.goto(`/brands/account/${id}`)]);
  await expect(page.getByRole("button", { name: "Edit brief", exact: true })).toBeVisible();
}
function waitForAccountProject(page: Page, id = projectA) {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${id}` && response.request().method() === "GET" && response.status() === 200, { timeout: 30_000 });
}
async function openProjectDetails(page: Page) {
  const menu = page.locator(".workspace-account-menu");
  if (await menu.getAttribute("open") !== null) await menu.locator("summary").click();
  const editor = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  if (!await editor.isVisible()) await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  await expect(editor).toBeVisible(); return editor;
}
async function closeProjectDetails(page: Page) {
  const editor = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  if (await editor.isVisible()) await editor.getByRole("button", { name: "Close", exact: true }).click();
}
async function openProjects(page: Page) {
  await closeProjectDetails(page);
  const desktop = page.locator(".sidebar").getByRole("link", { name: "Projects", exact: true });
  if (await desktop.isVisible()) await desktop.click();
  else {
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("dialog", { name: "Navigation", exact: true }).getByRole("link", { name: "Projects", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/brands$/);
}
async function checkAccount(page: Page) {
  await closeProjectDetails(page);
  const menu = page.locator(".workspace-account-menu");
  if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
  await page.getByRole("button", { name: "Check account", exact: true }).click();
}
async function expectLabel(page: Page, title: string) {
  const editor = await openProjectDetails(page);
  await expect(editor.getByRole("textbox", { name: "Project label", exact: true })).toHaveValue(title);
  await closeProjectDetails(page);
}
async function expectSavedVersion(page: Page, version: number) {
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect.poll(() => accountStates.get(page)?.projects.get(id)?.current_revision).toBe(version);
  await expect(page.locator(".guided-brief-editor [role=status]")).toHaveText("Saved");
  await expectProjectCanvas(page);
}
async function save(page: Page, version: number) {
  await closeProjectDetails(page);
  const retry = page.getByRole("button", { name: "Retry save", exact: true });
  if (await retry.first().isVisible()) await retry.first().click();
  await expectSavedVersion(page, version);
}
async function browserData(page: Page) { return page.evaluate(key => localStorage.getItem(key), storageKey); }
async function rename(page: Page, title: string) {
  const editor = await openProjectDetails(page);
  await editor.getByRole("textbox", { name: "Project label", exact: true }).fill(title);
  await closeProjectDetails(page);
}
async function editDescription(page: Page, text: string) {
  const editor = await openProjectDetails(page);
  await editor.getByRole("textbox", { name: "Brief description", exact: true }).fill(text);
  await closeProjectDetails(page);
}
async function expectUnsaved(page: Page) {
  await expect(page.getByRole("button", { name: "Retry save", exact: true }).first()).toBeVisible();
  await expect(page.locator(".guided-brief-editor [role=status]")).toHaveText("Changes not saved");
}

test("account fixture: Naming entry preserves the saved-context boundary", async ({ page }) => {
  const project = fixtureProject();
  const state = await accountFixtures(page, [project]);
  await Promise.all([waitForAccountProject(page), page.goto(`/brands/account/${projectA}`)]);
  await expect(page.getByRole("link", { name: "Review saved name", exact: true })).toHaveAttribute("href", `/brands/account/${projectA}/naming`);
  state.patchStatus = 503;
  await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  await editor.getByRole("textbox", { name: "Project label", exact: true }).fill("Unsaved naming entry fixture");
  await expect(editor.getByRole("status")).toHaveText("Changes not saved");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review saved name", exact: true })).toBeDisabled();
  state.patchStatus = 200;
  await page.getByRole("button", { name: "Retry save", exact: true }).first().click();
  await expect(page.getByRole("link", { name: "Review saved name", exact: true })).toHaveAttribute("href", `/brands/account/${projectA}/naming`);
  expect(state.projects.get(projectA)?.title).toBe("Unsaved naming entry fixture");
  expect(state.writes.every(write => write.path === `/api/projects/${projectA}`)).toBe(true);
});

test("account fixture: full brand needs reviewed strategy and identity-only omits Naming", async ({ page }) => {
  const project = fixtureProject(); project.scope = "complete_brand"; project.context.intake.audienceReviewedAt = null;
  const state = await accountFixtures(page, [project]); await openAccount(page);
  await expect(page.getByRole("link", { name: /Naming|saved name/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  state.projects.set(projectA, { ...project, scope: "visual_identity_only" });
  await Promise.all([waitForAccountProject(page), page.reload()]);
  await expect(page.getByRole("button", { name: "Edit brief", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Naming|saved name/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Naming|saved name/ })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("account fixture: explicit browser copy preserves legacy notes, audience and context across reload", async ({ page }, info) => {
  const state = await accountFixtures(page), legacyProject = fixtureProject();
  legacyProject.scope = "visual_identity_only"; legacyProject.title = "Culture browser fixture";
  legacyProject.context.intake = { ...legacyProject.context.intake, suppliedName: "Common Room fixture", identityNotes: "Keep the legible poster grid", step: "audience" };
  const legacy = { ...accountProjectDraft(legacyProject), preservedContext: legacyProject.context };
  await page.addInitScript(({ key, legacy }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 1, drafts: [legacy] })); }, { key: storageKey, legacy });
  await page.goto(`/brands/${legacy.id}`);
  await page.getByRole("button", { name: "Recover unsaved projects", exact: true }).click();
  await page.getByRole("radio", { name: /Culture browser fixture/ }).check();
  await expect(page.getByRole("button", { name: "Save project", exact: true })).toHaveCount(0);
  const localBefore = JSON.parse((await browserData(page))!).drafts[0];
  await page.getByRole("checkbox", { name: "This is my project, and I want to save it to the account I’m currently signed in to.", exact: true }).check();
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectA}$`)); await expectSavedVersion(page, 1);
  const recoveredDraft = JSON.parse((await browserData(page))!).drafts[0];
  expect(recoveredDraft).toMatchObject({ ...localBefore, ownerId: ownerA, accountProjectId: projectA, updatedAt: expect.any(String) });
  expect(state.created[0]?.context).toEqual(legacyProject.context);
  await page.reload(); await expectLabel(page, legacyProject.title);
  await rename(page, "Renamed account fixture"); await save(page, 2);
  await editDescription(page, "Keep the poster grid and add strong contrast."); await save(page, 3);
  await page.reload(); await expectLabel(page, "Renamed account fixture");
  const editor = await openProjectDetails(page);
  await expect(editor.getByRole("textbox", { name: "Brief description", exact: true })).toHaveValue("Keep the poster grid and add strong contrast."); await closeProjectDetails(page);
  const stored = state.projects.get(projectA)!.context;
  expect(stored.intake.suppliedName).toBe("Common Room fixture"); expect(stored.intake.identityNotes).toBe("Keep the legible poster grid");
  expect(stored.audienceSegments).toEqual(legacyProject.context.audienceSegments); expect(stored.competitors).toEqual(legacyProject.context.competitors);
  expect(JSON.parse((await browserData(page))!).drafts[0]).toEqual(recoveredDraft); await expectProjectCanvas(page);
  await page.screenshot({ path: info.outputPath("account-editor.png"), fullPage: true, scale: "css" });
  await openProjects(page); await expect(page.getByRole("heading", { name: "Renamed account fixture", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Culture browser fixture", exact: true })).toHaveCount(0);
  await expect(page.locator('.project-card[data-storage="browser"]')).toHaveCount(0);
});

test("account fixture: hidden strategy and audience provenance survive edits and saved scope expansion", async ({ page }) => {
  const original = fixtureProject(), state = await accountFixtures(page, [original]); await openAccount(page); state.patchStatus = 503;
  await editDescription(page, "New naming brief description"); await expectUnsaved(page);
  await expect(page.getByRole("button", { name: "Expand to complete brand", exact: true })).toBeDisabled();
  state.patchStatus = 200; await save(page, 2);
  const saved = state.projects.get(projectA)!.context;
  for (const field of ["activity", "offering", "knownAudience", "audienceSegments", "competitors", "personality", "positioning", "selectedName"] as const) expect(saved[field]).toEqual(original.context[field]);
  expect(saved.intake.namingNotes).toBe(original.context.intake.namingNotes); expect(saved.intake.audienceReviewedAt).toBeNull(); expect(saved.description).toBe("New naming brief description");
  state.expandStatus = 503; await page.getByRole("button", { name: "Expand to complete brand", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Account saving is unavailable" })).toBeVisible();
  expect(state.projects.get(projectA)?.scope).toBe("naming_only"); await expectSavedVersion(page, 2);
  state.expandStatus = 200; await page.getByRole("button", { name: "Expand to complete brand", exact: true }).click(); await expectSavedVersion(page, 3);
  expect(state.projects.get(projectA)?.scope).toBe("complete_brand"); expect(state.projects.get(projectA)?.context.audienceSegments).toEqual(original.context.audienceSegments);
  await page.reload(); await expect(page.getByRole("button", { name: "Expand to complete brand", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Naming|saved name/ })).toHaveCount(0); expect(await browserData(page)).toBeNull(); await expectProjectCanvas(page);
});

test("account fixture: a brief over the request byte cap stays recoverable without an oversized write", async ({ page }) => {
  const original = fixtureProject(), state = await accountFixtures(page, [original]); await openAccount(page);
  const text = "漢".repeat(11000); await editDescription(page, text); await expectUnsaved(page);
  await expect(page.getByRole("alert").filter({ hasText: /large|size|shorten|32/i })).toBeVisible();
  expect(state.writes).toHaveLength(0); expect(state.projects.get(projectA)).toEqual(original);
  const editor = await openProjectDetails(page); await expect(editor.getByRole("textbox", { name: "Brief description", exact: true })).toHaveValue(text); await closeProjectDetails(page);
  await page.getByRole("button", { name: "Keep a recovery copy", exact: true }).click();
  const copy = JSON.parse((await browserData(page))!).drafts[0]; expect(copy.description).toBe(text); expect(copy.preservedContext).toEqual(original.context);
});

test("account fixture: 409 keeps edits, offers an explicit browser copy and requires confirmation to load latest", async ({ page }, info) => {
  const original = fixtureProject(), state = await accountFixtures(page, [original]); await openAccount(page); state.patchStatus = 503;
  await rename(page, "Unsaved recovery fixture"); await editDescription(page, "Keep my unsaved notes"); await expectUnsaved(page);
  state.projects.set(projectA, { ...original, title: "Remote latest fixture", current_revision: 2 }); state.patchStatus = 200;
  await page.getByRole("button", { name: "Retry save", exact: true }).first().click(); await expect(page.locator(".account-conflict")).toContainText("A newer version is saved");
  await expectLabel(page, "Unsaved recovery fixture"); expect(await browserData(page)).toBeNull();
  await page.getByRole("button", { name: "Keep a recovery copy", exact: true }).click(); const copy = JSON.parse((await browserData(page))!).drafts[0];
  expect(copy.title).toBe("Unsaved recovery fixture"); expect(copy.namingNotes).toBe(original.context.intake.namingNotes); expect(copy.description).toBe("Keep my unsaved notes"); expect(copy.preservedContext).toEqual(original.context);
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await page.screenshot({ path: info.outputPath("account-conflict-recovery.png"), fullPage: true, scale: "css" });
  await page.getByRole("button", { name: "Keep editing", exact: true }).click(); await expectLabel(page, "Unsaved recovery fixture");
  await page.getByRole("button", { name: "Load latest version", exact: true }).click(); await page.getByRole("button", { name: "Replace with latest version", exact: true }).click();
  await expectLabel(page, "Remote latest fixture"); await expectSavedVersion(page, 2);
});

test("account fixture: expired session masks private data and same-account recovery keeps edits across internal navigation", async ({ page }) => {
  const state = await accountFixtures(page, [fixtureProject()]); await openAccount(page); state.patchStatus = 503;
  await editDescription(page, "A private unsaved note"); await expectUnsaved(page); await openProjects(page);
  await page.getByRole("link", { name: /Private account A fixture/ }).click(); const editor = await openProjectDetails(page);
  await expect(editor.getByRole("textbox", { name: "Brief description", exact: true })).toHaveValue("A private unsaved note"); await closeProjectDetails(page);
  state.patchStatus = 401; await page.getByRole("button", { name: "Retry save", exact: true }).first().click();
  await expect(page.getByText("No verified account session.", { exact: false })).toBeVisible(); await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText("Private account A fixture", { exact: true })).toHaveCount(0); expect(await browserData(page)).toBeNull();
  state.sessionStatus = 401; await checkAccount(page); await expect(page.getByRole("button", { name: "Check account", exact: true })).toBeEnabled(); await expect(page.getByRole("textbox")).toHaveCount(0);
  state.sessionStatus = 200; state.patchStatus = 200; await checkAccount(page);
  const recovered = await openProjectDetails(page); await expect(recovered.getByRole("textbox", { name: "Brief description", exact: true })).toHaveValue("A private unsaved note"); await closeProjectDetails(page); await save(page, 2); expect(await browserData(page)).toBeNull();
});

test("account fixture: an account switch fences a late save and never exposes or stores the previous account draft", async ({ page }) => {
  const state = await accountFixtures(page, [fixtureProject(), fixtureProject(projectB, ownerB)]); await openAccount(page);
  let release!: () => void, started!: () => void, delivered!: () => void; const pending = new Promise<void>(r => { release = r; }), requested = new Promise<void>(r => { started = r; }), completed = new Promise<void>(r => { delivered = r; });
  await page.route(`**/api/projects/${projectA}`, async route => { if (route.request().method() !== "PATCH") return route.fallback(); const body = route.request().postDataJSON(); started(); await pending; await reply(route, { revision: { project_id: projectA, owner_id: ownerA, revision: 2, context: body.context, input_hash: "delayed-fixture", created_at: when } }); delivered(); });
  await rename(page, "Account A secret pending edit"); await requested; state.owner = ownerB; await checkAccount(page);
  await expect(page.locator(".project-workspace-content").getByRole("alert")).toContainText("not available to this account"); release(); await completed;
  await expect(page.getByRole("textbox")).toHaveCount(0); await expect(page.getByText("Account A secret pending edit", { exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Keep a recovery copy", exact: true })).toHaveCount(0); expect(await browserData(page)).toBeNull();
  await page.getByRole("link", { name: "Back to brands", exact: true }).click(); await expect(page.getByRole("heading", { name: "Private account B fixture", exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: "Private account A fixture", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: /Private account B fixture/ }).click(); await rename(page, "Account B safe edit"); await save(page, 2);
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
  await checkAccount(page);
  await expect(page.locator(".project-workspace-content").getByRole("alert")).toContainText("not available to this account");
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
  await expect(page.locator(".project-workspace-content").getByRole("alert")).toContainText("could not be verified");
  await expect(page.getByText("Unverified malformed fixture", { exact: true })).toHaveCount(0);
  await page.goto("/brands/account/does-not-exist");
  await expect(page.getByRole("heading", { name: "Project not found", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft not found in this browser" })).toHaveCount(0);
  expect(await browserData(page)).toBeNull();
});

test("account fixture: a delayed load after internal navigation cannot roll back a newer successful save", async ({ page }) => {
  const original = fixtureProject(), state = await accountFixtures(page, [original]); await openAccount(page); await openProjects(page);
  let release!: () => void, started!: () => void, held = false; const pending = new Promise<void>(r => { release = r; }), requested = new Promise<void>(r => { started = r; });
  await page.route(`**/api/projects/${projectA}`, async route => { if (held || route.request().method() !== "GET") return route.fallback(); held = true; started(); await pending; await reply(route, { project: original }); });
  await page.getByRole("link", { name: /Private account A fixture/ }).click(); await requested; await rename(page, "Newer successful save fixture"); await save(page, 2);
  const response = page.waitForResponse(r => r.url().endsWith(`/api/projects/${projectA}`) && r.request().method() === "GET"); release(); await (await response).finished();
  await expectLabel(page, "Newer successful save fixture"); await expectSavedVersion(page, 2); expect(state.projects.get(projectA)?.title).toBe("Newer successful save fixture");
  await rename(page, "Follow-on version three fixture"); await save(page, 3); expect(state.writes.at(-1)?.body.expectedRevision).toBe(2); expect(await browserData(page)).toBeNull();
});

test("account fixture: a confirmed latest-version load keeps conflicted inputs read-only until replacement", async ({ page }) => {
  const original = fixtureProject(), state = await accountFixtures(page, [original]); await openAccount(page); state.patchStatus = 503; await rename(page, "My first unsaved edit"); await expectUnsaved(page);
  state.projects.set(projectA, { ...original, current_revision: 2, title: "Remote latest fixture" }); state.patchStatus = 200;
  await page.getByRole("button", { name: "Retry save", exact: true }).first().click(); await expect(page.locator(".account-conflict")).toContainText("A newer version is saved");
  let release!: () => void, started!: () => void; const pending = new Promise<void>(r => { release = r; }), requested = new Promise<void>(r => { started = r; });
  await page.route(`**/api/projects/${projectA}`, async route => { if (route.request().method() !== "GET") return route.fallback(); started(); await pending; await reply(route, { project: state.projects.get(projectA) }); });
  await page.getByRole("button", { name: "Load latest version", exact: true }).click(); await page.getByRole("button", { name: "Replace with latest version", exact: true }).click(); await requested;
  const editor = await openProjectDetails(page), label = editor.getByRole("textbox", { name: "Project label", exact: true });
  await expect(label).toHaveValue("My first unsaved edit"); await expect(label).toHaveAttribute("readonly", ""); release();
  await expect(label).toHaveValue("Remote latest fixture"); await expect(label).toBeEditable(); await closeProjectDetails(page);
  await rename(page, "New edit after confirmed load"); await save(page, 3); expect(state.writes.at(-1)?.body.expectedRevision).toBe(2); expect(await browserData(page)).toBeNull();
});
for (const status of [404, 503]) {
  test(`account fixture: ${status} during revalidation masks cached data and keeps edits for a successful retry`, async ({ page }) => {
    const state = await accountFixtures(page, [fixtureProject()]); await openAccount(page); state.patchStatus = 503; await rename(page, "Private unsaved revalidation fixture"); await expectUnsaved(page); await openProjects(page);
    let failing = true; await page.route(`**/api/projects/${projectA}`, async route => failing && route.request().method() === "GET" ? reply(route, { error: "Synthetic revalidation failure" }, status) : route.fallback());
    await page.getByRole("link", { name: /Private account A fixture/ }).click(); await expect(page.locator(".project-workspace-content").getByRole("alert")).toContainText(status === 404 ? "not available to this account" : "Account saving is unavailable");
    await expect(page.getByRole("textbox")).toHaveCount(0); await expect(page.getByText("Private unsaved revalidation fixture", { exact: true })).toHaveCount(0); await expect(page.getByText("Unsaved account edits remain in this tab.", { exact: false })).toBeVisible();
    failing = false; state.patchStatus = 200; await page.getByRole("button", { name: "Retry loading project", exact: true }).click(); await expectLabel(page, "Private unsaved revalidation fixture"); await save(page, 2); expect(await browserData(page)).toBeNull();
  });
}
