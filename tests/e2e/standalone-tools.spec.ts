import { captureUiEvidence } from "./ui-evidence";
import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";

const fixtureOrigin = `http://127.0.0.1:${process.env.FLUID_E2E_PORT ?? "3105"}`;

async function accountProfileRead(page: Page, currentOwner: () => string | null) {
  await page.route(`${fixtureOrigin}/api/account/profile`, route => {
    expect(route.request().method()).toBe("GET");
    const ownerId = currentOwner();
    if (!ownerId) return route.fulfill({ status: 401, json: { error: "unauthenticated" } });
    return route.fulfill({ json: { profile: { ownerId, email: null, revision: 0, updatedAt: null,
      values: { fullName: "", timeZone: "America/Toronto", dateFormat: "friendly" } } } });
  });
}

// Secondary controls open as modal sheets titled by their trigger.
async function openSheet(page: Page, title: string) {
  await page.getByRole("button", { name: title, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: title, exact: true });
  await expect(sheet).toBeVisible(); return sheet;
}
async function closeSheet(sheet: Locator) { await sheet.getByRole("button", { name: "Close", exact: true }).click(); await expect(sheet).toBeHidden(); }

async function manualWorkspace(page: Page, allowSignOut = false) {
  const requests: { path: string; method: string }[] = [];
  const unexpectedRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  // Specific synthetic account routes below override this deny-by-default guard.
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === fixtureOrigin && !url.pathname.startsWith("/api/")) return route.continue();
    unexpectedRequests.push(`${route.request().method()} ${url.href}`);
    return route.abort();
  });
  const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
  const saved = new Map<string, unknown>();
  await page.route(`${fixtureOrigin}/api/session`, route => route.fulfill({ json: { user: { id: ownerId } } }));
  await accountProfileRead(page, () => ownerId);
  await page.route(`${fixtureOrigin}/api/names/workspace`, route => route.fulfill({ json: { ownerId, workspace: null } }));
  await page.route(`${fixtureOrigin}/api/projects/page?*`, route => route.fulfill({ json: { ownerId, items: [], nextCursor: null } }));
  await page.route(`${fixtureOrigin}/api/standalone-checks`, route => route.fulfill({ json: { ownerId, domains: "unavailable", youtube: false, euipo: false } }));
  await page.route(/\/api\/workspaces\/(domains|handles|trademarks)$/, route => {
    const tool = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      saved.set(tool, { id: "cccccccc-1111-4111-8111-111111111111", ownerId, tool, revision: input.expectedRevision + 1, payload: input.payload, imports: [], createdAt: "2026-10-15T10:00:00Z", updatedAt: "2026-10-15T10:00:00Z" });
    }
    return route.fulfill({ json: { ownerId, workspace: saved.get(tool) ?? null } });
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname, method: request.method() });
  });
  return async () => {
    await test.info().attach("manual-tool-audit", { body: JSON.stringify({ requests, unexpectedRequests, pageErrors }, null, 2), contentType: "application/json" });
    expect(pageErrors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    expect(requests.every(request => (request.method === "GET" && ["/api/session", "/api/account/profile", "/api/names/workspace", "/api/projects/page", "/api/standalone-checks", "/api/workspaces/domains", "/api/workspaces/handles", "/api/workspaces/trademarks"].includes(request.path)) || (request.method === "PUT" && /^\/api\/workspaces\/(domains|handles|trademarks)$/.test(request.path)) || (allowSignOut && request.method === "POST" && request.path === "/api/auth/sign-out"))).toBe(true);
    expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width);
  };
}

test("integrated Domains autosaves candidates without checking availability or purchasing", async ({ page }, info) => {
  const verify = await manualWorkspace(page);
  await page.goto("/domains");
  await expect(page.getByRole("heading", { name: "A home for your brand.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Domain library unavailable", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Prepare a domain search", exact: true }).click();
  await page.getByLabel("Names or full domains", { exact: true }).fill("North Star,northstar.org");
  await page.getByRole("button", { name: "Search domains", exact: true }).click();
  for (const domain of ["northstar.com", "northstar.co", "northstar.io", "northstar.org"]) {
    await expect(page.getByRole("heading", { name: domain, exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: `${domain} availability` })).toHaveText("Unknown");
    await page.getByRole("button", { name: `View ${domain} details`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Check availability for ${domain}`, exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: `Create brand from ${domain}`, exact: true })).toBeEnabled();
  }
  await expect(page.getByText("No availability evidence.", { exact: true })).toHaveCount(4);
  await page.getByRole("checkbox", { name: "Select northstar.com", exact: true }).check();
  const actions = await openSheet(page, "Result actions · 1 selected");
  await expect(actions.getByRole("button", { name: "Check selected domains", exact: true })).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await actions.getByRole("button", { name: "Export CSV", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("embel-domain-candidates.csv");
  await closeSheet(actions);
  await verify();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("domains-manual.png"), fullPage: true });
});

test("account Domains imports a selected saved name through the new library action", async ({ page }) => {
  const owner = "aaaaaaaa-1111-4111-8111-111111111111", projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const source = { projectId, projectRevision: 3, projectTitle: "Synthetic name source", name: "Cedar", selectionId: null, candidateId: null, origin: "project_name" };
  const requests: string[] = [], failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === fixtureOrigin && !url.pathname.startsWith("/api/")) return route.continue();
    failures.push(`${route.request().method()} ${url.origin}${url.pathname}`); return route.abort();
  });
  await page.route(`${fixtureOrigin}/api/session`, route => route.fulfill({ json: { user: { id: owner } } }));
  await accountProfileRead(page, () => owner);
  let domainWorkspace: unknown = null;
  await page.route(`${fixtureOrigin}/api/names/workspace`, route => route.fulfill({ json: { ownerId: owner, workspace: null } }));
  await page.route(`${fixtureOrigin}/api/standalone-checks`, route => route.fulfill({ json: { ownerId: owner, domains: "unavailable", youtube: false, euipo: false } }));
  await page.route(`${fixtureOrigin}/api/workspaces/domains`, route => {
    requests.push(route.request().method());
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      expect(input.imports).toEqual([{ projectId, projectRevision: 3, selectionId: null }]);
      domainWorkspace = { id: "cccccccc-1111-4111-8111-111111111111", ownerId: owner, tool: "domains", revision: input.expectedRevision + 1, payload: input.payload, imports: [source], createdAt: "2026-10-15T10:00:00Z", updatedAt: "2026-10-15T10:00:00Z" };
    }
    return route.fulfill({ json: { ownerId: owner, workspace: domainWorkspace } });
  });
  await page.route(`${fixtureOrigin}/api/projects/page?*`, route => {
    requests.push("project listing");
    return route.fulfill({ json: { ownerId: owner, items: [{ id: projectId, owner_id: owner, title: source.projectTitle, scope: "naming_only", current_revision: 3, created_at: "2026-10-06T10:00:00Z", deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0 }], nextCursor: null } });
  });
  await page.route(`${fixtureOrigin}/api/workspaces/imports?*`, route => {
    expect(new URL(route.request().url()).searchParams.get("projectId")).toBe(projectId);
    requests.push("import"); return route.fulfill({ json: { ownerId: owner, source } });
  });
  await page.goto("/domains");
  await expect(page.getByRole("button", { name: "From name library", exact: true })).toBeEnabled();
  expect(requests).not.toContain("project listing");
  await page.getByRole("button", { name: "From name library", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Name library", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Saved project for import", { exact: true }).selectOption(projectId);
  expect(requests).not.toContain("import");
  await dialog.getByRole("button", { name: "Import saved name", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Remove name Cedar", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Imported saved sources (1)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Search domains", exact: true }).click();
  await expect(page.getByRole("heading", { name: "cedar.com", exact: true })).toBeVisible();
  expect(requests.filter(value => value === "import")).toHaveLength(1);
  await expect(page.getByLabel("Save status", { exact: true })).toHaveText("Saved");
  expect(requests).toContain("PUT"); expect(failures).toEqual([]);
});

test("integrated Handles autosaves independent bundle states with checks unavailable", async ({ page }, info) => {
  const verify = await manualWorkspace(page);
  await page.goto("/handles");
  await expect(page.getByText("Your library saves to your account automatically.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByLabel("Business handles", { exact: true }).fill("North Star");
  await page.getByRole("button", { name: "Build comparison", exact: true }).click();
  await expect(page.getByRole("region", { name: "Handles results" }).getByLabel("Availability filters", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh results", exact: true })).toHaveCount(0);
  await page.getByLabel("Choose @northstar on instagram for bundle", { exact: true }).check();
  await page.getByLabel("Choose @northstar on youtube for bundle", { exact: true }).check();
  await page.getByRole("button", { name: "Save bundle", exact: true }).click();
  const bundle = page.locator("article.handles-bundle").first();
  await expect(bundle).toBeVisible();
  await bundle.getByRole("button", { name: "Favorite", exact: true }).first().click();
  await expect(bundle.getByRole("button", { name: "Favorited", exact: true })).toHaveCount(1);
  await expect(bundle.getByRole("button", { name: "Select", exact: true })).toHaveCount(2);
  await bundle.getByRole("button", { name: "I created this account", exact: true }).first().click();
  await bundle.getByLabel("Account link (optional)", { exact: true }).fill("https://www.instagram.com/northstar/");
  await bundle.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bundle.getByText("You created this account", { exact: true })).toBeVisible();
  await expect(bundle.getByText("To check", { exact: true })).toHaveCount(2);
  await verify();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("handles-manual.png"), fullPage: true });
  await expect(page.getByLabel("Save status", { exact: true })).toHaveText("Saved");
  await page.reload();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(page.locator("article.handles-bundle")).toHaveCount(1);
  await expect(bundle.getByText("You created this account", { exact: true })).toBeVisible();
});

test("integrated Trademarks downloads an actual manual draft and invalidates review without registry or filing claims", async ({ page }, info) => {
  const verify = await manualWorkspace(page);
  await page.goto("/trademarks");
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByLabel("Mark name", { exact: true }).fill("North Star fixture");
  await page.getByLabel("Requested territories", { exact: true }).fill("France");
  await page.getByLabel("Goods and services", { exact: true }).fill("User-proposed services, unvalidated.");
  await page.getByLabel("Owner name", { exact: true }).fill("Synthetic fixture owner");
  await page.getByLabel("Owner address", { exact: true }).fill("Synthetic fixture address");
  const details = await openSheet(page, "More details");
  await details.getByLabel("Mark type", { exact: true }).selectOption("word");
  await details.getByLabel("Classification notes", { exact: true }).fill("Questions for later review.");
  await details.getByLabel("Owner contact", { exact: true }).fill("fixture@example.invalid");
  await details.getByLabel("Supporting document plan", { exact: true }).selectOption("none-planned");
  await details.getByLabel("Your research notes", { exact: true }).fill("Literal private fixture notes <script>ignored</script>");
  await closeSheet(details);
  await expect(page.getByText("6 of 6 sections filled", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Search brief", exact: true })).toBeVisible();
  const research = await openSheet(page, "Your research notes");
  await expect(research.getByText("Literal private fixture notes <script>ignored</script>", { exact: true })).toBeVisible();
  await closeSheet(research);
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft preview", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("embel-trademark-draft-preview.json");
  const filename = info.outputPath("downloaded-draft.json");
  await download.saveAs(filename);
  const saved = JSON.parse(await readFile(filename, "utf8"));
  expect(saved.draft.markName).toBe("North Star fixture");
  expect(saved.draft.owner.name).toBe("Synthetic fixture owner");
  expect(saved.draft.userNotes).toBe("Literal private fixture notes <script>ignored</script>");
  expect(saved.limitations).toContain("No application has been submitted or registered. Official filing requirements remain unvalidated.");
  const review = page.getByRole("checkbox", { name: /^I’ve reviewed these notes/ });
  await review.check();
  await expect(page.getByText("Reviewed draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  await page.getByLabel("Goods and services", { exact: true }).fill("Changed manual services.");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(review).not.toBeChecked();
  expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain("Synthetic fixture owner");
  await verify();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("trademarks-manual.png"), fullPage: true });
});

// Verified account mode now persists reviewed user drafts. These fixtures exercise
// the real session provider and account editors, with every private API intercepted.
for (const tool of ["domains", "handles", "trademarks"] as const) {
  test(`account ${tool} retains owner drafts, hides checking content and confirms unsaved logout`, async ({ page }) => {
    const ownerA = "aaaaaaaa-1111-4111-8111-111111111111";
    const ownerB = "dddddddd-1111-4111-8111-111111111111";
    let owner: string | null = ownerA;
    let pendingRefresh: Promise<void> | undefined;
    let signOutStatus = 503;
    let failWrites = false;
    let signOutRequests = 0;
    const pageErrors: string[] = [], unexpectedRequests: string[] = [];
    const requests: { path: string; method: string }[] = [];
    const saved = new Map<string, { id: string; ownerId: string; tool: string; revision: number; payload: unknown; imports: []; createdAt: string; updatedAt: string }>();
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname, method: request.method() }); });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === fixtureOrigin && !url.pathname.startsWith("/api/")) return route.continue();
      unexpectedRequests.push(`${route.request().method()} ${url.href}`);
      return route.abort();
    });
    await page.route(`${fixtureOrigin}/api/session`, async route => {
      const respondingOwner = owner;
      await pendingRefresh;
      return respondingOwner ? route.fulfill({ json: { user: { id: respondingOwner } } }) : route.fulfill({ status: 401, json: { error: "unauthenticated" } });
    });
    await accountProfileRead(page, () => owner);
    await page.route(`${fixtureOrigin}/api/projects/page?*`, route => {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({ json: { ownerId: owner, items: [], nextCursor: null } });
    });
    await page.route(`${fixtureOrigin}/api/names/workspace`, route => route.fulfill({ json: { ownerId: owner, workspace: null } }));
    await page.route(`${fixtureOrigin}/api/standalone-checks`, route => route.fulfill({ json: { ownerId: owner, domains: "unavailable", youtube: false, euipo: false } }));
    await page.route(`${fixtureOrigin}/api/workspaces/${tool}`, route => {
      if (!owner) return route.fulfill({ status: 401, json: { error: "unauthenticated" } });
      if (route.request().method() === "GET") return route.fulfill({ json: { ownerId: owner, workspace: saved.get(owner) ?? null } });
      expect(route.request().method()).toBe("PUT");
      if (failWrites) return route.fulfill({ status: 503, json: { error: "Synthetic write failure" } });
      const input = route.request().postDataJSON() as { requestKey: string; expectedRevision: number; payload: unknown; imports: [] };
      expect(Object.keys(input).sort()).toEqual(["expectedRevision", "imports", "payload", "requestKey"]);
      expect(input.imports).toEqual([]);
      expect(input.expectedRevision).toBe(saved.get(owner)?.revision ?? 0);
      const workspace = { id: "cccccccc-1111-4111-8111-111111111111", ownerId: owner, tool, revision: input.expectedRevision + 1,
        payload: input.payload, imports: input.imports, createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z" };
      saved.set(owner, workspace);
      return route.fulfill({ json: { ownerId: owner, workspace } });
    });
    await page.route(`${fixtureOrigin}/api/auth/sign-out`, route => {
      expect(route.request().method()).toBe("POST");
      signOutRequests += 1;
      if (signOutStatus !== 200) return route.fulfill({ status: signOutStatus, json: { error: "synthetic unavailable" } });
      owner = null;
      return route.fulfill({ json: { authenticated: false } });
    });
    await page.goto(`/${tool}`);
    const openAccountMenu = async () => {
      if (await page.locator(".workspace-account-menu").getAttribute("open") === null) await page.getByLabel("Account menu", { exact: true }).click();
    };
    const accountPanel = page.locator(".workspace-account-panel");
    // The open account panel can cover page controls on small screens.
    const closeAccountMenu = async () => {
      if (await page.locator(".workspace-account-menu").getAttribute("open") !== null) await page.keyboard.press("Escape");
      await expect(accountPanel).toBeHidden();
    };
    await openAccountMenu();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    const field = () => page.getByRole("textbox", { name: tool === "domains" ? "Names or full domains" : tool === "handles" ? "Business handles" : "Mark name", exact: true });
    const edit = async (label: string, handleName: string) => {
      await closeAccountMenu();
      if (tool !== "handles") {
        if (tool === "domains") {
          const removals = page.locator("[data-domain-entry] button");
          while (await removals.count()) await removals.first().click();
        }
        await field().fill(label); return;
      }
      await page.getByRole("tab", { name: "Search", exact: true }).click();
      const editSearch = page.getByRole("button", { name: "Edit search", exact: true });
      if (await editSearch.count()) await editSearch.click();
      const removals = page.locator(".handles-search-form .handles-name-token button");
      while (await removals.count()) await removals.first().click();
      await field().fill(handleName);
      await page.getByRole("button", { name: "Build comparison", exact: true }).click();
      await page.getByLabel(`Choose @${handleName.toLowerCase()} on instagram for bundle`, { exact: true }).check();
      await page.getByLabel("Bundle name", { exact: true }).fill(label);
      await page.getByRole("button", { name: "Save bundle", exact: true }).click();
    };
    const hasDraft = async (label: string) => {
      await closeAccountMenu();
      if (tool === "handles") {
        await page.getByRole("tab", { name: "Library", exact: true }).click();
        await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
      }
      else if (tool === "domains") await expect.poll(async () => {
        const chips = await page.locator("[data-domain-entry]").evaluateAll(elements => elements.map(element => element.getAttribute("data-domain-entry")));
        const pending = await field().inputValue();
        return [...chips, ...(pending ? [pending] : [])].join("\n");
      }).toBe(label);
      else await expect(field()).toHaveValue(label);
    };
    const fresh = async () => {
      await closeAccountMenu();
      if (!await field().count() && !await page.getByRole("tab", { name: "Library", exact: true }).count()) {
        await expect(field()).toHaveCount(0); return;
      }
      if (tool === "handles") {
        await page.getByRole("tab", { name: "Library", exact: true }).click();
        await expect(page.locator("article.handles-bundle")).toHaveCount(0);
      }
      else {
        if (tool === "domains" && await page.getByRole("button", { name: "Prepare a domain search", exact: true }).count()) await page.getByRole("button", { name: "Prepare a domain search", exact: true }).click();
        if (tool === "domains") await expect(page.locator("[data-domain-entry]")).toHaveCount(0);
        await expect(field()).toHaveValue("");
      }
    };
    const checkAccount = async () => {
      await openAccountMenu();
      const response = page.waitForResponse(`${fixtureOrigin}/api/session`);
      await accountPanel.getByRole("button", { name: "Check account", exact: true }).click();
      await (await response).finished();
      await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    };
    const savedLabel = "Owner A saved draft fixture", dirtyLabel = "Owner A unsaved recovery fixture";
    await edit(savedLabel, "NorthstarSaved");
    await expect(page.getByLabel("Save status", { exact: true })).toHaveText("Saved");
    await page.reload(); await openAccountMenu(); await hasDraft(savedLabel);
    failWrites = true;
    await edit(dirtyLabel, "NorthstarDirty");
    // The provider must hide private drafts while retaining their owner buffer.
    let releaseRefresh!: () => void;
    pendingRefresh = new Promise(resolve => { releaseRefresh = resolve; });
    const settled = page.waitForResponse(`${fixtureOrigin}/api/session`);
    // Routine focus revalidation keeps a verified workspace (11eae67); an explicit check still fences it.
    await openAccountMenu();
    await accountPanel.getByRole("button", { name: "Check account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Checking account…", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Saved project for import", { exact: true })).toHaveCount(0);
    await fresh();
    expect(await page.locator("input,textarea").evaluateAll(fields => fields.map(field => (field as HTMLInputElement).value))).not.toContain(dirtyLabel);
    releaseRefresh(); await (await settled).finished(); pendingRefresh = undefined;
    await hasDraft(dirtyLabel);
    owner = null;
    const expired = page.waitForResponse(`${fixtureOrigin}/api/session`);
    await openAccountMenu(); await accountPanel.getByRole("button", { name: "Check account", exact: true }).click(); await (await expired).finished();
    await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await fresh(); owner = ownerA; await checkAccount(); await hasDraft(dirtyLabel);
    await openAccountMenu(); await accountPanel.getByRole("button", { name: "Sign out", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out with unsaved account edits?", exact: true });
    await expect(dialog).toBeVisible();
    expect(signOutRequests).toBe(0);
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    await hasDraft(dirtyLabel);
    await openAccountMenu(); await accountPanel.getByRole("button", { name: "Sign out", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Sign-out couldn't be confirmed" })).toBeVisible();
    await fresh(); await checkAccount(); await hasDraft(dirtyLabel);
    expect(signOutRequests).toBe(1);
    owner = ownerB; await checkAccount(); await fresh();
    await edit("Owner B unsaved logout fixture", "NorthstarB");
    signOutStatus = 200;
    const signedOut = page.waitForResponse(`${fixtureOrigin}/api/auth/sign-out`);
    await openAccountMenu(); await accountPanel.getByRole("button", { name: "Sign out", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
    await (await signedOut).finished();
    await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await fresh(); owner = ownerB; await checkAccount(); await fresh();
    owner = ownerA; await checkAccount(); await hasDraft(savedLabel);
    if (tool === "handles") await expect(page.getByRole("heading", { name: dirtyLabel, exact: true })).toHaveCount(0);
    expect(signOutRequests).toBe(2);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("Owner A");
    expect(pageErrors).toEqual([]); expect(unexpectedRequests).toEqual([]);
    expect(requests.every(request => request.method === "GET" && ["/api/session", "/api/account/profile", "/api/names/workspace", "/api/standalone-checks", "/api/projects/page", `/api/workspaces/${tool}`].includes(request.path)
      || request.method === "PUT" && request.path === `/api/workspaces/${tool}` || request.method === "POST" && request.path === "/api/auth/sign-out")).toBe(true);
    await test.info().attach("account-tool-audit", { body: JSON.stringify({ requests, unexpectedRequests, pageErrors }, null, 2), contentType: "application/json" });
    expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
}

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
