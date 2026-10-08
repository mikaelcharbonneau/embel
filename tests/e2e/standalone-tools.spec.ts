import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const fixtureOrigin = `http://127.0.0.1:${process.env.FLUID_E2E_PORT ?? "3105"}`;

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
  await page.route(`${fixtureOrigin}/api/session`, route => route.fulfill({ status: 401, json: { error: "unauthenticated" } }));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname, method: request.method() });
  });
  return async () => {
    await test.info().attach("manual-tool-audit", { body: JSON.stringify({ requests, unexpectedRequests, pageErrors }, null, 2), contentType: "application/json" });
    expect(pageErrors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    expect(requests.every(request => (request.method === "GET" && request.path === "/api/session") || (allowSignOut && request.method === "POST" && request.path === "/api/auth/sign-out"))).toBe(true);
    expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width);
  };
}

test("integrated Domains prepares candidates without checking, purchasing or saving account records", async ({ page }, info) => {
  const verify = await manualWorkspace(page);
  await page.goto("/domains");
  await expect(page.getByRole("heading", { name: "Domain library unavailable", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Prepare a domain search", exact: true }).click();
  await page.getByLabel("Names or full domains", { exact: true }).fill("North Star\nnorthstar.org");
  await page.getByRole("button", { name: "Prepare search", exact: true }).click();
  for (const domain of ["northstar.com", "northstar.co", "northstar.io", "northstar.org"]) {
    await expect(page.getByRole("heading", { name: domain, exact: true })).toBeVisible();
    await expect(page.getByRole("status", { name: `${domain} availability` })).toHaveText("Unknown");
    await expect(page.getByRole("button", { name: `Check availability for ${domain}`, exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: `Create brand from ${domain}`, exact: true })).toBeDisabled();
  }
  await expect(page.getByText("No availability evidence.", { exact: true })).toHaveCount(4);
  await verify();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("domains-manual.png"), fullPage: true });
});

test("integrated Handles keeps independent bundle states in tab memory with checks unavailable", async ({ page }, info) => {
  const verify = await manualWorkspace(page);
  await page.goto("/handles");
  await expect(page.getByText("This tab only. Reopening this page starts a new workspace.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add handles", exact: true }).click();
  await page.getByLabel("Names", { exact: true }).fill("North Star");
  await page.getByRole("button", { name: "Build comparison", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check platforms", exact: true })).toBeDisabled();
  await page.getByLabel("Choose @northstar on instagram for bundle", { exact: true }).check();
  await page.getByLabel("Choose @northstar on youtube for bundle", { exact: true }).check();
  await page.getByRole("button", { name: "Save bundle", exact: true }).click();
  const bundle = page.locator("article.handles-bundle").first();
  await expect(bundle).toBeVisible();
  await bundle.getByRole("button", { name: "Favorite", exact: true }).first().click();
  await expect(bundle.getByRole("button", { name: "Favorited", exact: true })).toHaveCount(1);
  await expect(bundle.getByRole("button", { name: "Select", exact: true })).toHaveCount(2);
  await bundle.getByRole("button", { name: "I created this account", exact: true }).first().click();
  await bundle.getByLabel("Account URL (optional)", { exact: true }).fill("https://www.instagram.com/northstar/");
  await bundle.getByRole("button", { name: "Record my created account", exact: true }).click();
  await expect(bundle.getByText("Account created · user declared", { exact: true })).toBeVisible();
  await expect(bundle.getByText("To check", { exact: true })).toHaveCount(2);
  await verify();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("handles-manual.png"), fullPage: true });
  await page.reload();
  await expect(page.locator("article.handles-bundle")).toHaveCount(0);
});

test("integrated Trademarks downloads an actual manual draft and invalidates review without registry or filing claims", async ({ page }, info) => {
  const verify = await manualWorkspace(page);
  await page.goto("/trademarks");
  await page.getByLabel("Mark name", { exact: true }).fill("North Star fixture");
  await page.getByLabel("Mark type", { exact: true }).selectOption("word");
  await page.getByLabel("Requested territories", { exact: true }).fill("France");
  await page.getByLabel("Goods and services", { exact: true }).fill("User-proposed services, unvalidated.");
  await page.getByLabel("Classification notes", { exact: true }).fill("Questions for later review.");
  await page.getByLabel("Owner name", { exact: true }).fill("Synthetic fixture owner");
  await page.getByLabel("Owner address", { exact: true }).fill("Synthetic fixture address");
  await page.getByLabel("Owner contact", { exact: true }).fill("fixture@example.invalid");
  await page.getByLabel("Supporting document plan", { exact: true }).selectOption("none-planned");
  await page.getByLabel("Your research notes", { exact: true }).fill("Literal private fixture notes <script>ignored</script>");
  await expect(page.getByText("6 of 6 sections filled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByText("Literal private fixture notes <script>ignored</script>", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sourced results", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Draft preview", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export draft preview", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("fluid-trademark-draft-preview.json");
  const filename = info.outputPath("downloaded-draft.json");
  await download.saveAs(filename);
  const saved = JSON.parse(await readFile(filename, "utf8"));
  expect(saved.draft.markName).toBe("North Star fixture");
  expect(saved.draft.owner.name).toBe("Synthetic fixture owner");
  expect(saved.draft.userNotes).toBe("Literal private fixture notes <script>ignored</script>");
  expect(saved.limitations).toContain("No application has been submitted or registered. Official filing requirements remain unvalidated.");
  const review = page.getByRole("checkbox", { name: /^I reviewed these user-entered notes/ });
  await review.check();
  await expect(page.getByText("Reviewed draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit dossier", exact: true }).click();
  await page.getByLabel("Goods and services", { exact: true }).fill("Changed manual services.");
  await page.getByRole("button", { name: "Review draft preview", exact: true }).click();
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
    await page.route(`${fixtureOrigin}/api/projects/page?*`, route => {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({ json: { ownerId: owner, items: [], nextCursor: null } });
    });
    await page.route(`${fixtureOrigin}/api/workspaces/${tool}`, route => {
      if (!owner) return route.fulfill({ status: 401, json: { error: "unauthenticated" } });
      if (route.request().method() === "GET") return route.fulfill({ json: { ownerId: owner, workspace: saved.get(owner) ?? null } });
      expect(route.request().method()).toBe("PUT");
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
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    const field = () => page.getByRole("textbox", { name: tool === "domains" ? "Names or full domains" : tool === "handles" ? "Names" : "Mark name", exact: true });
    const edit = async (label: string, handleName: string) => {
      if (tool !== "handles") { await field().fill(label); return; }
      await page.getByRole("tab", { name: "Search", exact: true }).click();
      await field().fill(handleName);
      await page.getByRole("button", { name: "Build comparison", exact: true }).click();
      await page.getByLabel(`Choose @${handleName.toLowerCase()} on instagram for bundle`, { exact: true }).check();
      await page.getByLabel("Bundle name", { exact: true }).fill(label);
      await page.getByRole("button", { name: "Save bundle", exact: true }).click();
    };
    const hasDraft = async (label: string) => {
      if (tool === "handles") await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
      else await expect(field()).toHaveValue(label);
    };
    const fresh = async () => {
      if (tool === "handles") await expect(page.locator("article.handles-bundle")).toHaveCount(0);
      else {
        if (tool === "domains" && await page.getByRole("button", { name: "Prepare a domain search", exact: true }).count()) await page.getByRole("button", { name: "Prepare a domain search", exact: true }).click();
        await expect(field()).toHaveValue("");
      }
    };
    const checkAccount = async () => {
      const response = page.waitForResponse(`${fixtureOrigin}/api/session`);
      await page.getByRole("button", { name: "Check account", exact: true }).click();
      await (await response).finished();
      await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    };
    const savedLabel = "Owner A saved draft fixture", dirtyLabel = "Owner A unsaved recovery fixture";
    await edit(savedLabel, "NorthstarSaved");
    const saving = page.waitForResponse(response => response.url() === `${fixtureOrigin}/api/workspaces/${tool}` && response.request().method() === "PUT");
    await page.getByRole("button", { name: tool === "domains" ? "Save draft" : "Save account draft", exact: true }).click();
    await (await saving).finished();
    await expect(page.getByText(tool === "domains" ? "Saved to account · version 1" : tool === "handles" ? "Account draft saved · revision 1. Unfinished comparisons are temporary." : "Account draft saved · revision 1. Review marks only your user-entered notes.", { exact: true })).toBeVisible();
    await edit(dirtyLabel, "NorthstarDirty");
    // The provider must hide private drafts while retaining their owner buffer.
    let releaseRefresh!: () => void;
    pendingRefresh = new Promise(resolve => { releaseRefresh = resolve; });
    const settled = page.waitForResponse(`${fixtureOrigin}/api/session`);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("button", { name: "Checking account…", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Saved project for import", { exact: true })).toHaveCount(0);
    await fresh();
    expect(await page.locator("input,textarea").evaluateAll(fields => fields.map(field => (field as HTMLInputElement).value))).not.toContain(dirtyLabel);
    releaseRefresh(); await (await settled).finished(); pendingRefresh = undefined;
    await hasDraft(dirtyLabel);
    owner = null;
    const expired = page.waitForResponse(`${fixtureOrigin}/api/session`);
    await page.getByRole("button", { name: "Check account", exact: true }).click(); await (await expired).finished();
    await expect(page.locator(".topbar").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await fresh(); owner = ownerA; await checkAccount(); await hasDraft(dirtyLabel);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out with unsaved account edits?", exact: true });
    await expect(dialog).toBeVisible();
    expect(signOutRequests).toBe(0);
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    await hasDraft(dirtyLabel);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Sign-out couldn't be confirmed" })).toBeVisible();
    await fresh(); await checkAccount(); await hasDraft(dirtyLabel);
    expect(signOutRequests).toBe(1);
    owner = ownerB; await checkAccount(); await fresh();
    await edit("Owner B unsaved logout fixture", "NorthstarB");
    signOutStatus = 200;
    const signedOut = page.waitForResponse(`${fixtureOrigin}/api/auth/sign-out`);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
    await (await signedOut).finished();
    await expect(page.locator(".topbar").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await fresh(); owner = ownerB; await checkAccount(); await fresh();
    owner = ownerA; await checkAccount(); await hasDraft(savedLabel);
    if (tool === "handles") await expect(page.getByRole("heading", { name: dirtyLabel, exact: true })).toHaveCount(0);
    expect(signOutRequests).toBe(2);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("Owner A");
    expect(pageErrors).toEqual([]); expect(unexpectedRequests).toEqual([]);
    expect(requests.every(request => request.method === "GET" && ["/api/session", "/api/projects/page", `/api/workspaces/${tool}`].includes(request.path)
      || request.method === "PUT" && request.path === `/api/workspaces/${tool}` || request.method === "POST" && request.path === "/api/auth/sign-out")).toBe(true);
    await test.info().attach("account-tool-audit", { body: JSON.stringify({ requests, unexpectedRequests, pageErrors }, null, 2), contentType: "application/json" });
    expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
}
