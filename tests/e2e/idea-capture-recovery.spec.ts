import { expect, test, type Page } from "@playwright/test";
import { captureUiEvidence } from "./ui-evidence";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ideaId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const date = "2026-10-25T10:00:00Z";

// Entirely intercepted account fixtures. No live data, credentials or providers.
async function fixture(page: Page, rejection?: number) {
  const state = { writes: [] as Record<string, unknown>[], forbidden: [] as string[], errors: [] as string[], hold: false };
  let release: (() => void) | undefined;
  let saved: unknown;
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { state.forbidden.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "POST" && url.pathname === "/api/ideas") {
      const body = request.postDataJSON(); state.writes.push(body);
      if (state.hold) await new Promise<void>(resolve => { release = resolve; });
      if (state.writes.length === 1) {
        if (rejection) return route.fulfill({ status: rejection, json: {} });
        saved = { id: ideaId, ownerId, revision: 1, content: body.content, createdAt: date, updatedAt: date, links: [] };
        return route.abort("failed"); // committed creation whose acknowledgement was lost
      }
      saved ??= { id: ideaId, ownerId, revision: 1, content: body.content, createdAt: date, updatedAt: date, links: [] };
      return route.fulfill({ json: { idea: saved } });
    }
    if (request.method() !== "GET") { state.forbidden.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: ownerId } } });
    if (url.pathname === "/api/ideas") return route.fulfill({ json: { ownerId, items: [], nextCursor: null } });
    if (url.pathname === `/api/ideas/${ideaId}`) return route.fulfill({ json: { idea: saved } });
    if (url.pathname === "/api/account/profile") return route.fulfill({ json: { profile: { ownerId, email: null, revision: 0, updatedAt: null, values: { fullName: "", timeZone: "UTC", dateFormat: "iso" } } } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/ideas");
  await expect(page).toHaveTitle(/Embel/);
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Synthetic interrupted idea");
  return { state, release: () => { state.hold = false; release?.(); } };
}

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

test("Ideas capture keeps an uncertain creation intact across closing and reopening", async ({ page }) => {
  const { state } = await fixture(page);
  await page.getByRole("button", { name: "Save idea", exact: true }).click();
  const retry = page.getByRole("button", { name: "Retry saving idea", exact: true });
  await expect(retry).toBeEnabled();
  const title = page.getByRole("textbox", { name: "Idea title", exact: true });
  await expect(title).toHaveAttribute("readonly", "");
  await expect(page.getByRole("textbox", { name: "Description (optional)", exact: true })).toHaveAttribute("readonly", "");
  await title.focus(); await title.press("End"); await title.press("x");
  await expect(title).toHaveValue("Synthetic interrupted idea");
  await page.getByRole("button", { name: "Close capture", exact: true }).click();
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  await expect(title).toHaveAttribute("readonly", "");
  await expect(page.getByText("Retry the pending save before editing. This avoids creating the same idea twice.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: test.info().outputPath("capture-recovery.png"), fullPage: true, scale: "css" });
  await retry.click();
  await expect(page).toHaveURL(new RegExp(`/ideas/${ideaId}$`));
  expect(state.writes).toHaveLength(2); expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.forbidden).toEqual([]); expect(state.errors).toEqual([]);
});

for (const status of [413, 422]) test(`Ideas capture permits correction after a confirmed ${status} rejection`, async ({ page }) => {
  const { state } = await fixture(page, status);
  await page.getByRole("button", { name: "Save idea", exact: true }).click();
  await expect(page.locator(".ideas-capture").getByRole("alert")).toBeVisible();
  const title = page.getByRole("textbox", { name: "Idea title", exact: true });
  await expect(title).toBeEditable(); await title.fill("Corrected synthetic idea");
  await page.getByRole("button", { name: "Save idea", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ideas/${ideaId}$`));
  expect(state.writes).toHaveLength(2); expect(state.writes[1]!.requestKey).not.toBe(state.writes[0]!.requestKey);
  expect(state.writes[1]!.content).toMatchObject({ title: "Corrected synthetic idea" });
  expect(state.forbidden).toEqual([]); expect(state.errors).toEqual([]);
});

test("Ideas capture keeps keyboard focus while retrying and prevents overlapping writes", async ({ page }) => {
  const { state, release } = await fixture(page);
  await page.getByRole("button", { name: "Save idea", exact: true }).click();
  const retry = page.getByRole("button", { name: "Retry saving idea", exact: true });
  await expect(retry).toBeEnabled(); await retry.focus(); state.hold = true; await retry.press("Enter");
  const pending = page.getByRole("button", { name: "Saving idea…", exact: true });
  await expect(pending).toHaveAttribute("aria-disabled", "true");
  await expect(pending).toBeFocused(); await pending.press("Enter");
  expect(state.writes).toHaveLength(2);
  release(); await expect(page).toHaveURL(new RegExp(`/ideas/${ideaId}$`));
  expect(state.writes).toHaveLength(2); expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.forbidden).toEqual([]); expect(state.errors).toEqual([]);
});
