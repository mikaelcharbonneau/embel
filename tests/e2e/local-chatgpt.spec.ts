import { expect, test, type Page, type Route } from "@playwright/test";
import type { LocalChatGPTStatus } from "../../src/domain/local-chatgpt";

// Local UI fixtures only. All authentication, catalog and connection responses are intercepted.
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const otherOwner = "bbbbbbbb-1111-4111-8111-111111111111";
const registrationId = "local_fixture_registration";
const localRuntime = process.env.FLUID_RUNTIME === "local";
async function reply(route: Route, value: unknown, status = 200) { await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) }); }
async function fixtures(page: Page) {
  const state = {
    owner, sessionStatus: 200, calls: [] as { action: string; method: string; body: unknown }[],
    status: { connectionAllowed: false, registrations: [], selectedRegistrationId: null, model: null, workerReady: false, images: { status: "unavailable", reason: "spending_limit_required" } } as LocalChatGPTStatus,
    modelsRegistrationId: registrationId,
  };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return reply(route, { user: { id: state.owner } }, state.sessionStatus);
    if (!path.startsWith("/api/local/chatgpt/")) return reply(route, {}, 404);
    const action = path.split("/").at(-1)!;
    const body = request.method() === "GET" ? undefined : request.postDataJSON();
    state.calls.push({ action, method: request.method(), body });
    if (state.owner !== owner) return reply(route, { ...state.status, registrations: [], selectedRegistrationId: null, model: null, workerReady: false });
    if (action === "status") return reply(route, state.status);
    if (action === "models") return reply(route, { registrationId: state.modelsRegistrationId, models: [{ slug: "fixture-catalog-model", displayName: "Synthetic catalog model" }] });
    if (action === "select-model") {
      state.status = { ...state.status, selectedRegistrationId: body.registrationId, model: body.model, workerReady: true };
      return reply(route, state.status);
    }
    if (action === "sign-in") return reply(route, { authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=synthetic-ui-fixture" });
    if (action === "sign-out") {
      state.status = { ...state.status, registrations: [], selectedRegistrationId: null, model: null, workerReady: false };
      return reply(route, { disconnected: true, remoteRevocationConfirmed: false });
    }
    return reply(route, {}, 404);
  });
  return state;
}

test("hosted settings keep the local ChatGPT connection panel and endpoints absent", async ({ page }) => {
  test.skip(localRuntime, "The local-runtime run exercises the local panel separately.");
  const state = await fixtures(page); await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ChatGPT on this Mac", exact: true })).toHaveCount(0);
  expect(state.calls).toEqual([]);
});

test.describe("local ChatGPT settings", () => {
  test.skip(!localRuntime, "Requires the explicit local runtime; all APIs are intercepted synthetic fixtures.");
  test("keeps connection approval closed and images unavailable without performing OAuth", async ({ page }) => {
    const state = await fixtures(page);
    state.status.registrations = [{ registrationId, email: "local-fixture@example.invalid", planUsageEnabled: true }];
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "ChatGPT on this Mac", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toBeDisabled();
    await expect(page.getByText("Connection approval is required before ChatGPT sign-in can open.", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "ChatGPT connection", exact: true }).selectOption(registrationId);
    await expect(page.getByRole("button", { name: "Load available models", exact: true })).toBeDisabled();
    await expect(page.getByText("Image generation is unavailable. An approved spending limit is required.", { exact: true })).toBeVisible();
    expect(state.calls.every(call => call.action === "status" && call.method === "GET")).toBe(true);
  });
  test("requires a verified Fluid account before reading local connection metadata", async ({ page }) => {
    const state = await fixtures(page); state.sessionStatus = 401;
    await page.goto("/settings");
    await expect(page.getByText("Sign in to Fluid first", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toHaveCount(0);
    expect(state.calls).toEqual([]);
  });
  test("loads the actual model catalog and changes selection only after explicit Save", async ({ page }, testInfo) => {
    const state = await fixtures(page);
    state.status.connectionAllowed = true; state.status.registrations = [{ registrationId, email: "local-fixture@example.invalid", planUsageEnabled: true }];
    await page.goto("/settings");
    await page.getByRole("combobox", { name: "ChatGPT connection", exact: true }).selectOption(registrationId);
    expect(state.calls.filter(call => call.method === "POST")).toEqual([]);
    await page.getByRole("button", { name: "Load available models", exact: true }).click();
    await page.getByRole("combobox", { name: "Text model", exact: true }).selectOption("fixture-catalog-model");
    expect(state.status.model).toBeNull();
    await page.getByRole("button", { name: "Save text connection", exact: true }).click();
    await expect(page.getByText("Ready for text requests", { exact: true })).toBeVisible();
    expect(state.calls.find(call => call.action === "select-model")?.body).toEqual({ registrationId, model: "fixture-catalog-model" });
    await expect(page.getByText("A verified account session is connected. Open Brands to view saved account projects.", { exact: true })).toBeVisible();
    await expect(page.getByText(registrationId, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("local-chatgpt-settings.png"), fullPage: true, scale: "css" });
  });
  test("does not accept a model catalog for another connection", async ({ page }) => {
    const state = await fixtures(page); state.status.connectionAllowed = true; state.status.registrations = [{ registrationId, email: "local-fixture@example.invalid", planUsageEnabled: true }]; state.modelsRegistrationId = "different_registration";
    await page.goto("/settings");
    await page.getByRole("combobox", { name: "ChatGPT connection", exact: true }).selectOption(registrationId);
    await page.getByRole("button", { name: "Load available models", exact: true }).click();
    await expect(page.getByText("The local connection response could not be verified.", { exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Synthetic catalog model", exact: true })).toHaveCount(0);
    expect(state.calls.filter(call => call.action === "select-model")).toEqual([]);
  });
  test("opens the approved authorization destination only after Continue with ChatGPT is clicked", async ({ page }) => {
    const state = await fixtures(page); state.status.connectionAllowed = true;
    await page.route("https://auth.openai.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<p>Synthetic consent page. No grant was performed.</p>" }));
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toBeEnabled();
    expect(state.calls.filter(call => call.action === "sign-in")).toEqual([]);
    await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    await expect(page).toHaveURL(/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/);
    expect(state.calls.find(call => call.action === "sign-in")?.body).toEqual({});
  });
  test("disconnects ChatGPT without claiming remote revocation or signing out of Fluid", async ({ page }) => {
    const state = await fixtures(page); state.status.connectionAllowed = true; state.status.registrations = [{ registrationId, email: "local-fixture@example.invalid", planUsageEnabled: true }]; state.status.selectedRegistrationId = registrationId; state.status.model = "fixture-catalog-model";
    await page.goto("/settings");
    await page.getByRole("button", { name: "Disconnect ChatGPT", exact: true }).click();
    await expect(page.getByText("Disconnected from Fluid on this Mac. Remote revocation could not be confirmed.", { exact: true })).toBeVisible();
    await expect(page.getByText("A verified account session is connected. Open Brands to view saved account projects.", { exact: true })).toBeVisible();
    expect(state.calls.find(call => call.action === "sign-out")?.body).toEqual({ registrationId });
  });
  test("fences a late catalog response when the Fluid account changes", async ({ page }) => {
    const state = await fixtures(page); state.status.connectionAllowed = true; state.status.registrations = [{ registrationId, email: "private-local-fixture@example.invalid", planUsageEnabled: true }];
    let release!: () => void; let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const requested = new Promise<void>(resolve => { started = resolve; });
    await page.route("**/api/local/chatgpt/models", async route => { started(); await held; await reply(route, { registrationId, models: [{ slug: "private-model", displayName: "Private previous-account model" }] }); });
    await page.goto("/settings");
    await page.getByRole("combobox", { name: "ChatGPT connection", exact: true }).selectOption(registrationId);
    await page.getByRole("button", { name: "Load available models", exact: true }).click(); await requested;
    state.owner = otherOwner;
    await page.getByRole("button", { name: "Check account", exact: true }).click();
    await expect(page.getByText("Choose a ChatGPT connection for text requests.", { exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("option", { name: "Private previous-account model", exact: true })).toHaveCount(0);
    await expect(page.getByText("private-local-fixture@example.invalid", { exact: true })).toHaveCount(0);
  });
});
