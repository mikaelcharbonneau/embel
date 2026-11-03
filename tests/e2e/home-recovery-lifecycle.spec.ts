import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountProjectSchema } from "../../src/domain/project-api";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const when = "2026-10-08T00:00:00Z";
const availability = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 10000 }] };
const marker = "fluid.prompt-sign-in.v1";
const prompt = "A shared neighborhood workshop for repairing bicycles and learning practical skills.";
const nextPrompt = "A quiet neighborhood kitchen serving seasonal lunches and sharing recipes.";

// All network destinations are intercepted. No credentials, account writes or provider calls.
async function setup(page: Page) {
  const state = { signedIn: false, uncertain: false, holdSession: false, releaseSession: () => {}, creates: [] as Record<string, unknown>[], enqueues: [] as { projectId: string; body: unknown }[] };
  const projects = new Map<string, ReturnType<typeof accountProjectSchema.parse>>();
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/api/session") {
      if (state.holdSession) await new Promise<void>(resolve => { state.releaseSession = resolve; });
      return state.signedIn ? reply({ user: { id: owner } }) : reply({}, 401);
    }
    if (!state.signedIn) return reply({}, 401);
    if (path === "/api/strategy") return reply({ availability });
    if (path === "/api/projects/page") return reply({ ownerId: owner, items: [...projects.values()].map(project => ({ id: project.id, owner_id: project.owner_id, title: project.title, scope: project.scope, current_revision: project.current_revision, created_at: project.created_at })).sort((a, b) => b.id.localeCompare(a.id)), nextCursor: null });
    if (path.endsWith("/capability")) return reply({ ownerId: owner, policy: null, reason: "Synthetic storage unavailable" });
    if (path === "/api/projects" && request.method() === "POST") {
      const body = request.postDataJSON(); state.creates.push(body);
      if (state.uncertain) return reply({}, 503);
      const id = `bbbbbbbb-1111-4111-8111-${String(state.creates.length).padStart(12, "0")}`;
      const project = accountProjectSchema.parse({ ...body, id, owner_id: owner, current_revision: 1, created_at: when });
      projects.set(id, project); return reply({ project }, 201);
    }
    const project = projects.get(path.split("/")[3]!);
    if (project && path.endsWith("/strategy")) {
      const job = { id: `cccccccc-1111-4111-8111-${project.id.slice(-12)}`, owner_id: owner, project_id: project.id, operation: "strategy.reformulate", input_revision: 1, state: "queued", progress: 0, error_code: null, cancel_requested_at: null, created_at: when, finished_at: null, reserved_cost_microusd: 10000, actual_cost_microusd: 0, results: [] };
      if (request.method() === "POST") { state.enqueues.push({ projectId: project.id, body: request.postDataJSON() }); return reply({ job }, 202); }
      return reply({ availability, jobs: [job] });
    }
    if (project && path === `/api/projects/${project.id}`) return reply({ project });
    return reply({}, 404);
  });
  return state;
}
async function capture(page: Page, info: TestInfo, name: string, requests?: unknown) {
  const dir = process.env.FLUID_UI_EVIDENCE ?? info.outputDir;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${info.project.name}-${name}`);
  await page.screenshot({ path: `${file}.png`, fullPage: true, scale: "css" });
  await writeFile(`${file}.json`, JSON.stringify({ requests, state: await page.evaluate(() => ({ prompt: document.querySelector<HTMLTextAreaElement>("textarea")?.value, readOnly: document.querySelector<HTMLTextAreaElement>("textarea")?.readOnly, marker: sessionStorage.getItem("fluid.prompt-sign-in.v1"), drafts: localStorage.getItem("fluid.local-drafts.v1") })) }, null, 2));
}
async function begin(page: Page, entry: "header" | "composer") {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Project scope: Brand", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  if (entry === "header") await page.getByLabel("Account menu", { exact: true }).click();
  const signIn = page.locator(entry === "header" ? ".topbar-account" : ".conversation-start-notice").getByRole("link", { name: "Sign in", exact: true });
  if (entry === "header") { await signIn.focus(); await page.keyboard.press("Enter"); } else await signIn.click();
  await expect(page).toHaveURL(/\/sign-in$/);
}
for (const entry of ["header", "composer"] as const) test(`Home recovery: ${entry} sign-in preserves unsent prompt and scope without requests`, async ({ page }, info) => {
  const state = await setup(page); await begin(page, entry); await page.goBack();
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toBeVisible();
  await capture(page, info, `auth-${entry}-return`, state);
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue(prompt);
  await expect(page.getByRole("button", { name: "Project scope: Name", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toBeEditable();
  expect(state.creates).toHaveLength(0); expect(state.enqueues).toHaveLength(0);
});

test("Home recovery: confirmed start retires the ID and a new prompt creates a distinct request", async ({ page }, info) => {
  const state = await setup(page); await begin(page, "composer");
  state.signedIn = true; await page.goto("/");
  await expect(page.getByRole("button", { name: "Project scope: Name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/account\/bbbbbbbb-1111-4111-8111-000000000001\/naming$/);
  await page.goto("/");
  await capture(page, info, "confirmed-return-home", state);
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(nextPrompt);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await capture(page, info, "second-intended-request", state);
  await expect.poll(() => state.creates.length).toBe(2);
  await expect(page).toHaveURL("/brands/account/bbbbbbbb-1111-4111-8111-000000000002?view=strategy");
  expect(state.creates.map(item => (item.context as { description: string }).description)).toEqual([prompt, nextPrompt]);
  expect(state.enqueues).toEqual([]);
  expect(await page.evaluate(key => sessionStorage.getItem(key), marker)).toBeNull();
});

test("Home recovery: uncertain save stays immutable during sign-in remount and verified recovery", async ({ page }, info) => {
  const state = await setup(page); await begin(page, "composer"); state.signedIn = true; state.uncertain = true; await page.goto("/");
  await expect(page.getByRole("button", { name: "Project scope: Name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText(/Your project could not be confirmed/).first()).toBeVisible();
  const original = await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"));
  state.signedIn = false; await page.reload();
  await page.getByLabel("Account menu", { exact: true }).click();
  await page.locator(".topbar-account").getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  state.signedIn = true; state.holdSession = true; await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue("");
  await capture(page, info, "uncertain-checking-remount", state);
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).not.toBeEditable();
  await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeDisabled();
  state.holdSession = false; state.releaseSession();
  await expect(page.getByText(/earlier save is not confirmed/).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue(prompt);
  await capture(page, info, "uncertain-verified-remount", state);
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).not.toBeEditable();
  await expect(page.getByRole("button", { name: "Project scope: Name", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check and retry save", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start a new prompt", exact: true })).toBeDisabled();
  expect(state.creates).toHaveLength(1); expect(state.enqueues).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe(original);
  expect(await page.evaluate(key => sessionStorage.getItem(key), marker)).not.toBeNull();
});
